import { ErrorNotice } from "../src/components/ErrorNotice";
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { GitProgressEvent } from 'isomorphic-git';
import { open } from '@tauri-apps/plugin-dialog';
import { hostingProviders, type HostingKind, type WorkspaceProfile } from './hosting';
import { tauriFiles } from './tauri-filesystem';
import LoadingState from '../src/components/LoadingState';
import LanguageSwitcher from '../src/components/LanguageSwitcher';
import Icon from '../src/components/Icon';
import { t, type Message } from '../src/i18n';
import { errorMessage } from '../src/api';
import { useSignals } from '../src/reactivity';
import './native.css';
import { forgetGitGrant } from './git-vault';
import type { GitGrant } from './provider-auth';
import AccountLogin from './AccountLogin';
import { matchWorkspace, readWorkspaces, writeWorkspaces, serviceAddress, type SavedWorkspace, type ServiceWorkspace } from './workspace-registry';
function savedProfiles(): { records: SavedWorkspace[]; error: string } {
  try { return { records: readWorkspaces(localStorage), error: '' }; }
  catch { return { records: [], error: '无法读取工作区记录，请检查存储权限或恢复备份。' }; }
}
const blank = (): WorkspaceProfile => ({ id: crypto.randomUUID(), label: '', provider: 'generic', url: '', branch: '', username: '', authorName: '', authorEmail: '' });
type Connection = 'local' | 'clone' | 'remote';
const progressLabels: Record<string, string> = {
  'Receiving objects': '接收仓库数据', 'Resolving deltas': '整理仓库数据',
  'Updating workdir': '写入本地文件', 'Analyzing workdir': '检查本地文件',
  'Counting objects': '统计仓库文件', 'Compressing objects': '准备仓库数据',
};
export function NativeConnection({ onConnected, onDisconnect, resumeOnLaunch, updateControls }: { updateControls?: ReactNode; resumeOnLaunch: boolean; onConnected: (dispose: () => void) => void; onDisconnect: () => void }) {
  useSignals();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const folderAvailable = !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const [initial] = useState(savedProfiles);
  const [resumeTarget] = useState(() => {
    const recent = initial.records[0];
    return resumeOnLaunch && !folderAvailable && recent && !recent.archived && recent.source !== 'local' ? recent : null;
  });
  const [resuming, setResuming] = useState(!!resumeTarget);
  const attemptedResume = useRef(false);
  useEffect(() => {
    if (!resumeTarget || attemptedResume.current) return;
    attemptedResume.current = true;
    void openWorkspace(resumeTarget, '', true);
  }, [resumeTarget]);
  const [records, setRecords] = useState(initial.records);
  const profiles = records.filter((item): item is WorkspaceProfile => !item.archived && item.source !== 'service');
  const [service, setService] = useState<ServiceWorkspace | null>(null);
  const [showForm, setShowForm] = useState(!initial.records.length);
  function persist(next: SavedWorkspace[]) {
    if (initial.error) throw new Error(initial.error);
    try { writeWorkspaces(localStorage, next); } catch { throw new Error('无法保存工作区记录，请检查存储权限。'); }
    setRecords(next);
  }
  function selectWorkspace(item: SavedWorkspace) {
    setToken(''); setError(''); setShowForm(true); setIncludeSubmodules(false);
    if (item.source === 'service') { setService(item); setAddress(item.address); setConnection('remote'); }
    else { setService(null); setProfile(item); setConnection(item.source === 'local' ? 'local' : 'clone'); }
  }
  function renameWorkspace(item: SavedWorkspace) {
    const label = prompt(t('工作区名称'), item.label)?.trim();
    if (!label) return;
    try { persist(records.map(record => record.id === item.id ? { ...record, label } : record)); }
    catch (reason) { setError((reason as Error).message); }
  }
  function archiveWorkspace(item: SavedWorkspace) {
    if (!confirm(t('归档仅隐藏记录，保留原编号、文件和草稿，可随时恢复。确定继续吗？'))) return;
    try { persist(records.map(record => record.id === item.id ? { ...record, archived: true } : record)); setToken(''); setShowForm(false); }
    catch (reason) { setError((reason as Error).message); }
  }
  async function deleteRecord(item: SavedWorkspace) {
    if (!confirm(t('删除「{name}」的连接记录？文件、草稿和本地提交会保留在设备上，重新添加时可能无法找回原草稿。', { name: item.label }))) return;
    setBusy(true);
    try {
      if (item.source !== 'service' && item.url.startsWith('https://')) await forgetGitGrant(item);
      const next = records.filter(record => record.id !== item.id);
      persist(next);
      if (profile.id === item.id || service?.id === item.id || !next.length) {
        setProfile(blank()); setService(null); setAddress(''); setToken(''); setIncludeSubmodules(false); setShowForm(!next.length);
      }
      setError('');
    } catch (reason) { setError((reason as Error).message); }
    finally { setBusy(false); }
  }
  const [profile, setProfile] = useState<WorkspaceProfile>(() => (folderAvailable ? profiles[0] : profiles.find(item => item.source !== 'local')) || blank());
  const [connection, setConnection] = useState<Connection>(() => folderAvailable && (profiles[0]?.source === 'local' || !profiles.length) ? 'local' : 'clone');
  const [includeSubmodules, setIncludeSubmodules] = useState(false);
  const [address, setAddress] = useState('');
  const [token, updateToken] = useState('');
  const login = useRef<{ grant: GitGrant; url: string; provider: string; username: string } | null>(null);
  function setToken(value: string) { login.current = null; updateToken(value); }
  const [busy, setBusy] = useState(false), [error, setError] = useState<Message>('');
  const [progress, setProgress] = useState<GitProgressEvent | null>(null);
  const progressLabel = progress ? progressLabels[progress.phase] || '下载仓库' : '正在连接仓库';
  const progressValue = progress?.total && progress.total > 0 ? Math.min(100, Math.max(0, Math.floor(progress.loaded / progress.total * 100))) : undefined;
  const existing = profiles.some(item => item.id === profile.id);
  const local = connection === 'local';
  function field(key: keyof WorkspaceProfile, value: string) { if (key === 'url' || key === 'provider' || key === 'username') setToken(''); setProfile(current => ({ ...current, [key]: value })); }
  function switchConnection(value: Connection) {
    if (value === 'local' && !folderAvailable) value = 'clone';
    setConnection(value); setError(''); setToken(''); setService(null); setAddress(''); setShowForm(true); setIncludeSubmodules(false);
    setProfile(profiles.find(item => value === 'local' ? item.source === 'local' : item.source !== 'local') || blank());
  }
  async function chooseFolder() {
    setBusy(true); setError(''); setToken('');
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
  async function openWorkspace(item: SavedWorkspace, credential: string, resume = false) {
    setBusy(true); setError(''); setProgress(null);
    try {
      const match = matchWorkspace(records, item);
      if (match?.archived) throw new Error('此工作区已归档，请先从已归档工作区恢复记录。');
      if (match && match.id !== item.id) {
        if (match.source !== 'service' && item.source !== 'service') {
          item = { ...match, provider: item.provider, username: item.username || match.username,
            authorName: item.authorName || match.authorName, authorEmail: item.authorEmail || match.authorEmail };
        } else item = match;
      }
      let dispose: () => void;
      if (item.source === 'service') {
        const { connectRemoteWorkspace } = await import('./remote-runtime');
        dispose = await connectRemoteWorkspace(item.address, onDisconnect, item.id);
      } else {
        if (item.source !== 'local' && !item.authorName && !item.authorEmail) {
          item = { ...item, authorName: 'WonderShine Studio', authorEmail: 'studio@localhost' };
        }
        const { connectNativeWorkspace } = await import('./native-runtime');
        const selected = login.current;
        const grant = selected && selected.url === item.url && selected.provider === item.provider && selected.username === item.username && selected.grant.token === credential ? selected.grant : undefined;
        dispose = await connectNativeWorkspace(item, credential, onDisconnect, progress => { if (mounted.current) setProgress(progress); },
          undefined, !resume, grant, !resume && !match && !existing && connection === 'clone' && includeSubmodules);
      }
      if (!mounted.current) { dispose(); return; }
      try { if (!resume) persist([item, ...records.filter(record => record.id !== item.id)]); }
      catch (reason) { dispose(); throw reason; }
      setToken(''); onConnected(dispose);
    } catch (reason) {
      if (mounted.current) {
        if (resume) selectWorkspace(item);
        setError(reason instanceof Error && reason.name === 'TimeoutError' ? t('连接超时，请重试。') : reason instanceof Error ? errorMessage(reason) : '无法打开工作区');
      }
    } finally {
      if (mounted.current) { setBusy(false); setResuming(false); }
    }
  }
  function connect(event: React.FormEvent) {
    event.preventDefault();
    if (connection === 'remote') {
      try {
        const origin = serviceAddress(address.trim());
        void openWorkspace({ id: service?.id || crypto.randomUUID(), source: 'service', address: origin, label: service?.label || origin }, '');
      } catch (reason) { setError((reason as Error).message); }
    } else {
      void openWorkspace({ ...profile, url: profile.url.trim(), branch: profile.branch.trim(), label: profile.label.trim() || profile.url.trim().split('/').at(-1)?.replace(/\.git$/, '') || 'Blog' }, token);
    }
  }
  function renderRecord(item: SavedWorkspace) {
    return <div className="workspace-record" data-workspace-id={item.id} key={item.id}>
      <strong>{item.label}</strong>
      <small>{item.source === 'service' ? item.address : item.source === 'local' ? item.localPath : item.url}</small>
      <div className="row">
        {item.archived ? <button className="secondary" disabled={busy} onClick={() => {
          try { persist(records.map(record => record.id === item.id ? { ...record, archived: false } : record)); setError(''); }
          catch (reason) { setError((reason as Error).message); }
        }}>{t('恢复记录')}</button> : <>
          <button className="secondary" disabled={busy || (item.source === 'local' && !folderAvailable)} onClick={() => selectWorkspace(item)}>{t('选择工作区')}</button>
          <button disabled={busy} onClick={() => renameWorkspace(item)}>{t('重命名')}</button>
          <button disabled={busy} onClick={() => archiveWorkspace(item)}>{t('归档记录')}</button>
        </>}
        <button className="danger" disabled={busy} onClick={() => deleteRecord(item)}>{t('删除记录')}</button>
      </div>
    </div>;
  }
  if (resuming) return <main className="native-connect"><LoadingState label="正在打开工作区…" compact /></main>;
  return <main className="native-connect"><section className="card connection-card">
    <div className="connection-brand"><details className="connection-about"><summary>WonderShine Studio</summary>{updateControls}</details><LanguageSwitcher /></div><h1>{t('连接创作工作区')}</h1>
    <div className="connection-modes" role="group" aria-label={t('连接方式')}>
      {folderAvailable && <button disabled={busy} aria-pressed={local} onClick={() => switchConnection('local')}><Icon name="folder" size={19} />{t('本地文件夹')}</button>}
      <button disabled={busy} aria-pressed={connection === 'clone'} onClick={() => switchConnection('clone')}><Icon name="link" size={19} />{t('远程仓库')}</button>
    </div>
    {(error || initial.error) && <ErrorNotice source="NativeConnection" message={error || initial.error} />}
    {records.length > 0 && <section className="workspace-chooser" aria-label={t('工作区')}>
      {records.filter(item => !item.archived).map(renderRecord)}
      {records.some(item => item.archived) && <details className="archived-workspaces"><summary>{t('已归档工作区')}</summary>
        {records.filter(item => item.archived).map(renderRecord)}
      </details>}
      <button className="secondary" disabled={busy} onClick={() => { setProfile(blank()); setService(null); setAddress(''); setToken(''); setError(''); setIncludeSubmodules(false); setConnection(folderAvailable ? 'local' : 'clone'); setShowForm(true); }}>{t('添加工作区')}</button>
    </section>}
    {showForm && <>
    {connection === 'clone' && <AccountLogin disabled={busy} onSelect={(account, repository) => {
      setProfile({ ...blank(), provider: account.provider, url: repository.url, branch: repository.branch, label: repository.name, username: account.username, authorName: account.name, authorEmail: account.email });
      setToken(account.token);
      const { token, refreshToken, expiresAt, refreshExpiresAt, clientId } = account;
      login.current = { grant: { token, refreshToken, expiresAt, refreshExpiresAt, clientId }, url: repository.url, provider: account.provider, username: account.username };
      setError('');
    }} />}
    <form onSubmit={connect}><fieldset disabled={busy} className="connection-form-fields">
      {connection === 'remote' ? <label className="field"><span>{t('创作中心地址')}</span><input type="url" required placeholder="https://studio.example.com" value={address} readOnly={!!service} onChange={event => setAddress(event.target.value)} /></label> : <>
        {profiles.some(item => local ? item.source === 'local' : item.source !== 'local') && <label className="field"><span>{t('最近使用')}</span><select value={existing ? profile.id : ''} onChange={event => { setProfile(profiles.find(item => item.id === event.target.value) || blank()); setToken(''); setError(''); setIncludeSubmodules(false); }}><option value="">{t('添加仓库')}</option>{profiles.filter(item => local ? item.source === 'local' : item.source !== 'local').map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
        {local ? <div className="connection-folder">
          <button className="folder-picker" type="button" disabled={!folderAvailable} onClick={() => void chooseFolder()}><Icon name="folder" size={28} /><span>{profile.localPath ? profile.label : t('选择本地仓库')}</span><span className="folder-picker-action">{profile.localPath ? t('更换文件夹') : t('浏览文件夹')}</span></button>
          {profile.localPath && <div className="selected-repository"><span className="repository-path">{profile.localPath}</span><span className="repository-branch">{profile.branch}</span></div>}
          {!folderAvailable && <p className="muted small">{t('此设备请使用远程仓库，下载后可离线编辑。')}</p>}
        </div> : <label className="field connection-url"><span>{t('仓库地址')}</span><input type="url" required readOnly={existing} placeholder="https://github.com/owner/blog.git" value={profile.url} onChange={e => field('url', e.target.value)} autoCapitalize="none" spellCheck={false} /></label>}
        {!local && !existing && <label className="field checkbox-field">
          <input type="checkbox" checked={includeSubmodules} onChange={event => setIncludeSubmodules(event.target.checked)} />
          <span>{t('下载子模块')}</span>
        </label>}
        {(!local || profile.localPath) && <details className="connection-options"><summary>{t('连接与提交设置')}</summary><div className="connection-option-fields">
          <div className="connection-fields"><label className="field"><span>{t('工作区名称')}</span><input value={profile.label} onChange={e => field('label', e.target.value)} /></label><label className="field"><span>{t('分支')}</span><input required={existing || local} placeholder={t('自动识别默认分支')} readOnly={existing || local} value={profile.branch} onChange={e => field('branch', e.target.value)} /></label></div>
          {!local && <label className="field"><span>{t('Git 服务')}</span><select value={profile.provider} onChange={e => field('provider', e.target.value as HostingKind)}>{hostingProviders.map(item => <option key={item.id} value={item.id}>{t(item.label)}</option>)}</select></label>}
          <div className="connection-fields"><label className="field"><span>{t('Git 用户名')}</span><input autoComplete="username" value={profile.username} onChange={e => field('username', e.target.value)} /></label><label className="field"><span>{t('访问令牌')}</span><input type="password" autoComplete="off" placeholder={t('保存到系统凭据存储')} value={token} onChange={e => setToken(e.target.value)} /></label></div>
          <div className="connection-fields"><label className="field"><span>{t('提交者名称')}</span><input value={profile.authorName} onChange={e => field('authorName', e.target.value)} /></label><label className="field"><span>{t('提交者邮箱')}</span><input type="email" value={profile.authorEmail} onChange={e => field('authorEmail', e.target.value)} /></label></div>
        </div></details>}
      </>}
      <button className="primary wide" type="submit" disabled={local && !profile.localPath}>{busy ? t('正在打开工作区…') : connection === 'remote' ? t('连接并登录') : local || existing ? t('打开工作区') : t('下载并开始创作')}</button>
    </fieldset>
      {busy && connection === 'clone' && !existing && <div className="connection-progress">
        <div className="connection-progress-caption"><span role="status">{t(progressLabel)}</span>{progressValue !== undefined && <span>{progressValue}%</span>}</div>
        <progress aria-label={t(progressLabel)} max={100} value={progressValue} />
      </div>}
    </form></>}
    <div className="connection-footer"><button className="secondary connection-service" disabled={busy} onClick={() => switchConnection(connection === 'remote' ? 'local' : 'remote')}>{connection === 'remote' ? t('返回仓库连接') : t('连接自建创作中心')}<Icon name="arrow" size={16} /></button></div>
  </section></main>;
}
