import { useCallback, useEffect, useRef, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { checkAppRelease, releaseRepository, updateDestination, type AppRelease } from './app-updates';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import './updates.css';

const repository = releaseRepository(import.meta.env.VITE_STUDIO_RELEASE_REPOSITORY || 'iWangJiaxiang/Astro-Theme-WonderShine');
const storeUrl = import.meta.env.VITE_STUDIO_IOS_UPDATE_URL || '';
const skippedKey = `studio.update.skipped:${repository}`;
const interval = 6 * 60 * 60 * 1000;

export function NativeUpdates() {
  useSignals();
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [release, setRelease] = useState<AppRelease | null>(null);
  const pending = useRef<AbortController | null>(null);
  const lastCheck = useRef(0);
  const dismissed = useRef('');
  const check = useCallback(async (manual = false) => {
    if (pending.current || (!manual && Date.now() - lastCheck.current < interval)) return;
    const controller = new AbortController();
    pending.current = controller;
    lastCheck.current = Date.now();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setBusy(true);
    if (manual) setMessage('');
    try {
      const current = await getVersion();
      if (controller.signal.aborted) return;
      setVersion(current);
      const latest = await checkAppRelease(current, repository, nativeFetch, controller.signal);
      if (controller.signal.aborted) return;
      lastCheck.current = Date.now();
      let skipped = '';
      try { skipped = localStorage.getItem(skippedKey) || ''; } catch { /* Optional preference. */ }
      setRelease(latest && (manual || (latest.version !== skipped && latest.version !== dismissed.current)) ? latest : null);
      if (manual && !latest) setMessage('未发现可用更新');
    } catch {
      if (manual) setMessage('暂时无法检查更新，请稍后重试');
    } finally {
      clearTimeout(timeout);
      if (pending.current === controller) { pending.current = null; setBusy(false); }
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void check(), 3000);
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void check(); }, interval);
    const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearTimeout(initial); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); pending.current?.abort(); pending.current = null; };
  }, [check]);
  function dismiss(skip: boolean) {
    if (!release) return;
    dismissed.current = release.version;
    if (skip) { try { localStorage.setItem(skippedKey, release.version); } catch { /* Session dismissal still works. */ } }
    setRelease(null);
  }
  async function download() {
    if (!release) return;
    try {
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      await openUrl(updateDestination(release, repository, ios, storeUrl));
    } catch { setMessage('无法打开下载页面，请稍后重试'); }
  }
  return <>
    <footer className="native-update-footer">
      <span>Studio{version && ` ${version}`}</span>
      <button type="button" disabled={busy} onClick={() => void check(true)}>{t(busy ? '正在检查更新' : '检查更新')}</button>
      {message && <span role="status">{t(message)}</span>}
    </footer>
    {release && <aside className="native-update-notice" aria-label={t('App 更新')}>
      <div role="status"><strong>{t('Studio {version} 可更新', { version: release.version })}</strong></div>
      <button type="button" className="primary" onClick={() => void download()}>{t('查看更新')}</button>
      <button type="button" onClick={() => dismiss(false)}>{t('稍后')}</button>
      <button type="button" className="native-update-skip" onClick={() => dismiss(true)}>{t('跳过此版本')}</button>
    </aside>}
  </>;
}
