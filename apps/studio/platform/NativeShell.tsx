import { useEffect, useRef, useState } from 'react';
import App from '../src/App';
import { session, reauthentication, pendingMutations } from '../src/api';
import { t } from '../src/i18n';
import { useSignals } from '../src/reactivity';
import { NativeConnection } from './NativeConnection';
import { NativeUpdates } from './NativeUpdates';
export default function NativeShell() {
  useSignals();
  const [connected, setConnected] = useState(false);
  const dispose = useRef<() => void>(() => {});
  useEffect(() => () => dispose.current(), []);
  function disconnect() { dispose.current(); dispose.current = () => {}; session.value = null; reauthentication.value = false; setConnected(false); }
  return <div className={connected ? 'native-shell' : 'native-shell native-shell-connecting'}>{connected ? <>{!session.value && <button className="native-change-connection" disabled={pendingMutations.value > 0} onClick={disconnect}>{t('切换工作区')}</button>}<App workspaceSwitcher /></> : <NativeConnection onConnected={cleanup => { dispose.current = cleanup; setConnected(true); }} onDisconnect={disconnect} />}<NativeUpdates /></div>;
}
