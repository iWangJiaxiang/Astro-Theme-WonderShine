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

export interface ContentTransportOptions {
  /** Use a workspace-specific identity to isolate local recovery drafts. */
  ai?: NativeAiGateway;
  /** True only when this gateway writes exclusively through runtime.repository. */
  aiUsesObservedRepository?: boolean;
  runtime?: SummaryRuntime;
  summaryStore?: SummaryIndexStore;
  identity?: Pick<Identity, 'id' | 'name'>;
  onLogout?: () => void | Promise<void>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
});

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
  const content = new ContentService(repository);
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
      // Bound request bodies even for in-process callers. ContentService validates fields.
      const input = async <T>(): Promise<T> => {
        const bytes = await readUploadBody(request, 1024 * 1024);
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
      };
      if (path === '/api/bootstrap' && method === 'GET') {
        const [site, appearance] = await Promise.all([content.settings('site'), content.settings('appearance')]);
        return json({ site: site.values, appearance: appearance.values, saveScope: session.identity.id, saveCapabilities: saveCapabilities(repository), mode: repository.mode, workspace: !!repository.workspace, nativeAi: !!options.ai,
          groups: settingsSchemas.map(({ id, title, description }) => ({ id, title, description })) });
      }
      if (path === '/api/workspace' && method === 'GET' && repository.workspace) return json(await repository.workspace.status());
      if (path === '/api/workspace/review' && method === 'POST' && repository.workspace) {
        await readUploadBody(request, 1024 * 1024);
        return json(await repository.workspace.createReview());
      }
      if (path === '/api/workspace/commit' && method === 'POST' && repository.workspace) {
        const body = await input<{ message: string; confirmation?: string }>();
        return json(await repository.workspace.commit(body?.message, requireWorkspaceConfirmation(body?.confirmation)));
      }
      if (path === '/api/workspace/sync' && method === 'POST' && repository.workspace) {
        const text = new TextDecoder().decode(await readUploadBody(request, 1024 * 1024));
        const body = text ? JSON.parse(text) as { confirmation?: string } : undefined;
        return json(await repository.workspace.sync(requireWorkspaceConfirmation(body?.confirmation)));
      }
      if (path.startsWith('/api/settings/')) {
        const id = decodeURIComponent(path.slice('/api/settings/'.length)), language = url.searchParams.get('language') ?? undefined;
        if (method === 'GET') return json(await content.settings(id, language));
        if (method === 'PUT') {
          const body = await input<{ revision: string | null; changes: unknown; saveMode?: unknown }>();
          return json(await content.saveSettings(id, body.changes, body.revision, language, body.saveMode));
        }
      }
      if (path === '/api/content-languages' && method === 'GET') return json(await content.languages());
      if (path === '/api/content-preview' && method === 'GET') return json(await runtime.preview());
      if (path === '/api/content' && method === 'GET') {
        // Serialize for each caller: Response bodies are single-use streams.
        return json(await (url.searchParams.get('refresh') === '1' ? runtime.refresh() : runtime.list()));
      }
      if (path === '/api/document') {
        if (method === 'GET') return json(await content.document(url.searchParams.get('path') || ''));
        if (method === 'PUT') {
          const body = await input<{ path: string; changes: unknown; body: string; revision: string | null; saveMode?: unknown }>();
          return json(await content.saveDocument(body.path, body.changes, body.body, body.revision, body.saveMode));
        }
        if (method === 'DELETE') {
          const body = await input<{ path: string; revision: string }>();
          return json(await content.removeDocument(body.path, body.revision));
        }
      }
      if (path === '/api/native-ai' && options.ai) {
        if (method === 'GET') return json(options.ai.configuration());
        if (method === 'PUT') return json(options.ai.configure(await input()));
        if (method === 'DELETE') return json(options.ai.clearKey());
      }
      if (path === '/api/ai/text' && method === 'POST' && options.ai) {
        const body = await input<AiTextRequest>();
        const generate = () => options.ai!.text(body);
        return json(await (options.aiUsesObservedRepository ? generate() : runtime.withUnobservedMutation(generate)));
      }
      if (path === '/api/ai/image' && method === 'POST' && options.ai) {
        const body = await input<{ prompt: string }>();
        const generate = () => options.ai!.image(body);
        return json(await (options.aiUsesObservedRepository ? generate() : runtime.withUnobservedMutation(generate)));
      }
      if (path === '/api/translation' && method === 'POST' && options.ai) {
        const body = await input<TranslationRequest>();
        const translate = () => options.ai!.translate(body);
        return json(await (options.aiUsesObservedRepository ? translate() : runtime.withUnobservedMutation(translate)), 201);
      }
      if (path === '/api/translation/config' && method === 'GET') return json(options.ai?.translationCapabilities() ?? { enabled: false });
      if (path === '/api/ai/config' && method === 'GET') return json(options.ai?.capabilities() ?? { text: false, image: false });
      if (path === '/api/translation/manual' && method === 'POST') return json(await translation.createManual(await input<TranslationRequest>()), 201);
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
