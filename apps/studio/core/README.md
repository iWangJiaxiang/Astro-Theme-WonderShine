# Portable content core

This directory owns content rules shared by the HTTP server and native clients. It has no Node, React, Vue, or Tauri imports. Dependencies provide TOML parsing and static SVG validation only.

- `ContentService` receives the platform-neutral `Repository` contract. Revision checks, taxonomy and topic relationships, article references, multilingual sections, and translation review requirements remain the same on every platform.
- `TranslationService` uses Web Crypto and standard Fetch APIs. Native transports currently expose manual translation only; cloud deployments continue to configure AI on the server.
- `createContentTransport(repository, options)` adapts the existing `/api` request shapes to an **in-process** native invocation. It grants access to an already selected local workspace. It must never be mounted as a public HTTP handler, used as a cloud function, or mistaken for authentication. Network deployments use `server/app.ts` and its real session, authorization, and CSRF controls.
- `media-validation.ts` shares upload size, path, image-signature, and static SVG checks without importing filesystem operations.
- `portable.ts` uses SHA-256 via Web Crypto for the same revision format as the server. Web Crypto requires a secure browser context; Tauri provides the runtime adapter.

Server files reexport the core implementation to preserve existing imports. Platform-specific repositories remain responsible for filesystem confinement, atomic writes, rollback, locks, and persistent Git state. Supplying a repository does not relax any of these requirements.

Remote CI should run `npx tsx --test apps/studio/tests/portable-core.test.ts apps/studio/tests/content-cache.test.ts` from the workspace root to verify browser bundling, revision compatibility, manual translations, in-process editing, and summary cache behavior. Do not run builds/tests locally (see `AGENTS.md`).

## Native summary cache

Each `createContentTransport` instance retains only the `/api/content` summary promise in runtime memory. Repeated navigation and simultaneous ordinary reads reuse that scan; each caller gets a new JSON Response. Nothing is persisted to localStorage, and credentials, document bodies, settings responses, and repository revision reads are not cached by this layer. The Node HTTP server and shared ContentService are unchanged.

Content/settings mutations, manual/AI translations, sync, and logout invalidate before starting and in `finally`, including partial failures. Reads during mutations are not retained. Explicit `/content?refresh=1` or `/bootstrap?refresh=1` drops the summary and clears the repository read cache where available. Detached old promises cannot repopulate the cache or evict a newer promise on failure. Requests already running can still return their earlier snapshot; this is not transactional read isolation.

External filesystem/Git edits require explicit refresh; there is no filesystem watcher or TTL. Separate transports/workspaces never share snapshots (or invalidation signals). First load and refresh still scan all content using existing bounded reads and task yielding. Bootstrap, languages, settings, document reads, JSON serialization, and rendering still have their normal costs. Retained summary memory scales with content count. No iOS performance or memory measurements have yet been made for this change.
