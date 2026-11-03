import { useEffect, useRef, useState } from 'react';
import type { GitProgressEvent } from 'isomorphic-git';
import { open } from '@tauri-apps/plugin-dialog';
import { hostingProviders, type HostingKind, type WorkspaceProfile } from './hosting';
import { tauriFiles } from './tauri-filesystem';
import LanguageSwitcher from '../src/components/LanguageSwitcher';
import Icon from '../src/components/Icon';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import './native.css';
import AccountLogin from './AccountLogin';
import { readWorkspaces, writeWorkspaces, serviceAddress, type SavedWorkspace, type ServiceWorkspace } from './workspace-registry';
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
export function NativeConnection({ onConnected, onDisconnect }: { onConnected: (dispose: () => void) => void; onDisconnect: () => void }) {
  useSignals();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const folderAvailable = !/Android|iPhone|iPad|iPod/.test(navigator.userAgent) && !(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const [initial] = useState(savedProfiles);
  const [records, setRecords] = useState(initial.records);
  const profiles = records.filter((item): item is WorkspaceProfile => item.source !== 'service');
  const [service, setService] = useState<ServiceWorkspace | null>(null);
  const [showForm, setShowForm] = useState(!initial.records.length);
  function persist(next: SavedWorkspace[]) {
    if (initial.error) throw new Error(initial.error);
    try { writeWorkspaces(localStorage, next); } catch { throw new Error('无法保存工作区记录，请检查存储权限。'); }
    setRecords(next);
  }
  function selectWorkspace(item: SavedWorkspace) {
    setToken(''); setError(''); setShowForm(true);
    if (item.source === 'service') { setService(item); setAddress(item.address); setConnection('remote'); }
    else { setService(null); setProfile(item); setConnection(item.source === 'local' ? 'local' : 'clone'); }
  }
  function renameWorkspace(item: SavedWorkspace) {
    const label = prompt(t('工作区名称'), item.label)?.trim();
    if (!label) return;
    try { persist(records.map(record => record.id === item.id ? { ...record, label } : record)); }
    catch (reason) { setError((reason as Error).message); }
  }
  function removeWorkspace(item: SavedWorkspace) {
    if (!confirm(t('仅移除工作区记录，不删除文件或草稿。确定继续吗？'))) return;
    try { persist(records.filter(record => record.id !== item.id)); setToken(''); setShowForm(false); }
    catch (reason) { setError((reason as Error).message); }
  }
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
  function field(key: keyof WorkspaceProfile, value: string) { if (key === 'url' || key === 'provider' || key === 'username') setToken(''); setProfile(current => ({ ...current, [key]: value })); }
  function switchConnection(value: Connection) {
    if (value === 'local' && !folderAvailable) value = 'clone';
    setConnection(value); setError(''); setToken(''); setService(null); setAddress(''); setShowForm(true);
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
  async function connect(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setProgress(null);
    try {
      if (connection === 'remote') {
        const { connectRemoteWorkspace } = await import('./remote-runtime');
        const nextService: ServiceWorkspace = { id: service?.id || crypto.randomUUID(), source: 'service', address: serviceAddress(address.trim()), label: service?.label || serviceAddress(address.trim()) };
        persist([nextService, ...records.filter(item => item.id !== nextService.id)]);
        const dispose = await connectRemoteWorkspace(nextService.address, onDisconnect, nextService.id);
        if (!mounted.current) { dispose(); return; }
        setToken(''); onConnected(dispose); return;
      }
      const nextProfile = { ...profile, url: profile.url.trim(), branch: profile.branch.trim(), label: profile.label.trim() || profile.url.trim().split('/').at(-1)?.replace(/\.git$/, '') || 'Blog' };
      const { connectNativeWorkspace } = await import('./native-runtime');
      const dispose = await connectNativeWorkspace(nextProfile, token, onDisconnect, progress => { if (mounted.current) setProgress(progress); });
      if (!mounted.current) { dispose(); return; }
      const next = [nextProfile, ...records.filter(item => item.id !== nextProfile.id)];
      try { persist(next); } catch (reason) { dispose(); throw reason; }
      setToken(''); onConnected(dispose);
    } catch (reason) { setError(reason instanceof Error && reason.name === 'TimeoutError' ? t('连接超时，请重试。') : reason instanceof Error ? reason.message : t('无法打开工作区')); }
    finally { setBusy(false); }
  }
  return <main className="native-connect"><section className="card connection-card">
    <div className="connection-brand"><span>WonderShine Studio</span><LanguageSwitcher /></div><h1>{t('连接创作工作区')}</h1>
    <div className="connection-modes" role="group" aria-label={t('连接方式')}>
      {folderAvailable && <button disabled={busy} aria-pressed={local} onClick={() => switchConnection('local')}><Icon name="folder" size={19} />{t('本地文件夹')}</button>}
      <button disabled={busy} aria-pressed={connection === 'clone'} onClick={() => switchConnection('clone')}><Icon name="link" size={19} />{t('远程仓库')}</button>
    </div>
    {(error || initial.error) && <p className="notice error" role="alert">{t(error || initial.error)}</p>}
    <section className="workspace-chooser" aria-label={t('工作区')}>
      {records.map(item => <div className="workspace-record" key={item.id}>
        <strong>{item.label}</strong><small>{item.source === 'service' ? item.address : item.source === 'local' ? item.localPath : item.url}</small>
        <div className="row"><button disabled={busy || (item.source === 'local' && !folderAvailable)} onClick={() => selectWorkspace(item)}>{t('选择工作区')}</button><button disabled={busy} onClick={() => renameWorkspace(item)}>{t('重命名')}</button><button disabled={busy} onClick={() => removeWorkspace(item)}>{t('移除记录')}</button></div>
      </div>)}
      <button disabled={busy} onClick={() => { setProfile(blank()); setService(null); setAddress(''); setToken(''); setError(''); setConnection(folderAvailable ? 'local' : 'clone'); setShowForm(true); }}>{t('添加工作区')}</button>
    </section>
    {showForm && <>
    {connection === 'clone' && <AccountLogin disabled={busy} onSelect={(account, repository) => {
      const previous = profiles.find(item => item.url === repository.url && item.source !== 'local');
      setProfile(previous || { ...blank(), provider: account.provider, url: repository.url, branch: repository.branch, label: repository.name, username: account.username, authorName: account.name, authorEmail: account.email });
      setToken(account.token); setError('');
    }} />}
    <form onSubmit={connect}><fieldset disabled={busy} className="connection-form-fields">
      {connection === 'remote' ? <label className="field"><span>{t('创作中心地址')}</span><input type="url" required placeholder="https://studio.example.com" value={address} readOnly={!!service} onChange={event => setAddress(event.target.value)} /></label> : <>
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
    </form></>}
    <div className="connection-footer"><button className="connection-service" disabled={busy} onClick={() => switchConnection(connection === 'remote' ? 'local' : 'remote')}>{connection === 'remote' ? t('返回仓库连接') : t('连接自建创作中心')}<Icon name="arrow" size={16} /></button></div>
  </section></main>;
}
