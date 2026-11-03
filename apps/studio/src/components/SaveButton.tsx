import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SaveMode } from '../../shared/save';
import { rememberSaveMode, saveContext, saveModeLabel } from '../save-preferences';
import { t } from '../i18n';
import { useSignals } from '../reactivity';

type Props = { mode: SaveMode; onModeChange(mode: SaveMode): void; onSave(): void; disabled?: boolean; busy?: boolean; label?: string };
export default function SaveButton({ mode, onModeChange, onSave, disabled, busy, label }: Props) {
  useSignals();
  const [open, setOpen] = useState(false), [error, setError] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const context = saveContext.value;
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const height = panel.current?.offsetHeight || 200;
      const top = rect.bottom + 8 + height < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - height - 8);
      setPosition({ top, left: Math.max(8, Math.min(rect.right - 240, innerWidth - 248)) });
    };
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    place(); panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const focusOutside = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('focusin', focusOutside);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { document.removeEventListener('focusin', focusOutside); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  useEffect(() => { if (busy) setOpen(false); }, [busy]);
  return <div className="save-button">
    <button type="button" className="primary save-button-main" disabled={disabled || busy} onClick={onSave}>
      {busy ? t('正在保存…') : label || t(saveModeLabel[mode])}
    </button>
    <button type="button" className="primary save-button-toggle" ref={trigger} disabled={busy} aria-label={t('选择保存方式')} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { setError(false); setOpen(!open); }}>⌄</button>
    {open && createPortal(<div id={id} className="save-mode-menu" role="dialog" aria-label={t('保存方式')} ref={panel} style={{ top: position.top, left: position.left }}>
      <div role="radiogroup" aria-label={t('保存方式')} onKeyDown={event => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const items = [...panel.current!.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
        {(['local', 'branch', ...(context.modes.includes('remote') ? ['remote'] : [])] as SaveMode[]).map(choice => <button type="button" key={choice} role="radio" aria-checked={mode === choice} disabled={!context.modes.includes(choice)} title={!context.modes.includes(choice) ? t('当前连接不支持此保存方式') : undefined} onClick={() => { onModeChange(choice); setOpen(false); trigger.current?.focus(); }}>
          <span className="save-mode-check" aria-hidden="true">{mode === choice ? '✓' : ''}</span><span>{t(saveModeLabel[choice])}</span>{context.defaultMode === choice && <small>{t('默认')}</small>}
        </button>)}
      </div>
      <button type="button" className="save-mode-default" disabled={mode === context.defaultMode} onClick={() => { if (rememberSaveMode(mode)) { setOpen(false); trigger.current?.focus(); } else setError(true); }}>{t('将当前方式设为默认')}</button>
      {error && <p role="alert">{t('无法记住偏好，请检查本地存储权限')}</p>}
    </div>, document.body)}
  </div>;
}
