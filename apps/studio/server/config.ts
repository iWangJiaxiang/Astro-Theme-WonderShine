import { inspectTranslationSettings } from './translation-config.js';
import { inspectImageSettings } from './ai-config.js';
import type { ImageGenerationSettings } from '../shared/ai.js';
import type { TranslationSettings } from '../shared/translation.js';
import { join, resolve } from 'node:path';
import { DiskRevisionStore, assertRevisionDirectoryOutside } from './revision-store.js';
import { LocalRepository, type Repository } from './repository.js';
import { GitRepository } from './git-repository.js';
import { GitWorkspaceRepository } from './git-workspace.js';
import { FileState, BlobState, type StateStore } from './state.js';
import { createFileSummaryStore } from './summary-store.js';
import type { SummaryIndexStore } from '../core/summary-index.js';

export interface SummaryPersistenceOptions {
  /** Every actual HTTP/static serving root. Omission disables durable previews. */
  servingRoots: readonly string[];
}

export interface OidcSettings { issuer: string; clientId: string; clientSecret?: string; subjects: string[]; label: string }
export interface StudioConfig {
  origin: string; secureCookies: boolean; sessionSecret: string; sessionSeconds: number;
  translation?: TranslationSettings;
  imageGeneration?: ImageGenerationSettings;
  username?: string; passwordHash?: string; oidc?: OidcSettings;
}
export function inspectConfig(env: NodeJS.ProcessEnv = process.env): { config: StudioConfig; repository: Repository; stateMode: 'file' | 'blob'; stateDirectory: string } {
  const origin = new URL(env.STUDIO_ORIGIN || 'http://localhost:5173');
  if (origin.origin !== origin.href.replace(/\/$/, '') || origin.username || origin.password) throw new Error('STUDIO_ORIGIN 必须为不含路径的 origin');
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('非本机地址必须使用 HTTPS');
  const secret = env.STUDIO_SESSION_SECRET || '';
  if (secret.length < 32) throw new Error('请配置至少 32 字符的 STUDIO_SESSION_SECRET');
  const username = env.STUDIO_ADMIN_USER, passwordHash = env.STUDIO_ADMIN_PASSWORD_HASH;
  if ((username || passwordHash) && (!username || !/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(passwordHash || ''))) throw new Error('请完整配置管理员账号和 scrypt 密码哈希');
  let oidc: OidcSettings | undefined;
  if (env.STUDIO_OIDC_ISSUER) {
    const issuer = new URL(env.STUDIO_OIDC_ISSUER);
    if (issuer.protocol !== 'https:') throw new Error('OIDC issuer 必须使用 HTTPS');
    const subjects = (env.STUDIO_OIDC_SUBJECTS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!env.STUDIO_OIDC_CLIENT_ID || !subjects.length) throw new Error('OIDC 需要 client ID 和明确的 subject 白名单');
    oidc = { issuer: env.STUDIO_OIDC_ISSUER, clientId: env.STUDIO_OIDC_CLIENT_ID,
      clientSecret: env.STUDIO_OIDC_CLIENT_SECRET, subjects, label: env.STUDIO_OIDC_LABEL || '统一身份登录' };
  }
  if (!username && !oidc) throw new Error('至少启用账号密码或 OIDC 认证之一');
  if (!env.STUDIO_GIT_URL && !env.STUDIO_SITE_ROOT) throw new Error('请配置 STUDIO_SITE_ROOT 或 STUDIO_GIT_URL 指向独立站点');
  if (env.STUDIO_GIT_WORKSPACE && (!env.STUDIO_GIT_URL || env.STUDIO_STATE === 'blob')) throw new Error('持久 Git 工作区需要 Git 地址和本地持久磁盘，不能用于云函数 Blob 部署');
  const gitOptions = { url: env.STUDIO_GIT_URL || '', branch: env.STUDIO_GIT_BRANCH || 'master',
    username: env.STUDIO_GIT_USERNAME || 'x-access-token', token: env.STUDIO_GIT_TOKEN || '',
    name: env.STUDIO_GIT_AUTHOR || 'Creator Studio', email: env.STUDIO_GIT_EMAIL || 'studio@localhost' };
  const stateDirectory = resolve(env.STUDIO_STATE_DIR || '.state');
  const revisionDirectory = join(stateDirectory, 'content-revisions-v1');
  const checkout = env.STUDIO_GIT_URL ? env.STUDIO_GIT_WORKSPACE : env.STUDIO_SITE_ROOT;
  if (checkout) assertRevisionDirectoryOutside(checkout, revisionDirectory);
  const repository = env.STUDIO_GIT_URL
    ? env.STUDIO_GIT_WORKSPACE ? new GitWorkspaceRepository({ ...gitOptions, directory: env.STUDIO_GIT_WORKSPACE, revisionDirectory }) : new GitRepository(gitOptions)
    : new LocalRepository(resolve(env.STUDIO_SITE_ROOT!), new DiskRevisionStore(env.STUDIO_SITE_ROOT!, { directory: revisionDirectory }));
  if (env.STUDIO_STATE === 'blob' && repository.mode !== 'git') throw new Error('Makers 部署必须配置 Git 仓库，不能保存到临时文件系统');
  if (env.STUDIO_STATE && !['file', 'blob'].includes(env.STUDIO_STATE)) throw new Error('STUDIO_STATE 必须是 file 或 blob');
  return { config: { origin: origin.origin, secureCookies: origin.protocol === 'https:', sessionSecret: secret,
    sessionSeconds: 8 * 3600, username, passwordHash, oidc, translation: inspectTranslationSettings(env), imageGeneration: inspectImageSettings(env) }, repository, stateMode: env.STUDIO_STATE === 'blob' ? 'blob' : 'file', stateDirectory };
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, persistence?: SummaryPersistenceOptions): {
  config: StudioConfig; repository: Repository; state: StateStore; summaryStore?: SummaryIndexStore; summaryScope?: string;
} {
  const { config, repository, stateMode, stateDirectory } = inspectConfig(env);
  const checkout = env.STUDIO_GIT_URL ? env.STUDIO_GIT_WORKSPACE : env.STUDIO_SITE_ROOT;
  let summaryStore: SummaryIndexStore | undefined;
  let summaryScope: string | undefined;
  // Cloud Blob and temporary online Git have no proven private local boundary.
  // Custom servers must identify their serving roots before persistence is enabled.
  if (stateMode === 'file' && checkout && persistence) {
    const root = resolve(checkout);
    try {
      summaryStore = createFileSummaryStore(join(stateDirectory, 'summary-preview-v1'), [root, ...persistence.servingRoots.map(path => resolve(path))]);
      summaryScope = JSON.stringify(['server-summary-v1', config.origin, repository.mode, root,
        env.STUDIO_GIT_URL ?? '', env.STUDIO_GIT_URL ? env.STUDIO_GIT_BRANCH || 'master' : '']);
    } catch {
      // Optional derived state must never make startup fail. Async permission,
      // missing-parent and alias checks remain lazy and fail closed in the index.
    }
  }
  return { config, repository, state: stateMode === 'blob' ? new BlobState() : new FileState(stateDirectory), summaryStore, summaryScope };
}
