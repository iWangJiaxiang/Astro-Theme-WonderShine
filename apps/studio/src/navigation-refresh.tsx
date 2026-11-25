import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { t } from "./i18n";
import { useSignals } from "./reactivity";
import Icon from "./components/Icon";

export const RefreshHost = createContext<HTMLElement | null | undefined>(undefined);

export function NavigationRefresh({ label, busy, blocked, onRefresh }: {
  label: string;
  busy?: boolean;
  blocked?: boolean;
  onRefresh: () => void;
}) {
  useSignals();
  const host = useContext(RefreshHost);
  if (host === null) return null;
  const name = t(label);
  const button = <button type="button" className="icon-button navigation-refresh" aria-label={name} title={name}
    aria-busy={!!busy} aria-disabled={!!busy || !!blocked}
    onClick={() => { if (!busy && !blocked) onRefresh(); }}>
    <Icon name="refresh" size={20} />
  </button>;
  return host ? createPortal(button, host) : button;
}
