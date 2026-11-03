import { requireWorkspaceConfirmation } from '../shared/workspace-confirmation.js';
import { saveCapabilities } from './save.js';
import { ContentService } from './content-service.js';
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
  const content = new ContentService(repository);
  const translation = new TranslationService(repository);
  const session = {
    identity: { id: options.identity?.id ?? 'local-workspace', name: options.identity?.name ?? 'Local workspace', method: 'password' as const },
    csrf: crypto.randomUUID(), expires: Number.MAX_SAFE_INTEGER,
  };
  let connected = true;
  // Only derived summaries are cached, never repository reads or revision checks.
  let generation = 0, mutations = 0;
  let summaries: Promise<Awaited<ReturnType<ContentService['list']>>> | undefined;
  const invalidate = () => { generation++; summaries = undefined; };
  const list = () => {
    if (summaries) return summaries;
    const current = generation;
    const pending = content.list();
    if (!mutations) summaries = pending;
    void pending.catch(() => {
      if (generation === current && summaries === pending) summaries = undefined;
    });
    return pending;
  };
  return async request => {
    let mutating = false;
    try {
      const url = new URL(request.url), path = url.pathname, method = request.method;
      if (path === '/api/auth/config' && method === 'GET') return json({ password: false, oidc: null, local: true });
      if (!connected) throw new StudioError(401, '请先连接本地工作区');
      // Invalidate on both boundaries, including partial failures. Reads while a
      // mutation is pending cannot become a reusable snapshot.
      mutating = (path === '/api/document' && ['PUT', 'DELETE'].includes(method))
        || (path.startsWith('/api/settings/') && method === 'PUT')
        || (['/api/translation', '/api/translation/manual', '/api/workspace/sync', '/api/auth/logout'].includes(path) && method === 'POST');
      if (mutating) { mutations++; invalidate(); }
      if (method === 'GET' && url.searchParams.get('refresh') === '1'
        && ['/api/content', '/api/bootstrap'].includes(path)) {
        invalidate();
        repository.clearReadCache?.();
      }
      if (path === '/api/auth/session' && method === 'GET') return json(session);
      if (path === '/api/auth/logout' && method === 'POST') { options.ai?.dispose(); await options.onLogout?.(); connected = false; return json({ ok: true }); }
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
      if (path === '/api/content' && method === 'GET') {
        // Serialize for each caller: Response bodies are single-use streams.
        return json(await list());
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
      if (path === '/api/ai/text' && method === 'POST' && options.ai) return json(await options.ai.text(await input<AiTextRequest>()));
      if (path === '/api/ai/image' && method === 'POST' && options.ai) return json(await options.ai.image(await input<{ prompt: string }>()));
      if (path === '/api/translation' && method === 'POST' && options.ai) return json(await options.ai.translate(await input<TranslationRequest>()), 201);
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
    } finally {
      if (mutating) { mutations--; invalidate(); }
    }
  };
}
