# Creator Studio: Web, desktop and mobile

The Studio UI uses React/Vite. The Astro website remains a separate static build. Existing Node HTTP and cloud-function deployments are retained; neither WebSockets nor a Rust/WASM server is required.

## Implemented architecture

- `apps/studio/src`: React DOM UI; existing editor controllers integrate via Signals for React. New components can use ordinary React hooks. No Vue runtime is shipped.
- `apps/studio/core`: shared content rules, TOML-preserving edits, multilingual content, validation and an in-process transport. Server modules reexport these rules, and network deployments retain authentication, authorization and CSRF checks.
- `apps/studio/shared/repository.ts`: content storage contract, independent of Node.
- `apps/studio/platform`: filesystem, Git engine, hosting-provider capabilities, API transports and connection screens.
- `apps/studio/src-tauri`: desktop/mobile app shell using filesystem and HTTPS plugins. No Node sidecar. `buffer` supplies byte-array compatibility required by isomorphic-git; it is not a Node runtime.

## Connection modes

**Local folder (desktop)** opens an existing blog Git repository in place through the system directory picker. It detects the checked-out branch, origin and repository-local author identity; it does not clone, checkout or copy content to AppData. A missing author identity can be supplied under connection settings before committing. Repositories without a remote, or with an SSH remote, can be edited and committed offline; built-in synchronization requires an HTTPS origin. The chosen directory must contain a normal `.git/` directory, `content/`, `config.toml` and `data.toml`. Worktree/submodule roots, detached HEAD and symlinked repositories are rejected. Writes are blocked during merges, rebases and other unfinished Git operations. Status reads preserve the index. Recovery journals live in AppData under a path-derived workspace ID; moving the repository does not migrate its previous recovery state.

Filesystem and image-preview permissions are granted by the directory picker and persisted across desktop restarts. No blanket filesystem permission is requested. Mobile platforms use the remote repository workflow below instead of arbitrary folder access.

The connection screen loads repository inspection and the Git/content runtime only after a folder is selected or a workspace is opened. Mobile hides the unsupported desktop folder option; returning from a Studio server connection returns to the repository URL form.

**Remote repository** accepts a pasted HTTPS Git URL and downloads a complete single-branch repository into the App data directory. Leave Branch empty to follow the remote default branch, or specify a branch under Connection & commit settings. The detected branch is saved after the first successful download; reopening never switches it silently. The connection screen shows real Git phases and per-phase progress, with an indeterminate bar before progress is available. Failed downloads can be retried. It reopens offline, saves files on-device, and commits without a network. Sync is explicit. Entering an HTTPS Git URL works independently of hosting-provider APIs; GitHub, GitLab, CNB, Gitee, Gitea, Forgejo and generic/self-hosted services are selectable. Tokens are held only in memory for the current connection and are never saved in profiles or Git config. Reconnect with a token before private-remote synchronization if the workspace was opened offline.

**Connect to your Studio** opens the same bundled UI against a user-owned HTTPS server. Password login uses the existing server session and CSRF protocol; the native transport retains the session cookie in memory, limits requests to that origin, and refuses redirects. Content is saved by the server. This mode does not clone a local repository. Editor recovery drafts retain their existing local storage behavior and are isolated by server origin. OIDC in a native app still needs a dedicated callback flow; use the Web UI for OIDC today.

Web users continue to use the existing local-server or cloud-function deployment. Persistent server workspaces are optional; see [studio-workspaces.md](studio-workspaces.md).

## Save and synchronize

1. **Save** updates files on the device (or selected server), without implying a Git push.
2. **Commit locally** records only allowed content/configuration/media changes. Unrelated staged files must be handled in an external Git tool.
3. **Sync Git** fetches, fast-forwards when safe, and pushes without force. Dirty or diverged workspaces stop with an explanation; local work remains intact.
4. Website deployment status remains independent of Git synchronization.

Local transaction journals and history backups live outside the native Git checkout. Interrupted writes are recovered only when current bytes match either the previous or attempted value. External edits after a crash block automatic recovery. Interrupted fast-forward operations retain a sync journal and block further mutation until the repository is inspected. No automatic hard reset, forced push or deletion of offline commits occurs.

Downloaded repositories use the private App data directory; selected desktop repositories stay in their original location. The App does not yet provide a visual merge resolver, Git LFS, submodule management, background mobile synchronization or secure persistent token storage. Do not uninstall the App before syncing/backing up offline work. Native direct mode supports manual and AI translations, AI summaries and cover generation through client-configured OpenAI-compatible endpoints. Server mode continues to use the server operator’s AI configuration.

## Client API configuration (direct Git mode)

Open **Client API settings** after connecting a local Git workspace. Enter the provider base URL (usually ending in `/v1`), text model, optional image model, image size, and API key. The text model serves summaries, cover prompts and translations. An empty image model disables image generation. This version uses one endpoint/key for both text and images.

