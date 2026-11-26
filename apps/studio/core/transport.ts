import { workspaceCapabilities, type MergeChoices, type WorkspaceControl } from '../shared/workspace.js';
import { requireWorkspaceConfirmation } from '../shared/workspace-confirmation.js';
import { saveCapabilities } from './save.js';
import { ContentService } from './content-service.js';
import { createSummaryRuntime, requireSummaryRuntime, type SummaryRuntime } from './summary-runtime.js';
import type { SummaryIndexStore } from './summary-index.js';
import { TranslationService } from './translation.js';
import { StudioError } from './errors.js';
import { readUploadBody } from './media-validation.js';
import type { Repository } from '../shared/repository.js';
import type { TranslationRequest } from '../shared/translation.js';
import type { Identity } from '../shared/types.js';
import { settingsSchemas } from '../shared/settings.js';
import type { NativeAiGateway } from '../shared/native-ai.js';
import type { AiTextRequest } from '../shared/ai.js';
import { MAX_UPLOAD_SIZE } from '../shared/media.js';
import { applyThemeUpdate, checkThemeUpdate } from './theme-update.js';

export interface ContentTransportOptions {
  /** Use a workspace-specific identity to isolate local recovery drafts. */
  ai?: NativeAiGateway;
  themeFetch?: typeof fetch;
  /** True only when this gateway writes exclusively through runtime.repository. */
  aiUsesObservedRepository?: boolean;
  externallyEditable?: boolean;
  runtime?: SummaryRuntime;
  summaryStore?: SummaryIndexStore;
  identity?: Pick<Identity, 'id' | 'name'>;
  onLogout?: () => void | Promise<void>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});

