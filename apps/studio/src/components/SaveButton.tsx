import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SaveMode } from '../../shared/save';
import { rememberSaveMode, saveContext, saveModeLabel } from '../save-preferences';
import { t } from '../i18n';
import { useSignals } from '../reactivity';
import { overlayPosition } from '../overlay-position';

type Props = { mode: SaveMode; onModeChange(mode: SaveMode): void; onSave(): void; disabled?: boolean; busy?: boolean; label?: string; canInteract?(): boolean };
export default function SaveButton({ mode, onModeChange, onSave, disabled, busy, label, canInteract }: Props) {
  useSignals();
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const allowed = () => alive.current && (canInteract?.() ?? true);
  const [open, setOpen] = useState(false), [error, setError] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const context = saveContext.value;
  function rememberPreference() {
    if (!allowed()) return false;
    if (!canInteract) return rememberSaveMode(mode);
    const current = saveContext.value;
    if (!current.modes.includes(mode)) return false;
    try { localStorage.setItem('studio.save-default.v1:' + current.scope, mode); }
    catch { return false; }
    // Storage callbacks may synchronously retire this Settings owner.
    if (!allowed() || saveContext.value !== current) return false;
    saveContext.value = { ...current, defaultMode: mode };
    return true;
  }
  useEffect(() => {
    if (!open) return;
    const place = () => {
      if (!allowed() || !trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const view = window.visualViewport;
      setPosition(overlayPosition(rect,
        { height: panel.current?.offsetHeight || 200, width: panel.current?.offsetWidth || 240 },
        { left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0, width: view?.width ?? innerWidth, height: view?.height ?? innerHeight },
      ));
    };
    const outside = (event: PointerEvent) => {
      if (allowed() && !panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (allowed() && event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    place(); if (allowed()) panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const focusOutside = (event: FocusEvent) => {
      if (allowed() && !panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', focusOutside); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  useEffect(() => { if (busy) setOpen(false); }, [busy]);
  return <div className="save-button">
    <button type="button" className="primary save-button-main" disabled={disabled || busy} onClick={() => { if (allowed()) onSave(); }}>
      {busy ? t('正在保存…') : label || t(saveModeLabel[mode])}
    </button>
    <button type="button" className="primary save-button-toggle" ref={trigger} disabled={busy} aria-label={t('选择保存方式')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { if (!allowed()) return; setError(false); setOpen(!open); }}>⌄</button>
    {open && createPortal(<div id={id} className="save-mode-menu" role="dialog" aria-label={t('保存方式')} ref={panel} style={{ top: position.top, left: position.left }}>
      <div role="radiogroup" aria-label={t('保存方式')} onKeyDown={event => {
        if (!allowed() || !panel.current || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...panel.current!.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
        {(['local', 'branch', ...(context.modes.includes('remote') ? ['remote'] : [])] as SaveMode[]).map(choice => <button type="button" key={choice} role="radio" aria-checked={mode === choice} disabled={!context.modes.includes(choice)} title={!context.modes.includes(choice) ? t('当前连接不支持此保存方式') : undefined} onClick={() => { if (!allowed()) return; onModeChange(choice); if (!allowed()) return; setOpen(false); trigger.current?.focus(); }}>
          <span className="save-mode-check" aria-hidden="true">{mode === choice ? '✓' : ''}</span><span>{t(saveModeLabel[choice])}</span>{context.defaultMode === choice && <small>{t('默认')}</small>}
        </button>)}
      </div>
      <button type="button" className="save-mode-default" disabled={mode === context.defaultMode} onClick={() => { if (!allowed()) return; const remembered = rememberPreference(); if (!allowed()) return; if (remembered) { setOpen(false); trigger.current?.focus(); } else setError(true); }}>{t('将当前方式设为默认')}</button>
      {error && <p role="alert">{t('无法记住偏好，请检查本地存储权限')}</p>}
    </div>, document.body)}
  </div>;
}
