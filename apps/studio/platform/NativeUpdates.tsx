import { ErrorNotice } from '../src/components/ErrorNotice';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { checkAppRelease, releaseApk, releaseRepository, updateDestination, type ApkAsset, type AppRelease } from './app-updates';
import { apkUnmetered, appPlatform, downloadUpdate, installUpdate } from './update-install';
import { workspaceOperationsPending } from './queue';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import './updates.css';

const repository = releaseRepository(import.meta.env.VITE_STUDIO_RELEASE_REPOSITORY || 'iWangJiaxiang/Astro-Theme-WonderShine');
const storeUrl = import.meta.env.VITE_STUDIO_IOS_UPDATE_URL || '';
const skippedKey = `studio.update.skipped:${repository}`;
const modeKey = 'studio.update.download';
const interval = 6 * 60 * 60 * 1000;
type Offer = AppRelease & { apk?: ApkAsset };
type Phase = 'idle' | 'checking' | 'downloading' | 'installing';
function read(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function write(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* Keep session preference. */ } }
const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1) + ' MiB';

export function NativeUpdates({ children }: { children?: (controls: ReactNode) => ReactNode }) {
  useSignals();
  const platform = appPlatform();
  const [version, setVersion] = useState('');
  const [automatic, setAutomatic] = useState(() => read(modeKey) !== 'manual');
  const auto = useRef(automatic);
  const [phase, setPhase] = useState<Phase>('idle');
  const operation = useRef<Phase>('idle');
  function transition(value: Phase) { operation.current = value; setPhase(value); }
  const [message, setMessage] = useState('');
  const [release, setRelease] = useState<Offer | null>(null);
  const [ready, setReady] = useState('');
  const downloaded = useRef('');
  const [progress, setProgress] = useState({ bytes: 0, total: 0 });
  const pending = useRef<AbortController | null>(null);
  const lastCheck = useRef(0);
  const dismissed = useRef('');
  const dialog = useRef<HTMLDialogElement>(null);
  const live = useRef(true);

  async function install(offer: Offer) {
    if (workspaceOperationsPending() || !window.dispatchEvent(new Event('studio:before-install', { cancelable: true }))) {
      setMessage('请先保存修改，并等当前操作完成后再安装');
      return;
    }
    transition('installing');
    dialog.current?.showModal();
    try {
      await installUpdate(offer.version, offer.apk);
    } catch (error) {
      const code = typeof error === 'object' && error && 'message' in error ? error.message : error;
      setMessage(code === 'PERMISSION' ? '请允许此来源安装应用，返回后再次点击安装' :
        code === 'CANCELLED' ? '已取消安装，可以稍后重试' : '安装失败，请重试或从发行页下载安装');
    } finally { dialog.current?.close(); }
  }

  async function download(offer: Offer, background: boolean) {
    transition('downloading');
    setMessage('');
    setProgress({ bytes: 0, total: offer.apk?.size || 0 });
    try {
      await downloadUpdate(offer.version, offer.apk, background, (bytes, total) => {
        if (live.current) setProgress({ bytes, total: total || 0 });
      });
      if (!live.current) return;
      downloaded.current = offer.version;
      setReady(offer.version);
      if (!background) await install(offer);
    } catch (error) {
      const code = typeof error === 'object' && error && 'message' in error ? error.message : error;
      setMessage(code === 'METERED' ? '当前网络可能计费，可手动下载' :
        code === 'INVALID_APK' || /signature|signed version/i.test(String(code)) ? '更新包校验失败，请重新下载' : '下载更新失败，请检查网络后重试');
    } finally { if (live.current) transition('idle'); }
  }

  async function check(manual = false) {
    if (operation.current !== 'idle' || (!manual && Date.now() - lastCheck.current < interval)) return;
    transition('checking');
    const controller = new AbortController();
    pending.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    lastCheck.current = Date.now();
    if (manual) setMessage('');
    try {
      const current = await getVersion();
      if (controller.signal.aborted) return;
      setVersion(current);
      const latest = await checkAppRelease(current, repository, nativeFetch, controller.signal);
      if (controller.signal.aborted) return;
      if (!latest || (!manual && (latest.version === read(skippedKey) || latest.version === dismissed.current))) {
        setRelease(null);
        if (manual && !latest) setMessage('未发现可用更新');
        return;
      }
      const offer: Offer = { ...latest, installer: latest.installer &&
        (platform !== 'desktop' || import.meta.env.VITE_STUDIO_DESKTOP_UPDATER === 'true') };
      if (offer.installer && platform === 'android') offer.apk = await releaseApk(offer, repository, nativeFetch, controller.signal);
      if (controller.signal.aborted) return;
      setRelease(offer);
      if (!offer.installer || platform === 'ios' || !auto.current || downloaded.current === offer.version) return;
      if (offer.apk && !await apkUnmetered().catch(() => false)) {
        setMessage('当前网络可能计费，可手动下载');
        return;
      }
      if (!controller.signal.aborted && auto.current) await download(offer, true);
    } catch {
      if (manual && live.current) setMessage('暂时无法检查更新，请稍后重试');
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) { pending.current = null; transition('idle'); }
    }
  }
  useEffect(() => {
    live.current = true;
    const initial = window.setTimeout(() => void check(), 3000);
    const visible = () => { if (document.visibilityState === 'visible') void check(); };
    const timer = window.setInterval(visible, interval);
    document.addEventListener('visibilitychange', visible);
    return () => {
      live.current = false;
      clearTimeout(initial); clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
      pending.current?.abort(); pending.current = null;
    };
  }, []);
  function dismiss(skip: boolean) {
    if (!release) return;
    dismissed.current = release.version;
    if (skip) write(skippedKey, release.version);
    setRelease(null); setMessage('');
  }
  async function openRelease() {
    if (!release) return;
    try { await openUrl(updateDestination(release, repository, platform === 'ios', storeUrl)); }
    catch { setMessage('无法打开下载页面，请稍后重试'); }
  }
  const busy = phase !== 'idle';
  const supported = release?.installer && platform !== 'ios';
  const prepared = release && ready === release.version;
  async function act() {
    if (!release || operation.current !== 'idle') return;
    if (!supported) await openRelease();
    else if (prepared) {
      setMessage('');
      try { await install(release); } finally { transition('idle'); }
    } else await download(release, false);
  }
  const feedback = message === '未发现可用更新' || message === '当前网络可能计费，可手动下载' ?
    <span role="status">{t(message)}</span> : message ? <ErrorNotice source="NativeUpdates" message={message} /> : null;
  const controls = <div className="native-update-controls">
    <span>Studio{version && ` ${version}`}</span>
    <button type="button" disabled={busy} onClick={() => void check(true)}>{t(phase === 'checking' ? '正在检查更新' : '检查 Studio 更新')}</button>
    {platform !== 'ios' && <label><input type="checkbox" checked={automatic} onChange={event => {
      auto.current = event.target.checked; setAutomatic(auto.current); write(modeKey, auto.current ? 'auto' : 'manual');
    }} /> {t('自动下载更新，安装前确认')}</label>}
    {!release && feedback}
  </div>;
  return <>
    {children ? children(controls) : controls}
    {release && <aside className="native-update-notice" aria-label={t('App 更新')}>
      <div><strong>{t('Studio {version} 可更新', { version: release.version })}</strong>
        {release.apk && <small> · {megabytes(release.apk.size)}</small>}
        {phase === 'downloading' && <div role="status">{t('正在下载更新')} · {megabytes(progress.bytes)}
          <progress aria-label={t('正在下载更新')} value={progress.total ? progress.bytes : undefined} max={progress.total || 1} /></div>}
        {feedback}
      </div>
      <button type="button" className="primary" disabled={busy} onClick={() => void act()}>{t(!supported ? '查看更新' : prepared ? (platform === 'android' ? '安装更新' : '安装并重新打开') : '下载并安装')}</button>
      <button type="button" disabled={busy} onClick={() => dismiss(false)}>{t('稍后')}</button>
      <button type="button" disabled={busy} className="native-update-skip" onClick={() => dismiss(true)}>{t('跳过此版本')}</button>
      {supported && message && <button type="button" disabled={busy} onClick={() => void openRelease()}>{t('查看更新')}</button>}
    </aside>}
    <dialog ref={dialog} onCancel={event => event.preventDefault()} aria-label={t('正在安装更新')}><p role="status">{t('正在安装更新')}</p></dialog>
  </>;
}
