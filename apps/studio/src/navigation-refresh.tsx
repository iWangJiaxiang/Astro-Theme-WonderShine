import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t, type Message } from "./i18n";
import { useSignals, type Ref } from "./reactivity";
import Icon from "./components/Icon";

export const RefreshHost = createContext<HTMLElement | null | undefined>(undefined);
export type GitSyncAction = {
  busy: boolean;
  updates: boolean;
  hint: Message;
  run: (afterSync: (workspaceRefreshed: boolean) => void) => void;
};
export const NavigationGitSync = createContext<Ref<GitSyncAction | null> | null>(null);

export function NavigationRefresh({ label, busy, blocked, onRefresh, followsWorkspace = false }: {
  label: string;
  busy?: boolean;
  blocked?: boolean;
  onRefresh: () => void;
  followsWorkspace?: boolean;
}) {
  useSignals();
  const host = useContext(RefreshHost);
  const git = useContext(NavigationGitSync)?.value;
  const current = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    current.current = busy || blocked ? null : onRefresh;
    return () => { current.current = null; };
  }, [busy, blocked, onRefresh]);
  if (host === null) return null;
  const name = t(git ? "同步 Git 并刷新当前内容" : label);
  const working = !!(busy || git?.busy);
  const button = <button type="button" className="icon-button navigation-refresh" aria-label={name}
    title={git?.updates ? t("有提交待同步") : git ? t(git.hint) : name} data-updates={git?.updates || undefined}
    aria-busy={working} aria-disabled={working || !!blocked}
    onClick={() => {
      if (working || !current.current) return;
      if (!git) { current.current(); return; }
      git.run(workspaceRefreshed => {
        if (!workspaceRefreshed || !followsWorkspace) current.current?.();
      });
    }}>
    <Icon name="sync" size={20} />
  </button>;
  return host ? createPortal(button, host) : button;
}