HTTPS endpoints and loopback HTTP providers (`localhost`, `127.0.0.1`, `[::1]`) are supported through Tauri HTTP. Requests never follow redirects. No WebSocket or local Node service is needed for AI requests. The image provider must return `b64_json`; the App validates images before saving them through the existing media workflow.

Endpoint/model preferences are stored per workspace on this device, outside Git. API keys stay in memory for the current connection and are cleared on disconnect or App restart; the settings screen never returns the key. Changing the endpoint without providing a new key disables generation until a key is entered. The clear-key button removes the active key immediately. AI generation requires connectivity even when content editing is offline.

AI sends the selected article content to the configured provider only when generation is requested. Summary and cover results are previewed before application; translated versions remain drafts with the existing AI provenance and review requirements. Disconnect cancels outstanding requests, and a late translation cannot write to the disconnected workspace.

## Development and builds

Builds, packaging and tests now run only on remote GitHub Actions runners. See [Studio releases](studio-releases.md) for supported artifacts and distribution boundaries. The workflow initializes ignored Android/iOS native projects on its runners. Local machines do not need the mobile SDKs.

For a lightweight local UI preview, run `npm run dev:app -w @wondershine/studio`. It starts Vite without invoking Cargo or packaging. Native capabilities require the App produced by CI. Desktop runs a single instance to protect local workspace operations; launching it again shows, restores and focuses the existing window.

## Verification

The following commands are runner-side references, not local verification instructions. The workflow invokes the relevant checks remotely.

```sh
npm run typecheck -w @wondershine/studio
npm run test -w @wondershine/studio
npm run build -w @wondershine/studio
npm run test:browser -w @wondershine/studio
npm run test:native-browser -w @wondershine/studio
node apps/studio/tests/browser/native-ui.mjs
```

Native engine integration tests run actual Git smart-HTTP against temporary bare repositories and cover offline reopen, commits, fast-forward, rejected pushes, divergence and interrupted operations. Browser tests execute the portable core without Node globals and normalize filesystem statistics through the actual Tauri adapter. Full native UI tests use the configured CSP and an IPC fixture; they are not a substitute for real iOS/Android devices or live hosting-provider authentication tests.

Provider capabilities currently advertise only Git protocol access. OAuth, repository discovery, PR/MR and deployment-status APIs remain disabled rather than exposing nonfunctional buttons. Real provider credentials are never used by automated tests.

### Actual macOS WebView acceptance test

This additional acceptance suite needs a remote macOS runner with a graphical session. It is not currently part of the default hosted-runner workflow. Do not run it on the development machine. On a suitable remote runner, build the offline frontend and explicit debug test feature:

```sh
npm run build:app -w @wondershine/studio
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build --locked --manifest-path apps/studio/src-tauri/Cargo.toml --features custom-protocol,native-smoke
npm run test:native-macos -w @wondershine/studio
STUDIO_NATIVE_SMOKE_LOCAL=1 npm run test:native-macos -w @wondershine/studio
```

This needs a graphical macOS login session. It runs the real WebView, filesystem, HTTP and Git adapters against an isolated AppData Git fixture and a loopback OpenAI-compatible provider. It tests editing, AI summaries, cover generation, translation review metadata, local commits, reconnect and key clearing; it never pushes Git. A separate test App identifier and a nonpersistent WebView store isolate test preferences from the normal App even if the test crashes. The runner handles interruption signals, bounds child-process shutdown, and removes its Git fixture afterward. `test-results/native-macos/result.json` records results. Dialog confirmations are automatically accepted inside the isolated fixture. Test windows disable background throttling so automation can continue when another window has focus; normal App windows retain platform defaults.

The local variant uses an external temporary repository and restarts the process to check persisted filesystem and image-preview permissions. The smoke-only Rust setup emulates the directory permission grant; it does not automate the OS folder-picker dialog itself.

The `native-smoke` runner is gated by both an explicit Cargo feature and debug assertions; ordinary and release builds do not load test configuration or inject test scripts. Rebuild without `native-smoke` before packaging an App for use.

### Responsive form screenshot audit

On a remote runner, after building the Studio frontend and server, run from the repository root:

```sh
npx tsx apps/studio/tests/browser/form-audit.mjs
node apps/studio/tests/browser/native-ui.mjs
```

The first command uses a temporary demo site and captures form pages and dialogs at 1440, 1024 and 390 pixels. It checks viewport overflow, compressed controls and sidebar obstruction, and records browser errors. The second covers App initialization, local selection/cancellation, offline editing and client API forms with a test IPC host. Screenshots and JSON reports remain in `apps/studio/test-results/`; inspect them visually as well as checking automated results. No personal site or live provider is used.

### Save destinations

The save split button supports local files and an independent local Git branch for native workspaces. Its menu can remember a per-workspace default; autosave uses the current selection. Branch saves keep the active branch and index unchanged and do not push or merge. See [保存方式与默认值](studio-workspaces.md#保存方式与默认值) for deployment capabilities, partial-save recovery and the manual PR handoff.
