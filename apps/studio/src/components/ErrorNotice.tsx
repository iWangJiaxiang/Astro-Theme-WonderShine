import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { version } from '../../package.json';
import { t, type Message } from '../i18n';
import { useSignals } from '../reactivity';

function redact(text: string) {
  return text
    .replace(/-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/gi, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S+/gi, '$1')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/gi, '$1: [redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[a-z\d._~+/=-]+/gi, '[redacted]')
    .replace(/(["']?(?:[\w-]*token|pass(?:word|wd)|api[_-]?key|client[_-]?secret|secret|authorization|cookie)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-)[\w-]+/g, '[redacted]');
}

type DetailsProps = { message: Message; source: string };

export function ErrorDetails({ message, source }: DetailsProps) {
  useSignals();
  const title = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const reportField = useRef<HTMLTextAreaElement>(null);
  const [report, setReport] = useState('');
  const [feedback, setFeedback] = useState('');
  useLayoutEffect(() => {
    if (!report) return;
    const node = dialog.current!;
    node.showModal();
    return () => { if (node.open) node.close(); };
  }, [report]);

  function open() {
    const diagnostic = typeof message === 'object' ? message.diagnostic : undefined;
    const git = typeof message === 'object' && message.params?.gitDetail;
    setFeedback('');
    setReport(redact([
      'WonderShine Studio ' + version + ('__TAURI_INTERNALS__' in window ? ' (App)' : ' (Web)'),
      diagnostic?.at ?? new Date().toISOString(), source,
      diagnostic?.request, diagnostic?.status && 'Studio API HTTP ' + diagnostic.status, diagnostic?.type,
      typeof git === 'string' && /^libgit2 (fetch|push) [A-Za-z]+\/[A-Za-z]+$/.test(git) && git,
      t(message),
    ].filter(Boolean).join('\n')));
  }
  async function copy() {
    const field = reportField.current;
    if (!field) return;
    try {
      await navigator.clipboard.writeText(report);
      if (!field.isConnected) return;
      setFeedback('详情已复制');
    } catch {
      if (!field.isConnected) return;
      field.focus();
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Keep the report selected for manual copying. */ }
      setFeedback(copied ? '详情已复制' : '请选择详情文字手动复制');
    }
  }
  return <>
    <button ref={trigger} type="button" className="text-button error-more" aria-haspopup="dialog" onClick={open}>{t('更多')}</button>
    {report && <dialog ref={dialog} className="error-dialog" aria-labelledby={title}
      onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation(); }}
      onCancel={event => { event.stopPropagation(); }}
      onClose={event => { event.stopPropagation(); setReport(''); trigger.current?.focus(); }}>
      <h2 id={title}>{t('错误详情')}</h2>
      <textarea ref={reportField} aria-labelledby={title} value={report} readOnly spellCheck={false} />
      {feedback && <p role="status">{t(feedback)}</p>}
      <div className="error-actions">
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>{t('关闭')}</button>
        <button type="button" className="primary" onClick={() => void copy()}>{t('复制详情')}</button>
      </div>
    </dialog>}
  </>;
}

export function ErrorNotice({ message, source, prefix, children, className = 'notice error', announce = true }: DetailsProps & {
  prefix?: string; children?: ReactNode; className?: string; announce?: boolean;
}) {
  useSignals();
  return <div className={className} role={announce ? "alert" : undefined}>
    <span className="error-summary">{prefix}{redact(t(message))}</span>{children}{' '}<ErrorDetails message={message} source={source} />
  </div>;
}
