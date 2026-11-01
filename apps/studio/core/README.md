# Portable content core

This directory owns content rules shared by the HTTP server and native clients. It has no Node, React, Vue, or Tauri imports. Dependencies provide TOML parsing and static SVG validation only.

- `ContentService` receives the platform-neutral `Repository` contract. Revision checks, taxonomy and topic relationships, article references, multilingual sections, and translation review requirements remain the same on every platform.
- `TranslationService` uses Web Crypto and standard Fetch APIs. Native transports currently expose manual translation only; cloud deployments continue to configure AI on the server.
- `createContentTransport(repository, options)` adapts the existing `/api` request shapes to an **in-process** native invocation. It grants access to an already selected local workspace. It must never be mounted as a public HTTP handler, used as a cloud function, or mistaken for authentication. Network deployments use `server/app.ts` and its real session, authorization, and CSRF controls.
- `media-validation.ts` shares upload size, path, image-signature, and static SVG checks without importing filesystem operations.
- `portable.ts` uses SHA-256 via Web Crypto for the same revision format as the server. Web Crypto requires a secure browser context; Tauri provides the runtime adapter.

Server files reexport the core implementation to preserve existing imports. Platform-specific repositories remain responsible for filesystem confinement, atomic writes, rollback, locks, and persistent Git state. Supplying a repository does not relax any of these requirements.

Run `npx tsx --test apps/studio/tests/portable-core.test.ts` from the workspace root to verify browser bundling, revision compatibility, manual translations, and in-process editing.
