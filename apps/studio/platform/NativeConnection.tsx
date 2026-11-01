import { useState } from 'react';
import type { GitProgressEvent } from 'isomorphic-git';
import { open } from '@tauri-apps/plugin-dialog';
import { hostingProviders, validateProfile, type HostingKind, type WorkspaceProfile } from './hosting';
import { tauriFiles } from './tauri-filesystem';
import LanguageSwitcher from '../src/components/LanguageSwitcher';
import Icon from '../src/components/Icon';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import './native.css';
const storageKey = 'wondershine.native.workspaces.v1';
function savedProfiles(): WorkspaceProfile[] {
  try { const value: unknown = JSON.parse(localStorage.getItem(storageKey) || '[]'); return Array.isArray(value) ? value.filter(item => { try { validateProfile(item); return true; } catch { return false; } }) : []; } catch { return []; }
}
const blank = (): WorkspaceProfile => ({ id: crypto.randomUUID(), label: '', provider: 'generic', url: '', branch: '', username: '', authorName: '', authorEmail: '' });
type Connection = 'local' | 'clone' | 'remote';
const progressLabels: Record<string, string> = {
  'Receiving objects': '接收仓库数据', 'Resolving deltas': '整理仓库数据',
  'Updating workdir': '写入本地文件', 'Analyzing workdir': '检查本地文件',
  'Counting objects': '统计仓库文件', 'Compressing objects': '准备仓库数据',
};
export function NativeConnection({ onConnected, onDisconnect }: { onConnected: (dispose: () => void) => void; onDisconnect: () => void }) {
  useSignals();
  const folderAvailable = !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const [profiles, setProfiles] = useState(savedProfiles);
  const [profile, setProfile] = useState<WorkspaceProfile>(() => (folderAvailable ? profiles[0] : profiles.find(item => item.source !== 'local')) || blank());
  const [connection, setConnection] = useState<Connection>(() => folderAvailable && (profiles[0]?.source === 'local' || !profiles.length) ? 'local' : 'clone');
  const [address, setAddress] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [progress, setProgress] = useState<GitProgressEvent | null>(null);
  const progressLabel = progress ? progressLabels[progress.phase] || '下载仓库' : '正在连接仓库';
  const progressValue = progress?.total && progress.total > 0 ? Math.min(100, Math.max(0, Math.floor(progress.loaded / progress.total * 100))) : undefined;
  const existing = profiles.some(item => item.id === profile.id);
  const local = connection === 'local';
  function field(key: keyof WorkspaceProfile, value: string) { setProfile(current => ({ ...current, [key]: value })); }
  function switchConnection(value: Connection) {
    if (value === 'local' && !folderAvailable) value = 'clone';
    setConnection(value); setError(''); setToken('');
    setProfile(profiles.find(item => value === 'local' ? item.source === 'local' : item.source !== 'local') || blank());
  }
  async function chooseFolder() {
    setBusy(true); setError('');
    try {
      const selected = await open({ directory: true, multiple: false, recursive: true, title: t('选择本地仓库'), ...(profile.localPath ? { defaultPath: profile.localPath } : {}) });
      if (typeof selected !== 'string') return;
      const { inspectLocalRepository } = await import('./local-workspace');
      const detected = await inspectLocalRepository(tauriFiles(selected), selected);
      const previous = profiles.find(item => item.localPath === detected.localPath);
      setProfile({ ...detected, ...(previous ? { id: previous.id, authorName: detected.authorName || previous.authorName, authorEmail: detected.authorEmail || previous.authorEmail, username: previous.username } : {}) });
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setProgress(null);
    try {
      if (connection === 'remote') {
        const { connectRemoteWorkspace } = await import('./remote-runtime');
        const dispose = await connectRemoteWorkspace(address.trim(), onDisconnect); onConnected(dispose); return;
      }
      const nextProfile = { ...profile, url: profile.url.trim(), branch: profile.branch.trim(), label: profile.label.trim() || profile.url.trim().split('/').at(-1)?.replace(/\.git$/, '') || 'Blog' };
      const { connectNativeWorkspace } = await import('./native-runtime');
      const dispose = await connectNativeWorkspace(nextProfile, token, onDisconnect, setProgress);
      const next = [nextProfile, ...profiles.filter(item => item.id !== nextProfile.id)];
      try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Workspace itself remains on disk. */ }
      setProfiles(next); setToken(''); onConnected(dispose);
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('无法打开工作区')); }
    finally { setBusy(false); }
  }
  return <main className="native-connect"><section className="card connection-card">
    <div className="connection-brand"><span>WonderShine Studio</span><LanguageSwitcher /></div><h1>{t('连接创作工作区')}</h1>
    <div className="connection-modes" role="group" aria-label={t('连接方式')}>
      {folderAvailable && <button disabled={busy} aria-pressed={local} onClick={() => switchConnection('local')}><Icon name="folder" size={19} />{t('本地文件夹')}</button>}
      <button disabled={busy} aria-pressed={connection === 'clone'} onClick={() => switchConnection('clone')}><Icon name="link" size={19} />{t('远程仓库')}</button>
    </div>
    {error && <p className="notice error" role="alert">{t(error)}</p>}
    <form onSubmit={connect}><fieldset disabled={busy} className="connection-form-fields">
      {connection === 'remote' ? <label className="field"><span>{t('创作中心地址')}</span><input type="url" required placeholder="https://studio.example.com" value={address} onChange={event => setAddress(event.target.value)} /></label> : <>
        {profiles.some(item => local ? item.source === 'local' : item.source !== 'local') && <label className="field"><span>{t('最近使用')}</span><select value={existing ? profile.id : ''} onChange={event => { setProfile(profiles.find(item => item.id === event.target.value) || blank()); setToken(''); setError(''); }}><option value="">{t('添加仓库')}</option>{profiles.filter(item => local ? item.source === 'local' : item.source !== 'local').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        {local ? <div className="connection-folder">
          <button className="folder-picker" type="button" disabled={!folderAvailable} onClick={() => void chooseFolder()}><Icon name="folder" size={28} /><span>{profile.localPath ? profile.label : t('选择本地仓库')}</span><span className="folder-picker-action">{profile.localPath ? t('更换文件夹') : t('浏览文件夹')}</span></button>
          {profile.localPath && <div className="selected-repository"><span className="repository-path">{profile.localPath}</span><span className="repository-branch">{profile.branch}</span></div>}
          {!folderAvailable && <p className="muted small">{t('此设备请使用远程仓库，下载后可离线编辑。')}</p>}
        </div> : <label className="field connection-url"><span>{t('仓库地址')}</span><input type="url" required readOnly={existing} placeholder="https://github.com/owner/blog.git" value={profile.url} onChange={e => field('url', e.target.value)} autoCapitalize="none" spellCheck={false} /></label>}
        {(!local || profile.localPath) && <details className="connection-options"><summary>{t('连接与提交设置')}</summary><div className="connection-option-fields">
          <div className="connection-fields"><label className="field"><span>{t('工作区名称')}</span><input value={profile.label} onChange={e => field('label', e.target.value)} /></label><label className="field"><span>{t('分支')}</span><input required={existing || local} placeholder={t('自动识别默认分支')} readOnly={existing || local} value={profile.branch} onChange={e => field('branch', e.target.value)} /></label></div>
          {!local && <label className="field"><span>{t('Git 服务')}</span><select value={profile.provider} onChange={e => field('provider', e.target.value as HostingKind)}>{hostingProviders.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>}
          <div className="connection-fields"><label className="field"><span>{t('Git 用户名')}</span><input autoComplete="username" value={profile.username} onChange={e => field('username', e.target.value)} /></label><label className="field"><span>{t('访问令牌')}</span><input type="password" autoComplete="off" placeholder={t('仅当前会话')} value={token} onChange={e => setToken(e.target.value)} /></label></div>
          <div className="connection-fields"><label className="field"><span>{t('提交者名称')}</span><input value={profile.authorName} onChange={e => field('authorName', e.target.value)} /></label><label className="field"><span>{t('提交者邮箱')}</span><input type="email" value={profile.authorEmail} onChange={e => field('authorEmail', e.target.value)} /></label></div>
        </div></details>}
      </>}
      <button className="primary wide" type="submit" disabled={local && !profile.localPath}>{busy ? t('正在打开工作区…') : connection === 'remote' ? t('连接并登录') : local || existing ? t('打开工作区') : t('下载并开始创作')}</button>
    </fieldset>
      {busy && connection === 'clone' && !existing && <div className="connection-progress">
        <div className="connection-progress-caption"><span role="status">{t(progressLabel)}</span>{progressValue !== undefined && <span>{progressValue}%</span>}</div>
        <progress aria-label={t(progressLabel)} max={100} value={progressValue} />
      </div>}
    </form>
    <div className="connection-footer"><button className="connection-service" disabled={busy} onClick={() => switchConnection(connection === 'remote' ? 'local' : 'remote')}>{connection === 'remote' ? t('返回仓库连接') : t('连接自建创作中心')}<Icon name="arrow" size={16} /></button></div>
  </section></main>;
}
