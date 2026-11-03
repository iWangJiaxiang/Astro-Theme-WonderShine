# Native workspace chooser

- Preserve the v1 registry key and native IDs/disk/draft scopes; extend records with a service discriminant.
- Show local repositories, clones and HTTPS Studio services together. Record rename/removal never deletes files.
- Return to the chooser via guarded logout; block mutations and invalidate stale requests on transport changes.
- Service identities include registry ID, while authentication cookies and CSRF remain unchanged and memory-only.
- Add registry/isolation tests and production-browser chooser/switch coverage. No local installs, builds or tests; CI verification remains pending.
