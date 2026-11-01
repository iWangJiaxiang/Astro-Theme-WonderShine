# Creator Studio cross-platform implementation

Approved 2026-10-31. Keep the existing HTTP/cloud-function backend; defer Rust/WASM backend consolidation. Do not push, publish, or deploy.

## Architecture
- React/Vite UI, preserving existing editing and localization behavior.
- Platform-neutral content/repository and transport interfaces, with server-side validation retained.
- Persistent local Git workspaces: save, commit, and sync are separate operations; never discard offline work.
- Git engine separate from hosting-provider capabilities. Generic HTTPS Git access plus explicit provider metadata.
- Tauri shell without an embedded Node runtime. Platform adapters handle native storage/network. Web and cloud deployments remain supported.

## Work and verification
- [x] React migration and existing UI parity.
- [x] Portable content and repository contracts.
- [x] Persistent Git workspace with revision/conflict protection and local tests.
- [x] Hosting-provider abstraction and connection validation.
- [x] App transport and Tauri packaging integration.
- [x] Typecheck, unit tests, production build and browser regression.
- [x] Independent code review, fixes and operator documentation.

Native packaging and provider behavior must be reported according to actual tested coverage; no claims of signed mobile apps or live provider compatibility without verification.

## Completion evidence — 2026-10-31

- Branch: `feat/studio-react-workspaces`; changes remain uncommitted and unpushed.
- `npm run check`: Astro and Studio checks passed.
- `npm test`: 254 tests passed (73 theme, 180 Studio, 1 migration).
- Studio production build, Web browser regression and React lifecycle regression passed.
- Native browser core and native UI regression passed, including desktop/mobile viewport layouts, offline editing, local Git, media, and bundled editor assets. Native UI tests use an IPC fixture under the configured CSP, not a real mobile device.
- Rust build with `custom-protocol` and macOS debug App packaging passed; bundle size 50.26 MiB. Actual macOS GUI/system-permission interactions are not yet verified.
- Independent code review completed with no remaining blocking findings. `git diff --check` passed.
- Personal `blog-new` checkout remains clean; its theme submodule reference was not updated.
- Vite reports a large frontend chunk warning; builds still pass.

## Remaining platform validation and intentional limits

- Android/iOS toolchains, signing, device tests and app-store distribution are not completed.
- HTTPS Git is tested against local smart-HTTP fixtures; live authentication with each hosting provider remains unverified. Provider-specific OAuth, repository discovery, PR/MR and deployment APIs are not implemented.
- Native direct Git mode supports manual translation; AI remains available through the existing server mode. Native OIDC callback support is deferred; Web OIDC remains the supported route.
- Local workspaces currently reside in private App data; arbitrary external folders, visual conflict resolution, Git LFS, submodule management and persistent credential storage are outside this implementation.
- Existing HTTP/cloud-function backend retained; no WebSocket dependency or unified Rust/WASM backend added.

See `docs/studio-apps.md` and `docs/studio-workspaces.md` for usage and operational details.
