type WorkspaceChangedListener = () => void | Promise<void>;
const listeners = new Set<WorkspaceChangedListener>();

/** Call after any attempted sync, including failure after a partial checkout. */
export function notifyWorkspaceChanged(): Promise<void> {
  return Promise.all([...listeners].map(listener => {
    try {
      // Refresh failures belong to each subscriber's UI, not the sync outcome.
      return Promise.resolve(listener()).catch(() => {});
    } catch {
      // A disposed or failed subscriber must not interrupt other subscribers.
    }
  })).then(() => {});
}

/** Notifications carry no cached content and never trigger another sync. */
export function subscribeWorkspaceChanged(listener: WorkspaceChangedListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
