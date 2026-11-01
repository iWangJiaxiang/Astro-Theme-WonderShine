import { useEffect, useRef, useState } from 'react';
import App from '../src/App';
import { session } from '../src/api';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { NativeConnection } from './NativeConnection';
import { NativeUpdates } from './NativeUpdates';
export default function NativeShell() {
  useSignals();
  const [connected, setConnected] = useState(false);
  const dispose = useRef<() => void>(() => {});
  useEffect(() => () => dispose.current(), []);
  function disconnect() { dispose.current(); dispose.current = () => {}; session.value = null; setConnected(false); }
  return <>{connected ? <>{!session.value && <button className="native-change-connection" onClick={disconnect}>{t('更换连接')}</button>}<App /></> : <NativeConnection onConnected={cleanup => { dispose.current = cleanup; setConnected(true); }} onDisconnect={disconnect} />}<NativeUpdates /></>;
}
