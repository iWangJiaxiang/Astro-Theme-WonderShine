import { useEffect, useState } from 'react';
import { api, errorMessage } from '../src/api';
import { t, type Message } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { imageSizes, type NativeAiConfiguration } from '../shared/native-ai';

export function NativeAiSettings({ onDirty }: { onDirty?: (dirty: boolean) => void }) {
  useSignals();
  const [settings, setSettings] = useState<NativeAiConfiguration | null>(null);
  const [key, setKey] = useState('');
  const [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false);
  const [error, setError] = useState<Message>(''), [notice, setNotice] = useState('');
  useEffect(() => { let live = true; setLoading(true); setError(''); api<NativeAiConfiguration>('/native-ai').then(value => { if (live) setSettings(value); }).catch(reason => { if (live) setError(errorMessage(reason)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [attempt]);
  useEffect(() => { onDirty?.(dirty || busy); }, [dirty, busy, onDirty]);
  function update(field: keyof NativeAiConfiguration, value: string) { setSettings(current => current && { ...current, [field]: value }); setDirty(true); setNotice(''); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!settings) return;
    setBusy(true); setError(''); setNotice('');
    try { setSettings(await api('/native-ai', 'PUT', { ...settings, apiKey: key })); setKey(''); setDirty(false); setNotice('已保存本机配置。API Key 仅在本次连接中有效。'); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  async function clearKey() {
    setBusy(true); setError(''); setNotice('');
    try { const saved = await api<NativeAiConfiguration>('/native-ai', 'DELETE'); setSettings(current => current && { ...current, hasKey: saved.hasKey }); setKey(''); setNotice('已清除当前 API Key。'); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <section className="settings-page native-ai-settings">
    <div className="page-heading"><h1>{t('客户端 API 设置')}</h1></div>
    {error && <p className="notice error" role="alert">{t(error)}</p>}{notice && <p className="notice success" role="status">{t(notice)}</p>}
    {!settings ? loading ? <p role="status">{t('正在读取内容…')}</p> : <button onClick={() => setAttempt(value => value + 1)}>{t('重试')}</button> : <form className="card native-ai-form" onSubmit={save}>
      <fieldset disabled={busy}>
        <legend className="sr-only">{t('接口与模型')}</legend>
        <div className="native-ai-credentials">
          <label className="field"><span>{t('API 地址')}</span><input type="url" required value={settings.baseUrl} placeholder="https://api.example.com/v1" onChange={event => update('baseUrl', event.target.value)} /></label>
          <label className="field"><span>API Key</span><input type="password" autoComplete="off" spellCheck={false} value={key} placeholder={settings.hasKey ? t('已配置；留空保留当前密钥') : t('请输入 API Key')} aria-describedby="native-key-lifetime" onChange={event => { setKey(event.target.value); setDirty(true); setNotice(''); }} /></label>
          <p id="native-key-lifetime" className="muted small native-key-note">{t('密钥仅用于当前连接，退出后需重新输入。')}</p>
        </div>
        <div className="native-ai-models">
          <label className="field"><span>{t('文本模型')}</span><input value={settings.model} maxLength={200} onChange={event => update('model', event.target.value)} /></label>
          <label className="field"><span>{t('图片模型（可选）')}</span><input value={settings.imageModel} placeholder={t('留空关闭图片生成')} maxLength={200} onChange={event => update('imageModel', event.target.value)} /></label>
          {settings.imageModel && <label className="field native-image-size"><span>{t('生成图片尺寸')}</span><select value={settings.imageSize} onChange={event => update('imageSize', event.target.value)}>{imageSizes.map(size => <option key={size} value={size}>{size}</option>)}</select></label>}
        </div>
        <div className="row native-ai-actions"><span role="status" className={settings.hasKey ? 'badge' : 'muted small'}>{settings.hasKey ? t('当前连接已配置密钥') : t('尚未配置密钥')}</span><button type="button" className="text-button" disabled={!settings.hasKey} onClick={() => void clearKey()}>{t('清除密钥')}</button><button type="submit" className="primary">{busy ? t('处理中…') : t('保存 API 配置')}</button></div>
      </fieldset>
      <p className="muted small native-ai-disclosure">{t('生成时，文章内容会发送到此接口。')}</p>
    </form>}
  </section>;
}