// Bound request bodies even for in-process callers. ContentService validates fields.
async function input<T>(request: Request): Promise<T> {
  const bytes = await readUploadBody(request, 1024 * 1024);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

async function workspaceRequest(path: string, request: Request, workspace?: WorkspaceControl): Promise<Response> {
  if (!workspace) return json({ error: '未找到此接口' }, 404);
  if (path === '/api/workspace' && request.method === 'GET') return json(await workspace.status());
  if (request.method !== 'POST') return json({ error: '未找到此接口' }, 404);
  switch (path) {
    case '/api/workspace/check':
      if (workspace.checkRemote) return json(await workspace.checkRemote());
      break;
    case '/api/workspace/review':
      await readUploadBody(request, 1024 * 1024);
      return json(await workspace.createReview());
    case '/api/workspace/merge/review':
      if (workspace.reviewMerge) return json(await workspace.reviewMerge());
      break;
    case '/api/workspace/discard/review':
      if (workspace.reviewDiscard) return json(await workspace.reviewDiscard());
      break;
    case '/api/workspace/uncommit/review':
      if (workspace.reviewUncommit) return json(await workspace.reviewUncommit());
      break;
    case '/api/workspace/merge':
      if (workspace.resolveMerge) {
        const body = await input<{ confirmation?: string; choices: MergeChoices }>(request);
        return json(await workspace.resolveMerge(requireWorkspaceConfirmation(body?.confirmation), body?.choices));
      }
      break;
    case '/api/workspace/discard':
      if (workspace.discard) {
        const body = await input<{ confirmation?: string }>(request);
        return json(await workspace.discard(requireWorkspaceConfirmation(body?.confirmation)));
      }
      break;
    case '/api/workspace/uncommit':
      if (workspace.uncommit) {
        const body = await input<{ confirmation?: string }>(request);
        return json(await workspace.uncommit(requireWorkspaceConfirmation(body?.confirmation)));
      }
      break;
    case '/api/workspace/publish':
      if (workspace.publish) {
        const body = await input<{ message: string; confirmation?: string }>(request);
        await workspace.publish(body?.message, requireWorkspaceConfirmation(body?.confirmation));
        return json({ published: true });
      }
      break;
    case '/api/workspace/commit': {
      const body = await input<{ message: string; confirmation?: string; followUpReview?: boolean }>(request);
      const token = requireWorkspaceConfirmation(body?.confirmation);
      if (body.followUpReview === true && workspace.commitForReview) {
        await workspace.commitForReview(body.message, token);
        return json({ committed: true });
      }
      return json(await workspace.commit(body?.message, token));
    }
    case '/api/workspace/sync': {
      const text = new TextDecoder().decode(await readUploadBody(request, 1024 * 1024));
      const body = text ? JSON.parse(text) as { confirmation?: string } : undefined;
      return json(await workspace.sync(requireWorkspaceConfirmation(body?.confirmation)));
    }
  }
  return json({ error: '未找到此接口' }, 404);
}

/**
 * In-process transport for a trusted native app, never a network server handler.
 * It grants access to the repository supplied by the app after local selection.
 * Deployments must use server/createApp, which performs real authentication/CSRF.
 */
export function createContentTransport(repository: Repository, options: ContentTransportOptions = {}): (request: Request) => Promise<Response> {
  const runtime = options.runtime ? requireSummaryRuntime(repository, options.runtime) : createSummaryRuntime(repository, {
    scope: options.identity?.id ?? repository.saveScope ?? 'local-workspace', store: options.summaryStore,
  });
  repository = runtime.repository;
  const content = new ContentService(repository, undefined, options.themeFetch);
  const translation = new TranslationService(repository);
  const session = {
    identity: { id: options.identity?.id ?? 'local-workspace', name: options.identity?.name ?? 'Local workspace', method: 'password' as const },
    csrf: crypto.randomUUID(), expires: Number.MAX_SAFE_INTEGER,
  };
  let connected = true;
  return async request => {
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path === '/api/auth/config' && method === 'GET') return json({ password: false, oidc: null, local: true });
      if (!connected) throw new StudioError(401, '请先连接本地工作区');
      if (method === 'GET' && url.searchParams.get('refresh') === '1' && path === '/api/bootstrap') runtime.invalidate();
      if (path === '/api/auth/session' && method === 'GET') return json(session);
      if (path === '/api/auth/logout' && method === 'POST') { options.ai?.dispose(); await options.onLogout?.(); runtime.dispose(); connected = false; return json({ ok: true }); }
      if (path === '/api/bootstrap' && method === 'GET') {
        const [site, appearance] = await Promise.all([content.settings('site'), content.settings('appearance')]);
        return json({ site: site.values, appearance: appearance.values, saveScope: session.identity.id, saveCapabilities: saveCapabilities(repository), mode: repository.mode, ...workspaceCapabilities(repository.workspace), nativeAi: !!options.ai,
          groups: settingsSchemas.map(({ id, title, description }) => ({ id, title, description })) });
      }
      if (path === '/api/workspace' || path.startsWith('/api/workspace/')) {
        return await workspaceRequest(path, request, repository.workspace);
      }
      if (path === '/api/theme-update' && method === 'GET') return json(await checkThemeUpdate(repository, options.themeFetch ?? fetch));
      if (path === '/api/theme-update' && method === 'POST') return json(await applyThemeUpdate(repository, options.themeFetch ?? fetch, new Date(), await input(request)));
      if (path.startsWith('/api/settings/')) {
        const id = decodeURIComponent(path.slice('/api/settings/'.length)), language = url.searchParams.get('language') ?? undefined;
        if (method === 'GET') return json(await content.settings(id, language));
        if (method === 'PUT') {
          const body = await input<{ revision: string | null; changes: unknown; saveMode?: unknown; retryPackage?: unknown }>(request);
          return json(await content.saveSettings(id, body.changes, body.revision, language, body.saveMode, body.retryPackage));
        }
      }
      if (path === '/api/content-languages' && method === 'GET') return json(await content.languages());
      if (path === '/api/content-preview' && method === 'GET') return json(await runtime.preview());
      if (path === '/api/content' && method === 'GET') {
        // Serialize for each caller: Response bodies are single-use streams.
        return json(await (url.searchParams.get('refresh') === '1' ? runtime.refresh() : runtime.list({ fresh: options.externallyEditable })));
      }
      if (path === '/api/document/versions') {
        if (method === 'GET') return json(await content.documentVersions(url.searchParams.get('path') || ''));
        if (method === 'DELETE') {
          const body = await input<{ path: string; revisions: unknown }>(request);
          return json(await content.removeDocumentVersions(body.path, body.revisions));
        }
      }
      if (path === '/api/document') {
        if (method === 'GET') return json(await content.document(url.searchParams.get('path') || ''));
        if (method === 'PUT') {
          const body = await input<{ path: string; changes: unknown; body: string; revision: string | null; saveMode?: unknown }>(request);
          return json(await content.saveDocument(body.path, body.changes, body.body, body.revision, body.saveMode));
        }
        if (method === 'DELETE') {
          const body = await input<{ path: string; revision: string }>(request);
          return json(await content.removeDocument(body.path, body.revision));
        }
      }
      if (path === '/api/native-ai' && options.ai) {
        if (method === 'GET') return json(options.ai.configuration());
        if (method === 'PUT') return json(options.ai.configure(await input(request)));
        if (method === 'DELETE') return json(options.ai.clearKey());
      }
      if (path === '/api/ai/text' && method === 'POST' && options.ai) {
        const body = await input<AiTextRequest>(request);
        const generate = () => options.ai!.text(body);
        return json(await (options.aiUsesObservedRepository ? generate() : runtime.withUnobservedMutation(generate)));
      }
      if (path === '/api/ai/image' && method === 'POST' && options.ai) {
        const body = await input<{ prompt: string }>(request);
        const generate = () => options.ai!.image(body);
        return json(await (options.aiUsesObservedRepository ? generate() : runtime.withUnobservedMutation(generate)));
      }
      if (path === '/api/translation' && method === 'POST' && options.ai) {
        const body = await input<TranslationRequest>(request);
        const translate = () => options.ai!.translate(body);
        return json(await (options.aiUsesObservedRepository ? translate() : runtime.withUnobservedMutation(translate)), 201);
      }
      if (path === '/api/translation/config' && method === 'GET') return json(options.ai?.translationCapabilities() ?? { enabled: false });
      if (path === '/api/ai/config' && method === 'GET') return json(options.ai?.capabilities() ?? { text: false, image: false });
      if (path === '/api/translation/manual' && method === 'POST') return json(await translation.createManual(await input<TranslationRequest>(request)), 201);
      if ((path === '/api/translation' || path.startsWith('/api/ai/')) && method === 'POST') throw new StudioError(503, '本地工作区尚未配置 AI 服务');
      if (path === '/api/media' && method === 'GET') {
        const listing = await repository.listMedia(url.searchParams.get('refresh') === '1');
        return json({ ...listing, maxFileSize: MAX_UPLOAD_SIZE });
      }
      if (path === '/api/media/upload' && method === 'POST') {
        const bytes = await readUploadBody(request, MAX_UPLOAD_SIZE);
        return json(await repository.uploadMedia(url.searchParams.get('directory') || '', url.searchParams.get('filename') || '', bytes), 201);
      }
      if (path === '/api/media/file' && method === 'GET') {
        const media = await repository.readMedia(url.searchParams.get('path') || '');
        if (!media) throw new StudioError(404, '仓库中未找到这张图片，请刷新媒体库');
        if (media.data.byteLength > MAX_UPLOAD_SIZE) throw new StudioError(413, '图片超过 20 MB 预览限制');
        return new Response(new Uint8Array(media.data).buffer, { headers: {
          'Content-Type': media.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        } });
      }
      return json({ error: '未找到此接口' }, 404);
    } catch (error) {
      if (error instanceof StudioError) return json({ error: error.message, messageKey: error.message, params: error.params }, error.status);
      if (error instanceof SyntaxError || error instanceof URIError) return json({ error: '内容格式不正确，请检查输入' }, 400);
      return json({ error: '操作失败，请检查本地工作区；未确认的更改请保留草稿' }, 500);
    }
  };
}
