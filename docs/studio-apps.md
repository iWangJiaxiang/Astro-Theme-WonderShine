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

## Cross-platform content loading

Native content reads combine fresh path/symlink checks with file metadata and bounded reads instead of repeating the same checks at both repository and filesystem layers. Directory enumeration reuses native entry types for discovery, but every subsequent read or recursive traversal rechecks its path. Checks are never cached across operations. Generic filesystem adapters retain the previous fallback checks. Checkout also reuses metadata already obtained during each `stat` operation, but still performs fresh per-component checks when writing.

Studio no longer derives document revisions by hashing file contents. Local files use opaque versions backed by exact text baselines; saves still read the actual file inside the repository write lock. Online Git uses the existing committed blob identity, scoped to repository, branch and path, so reads and saves do not require the same server process. Git object integrity, authentication/PKCE and stable workspace/path identity hashes remain unchanged.

Summary scans and relationship guards use fresh text-only reads without populating document baselines. The shared summary index retains compact facts, updates existing documents from actual successful repository writes, and reprojects configuration changes without rereading every Markdown file. New paths trigger a fresh scan to preserve repository enumeration order. Overlapping or uncertain writes and Git synchronization invalidate the index. Malformed article references are normalized to an empty summary reference list rather than retaining arbitrary metadata; this does not rewrite source documents.

Persistent summary previews are private, bounded, display-only data. Even a clean preview is an **unverified previous result**, never a save revision or proof that external files are unchanged. Reopening and explicit refresh still reconcile actual files. There is no public static content cache or cloud Blob preview adapter. Initial verified listing still scans content; this is not a shallow clone, and Git still downloads the selected branch's full history without recursively downloading submodules.

Old SHA-based drafts and expired/evicted baseline tokens are not silently upgraded to the latest revision. Keep the draft, reload the actual document and merge changes before saving. Draft form values alone cannot reconstruct the complete original document or inherited settings dependencies.

Ordinary Git status queries do not capture file contents. Entering the confirmation step creates a private, temporary, exact-byte review using bounded chunks. Commit and sync validate that review under the workspace lock; expiry or changed files require a new review. After committing, synchronization requires a separate confirmation of the new state. External editors do not participate in Studio's lock, so this does not eliminate every filesystem race between validation and Git staging.

These changes require remote regression verification and platform-specific measurements. Reduced parsing, hashing or duplicate requests alone is not evidence of lower device latency or memory usage.

## Native loading diagnostics

Native connections keep one bounded, local-only timing report at localStorage key `wondershine.native.load-diagnostics.v1`. It contains fixed stage names, counts and elapsed milliseconds only: Git open, recovery, content-list requests and recognized Git progress phases. It contains no repository URL, file paths, account identity, credentials, content or raw errors, and is never uploaded automatically. Starting another native connection replaces the report; disposed connections stop updating it. There is not yet an in-app report export UI.

Git phase timings are wall-clock intervals between progress transitions, not exclusive CPU measurements. Content-request timing includes the transport response construction, not React rendering; repeated requests may hit the existing in-memory cache. These measurements can locate a bottleneck but do not themselves demonstrate a device speedup. Progress callbacks to the UI are limited to roughly ten updates per second, except phase changes and completion events.

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

The installed App supports GitHub and CNB device authorization and account repository selection. The maintainer supplies public Client IDs through `VITE_STUDIO_GITHUB_CLIENT_ID` and `VITE_STUDIO_CNB_CLIENT_ID`; no client secret or Studio service participates. GitHub requires Device Flow enabled and requests `repo` access for private repository editing. The CNB application needs device authorization enabled and the `account-profile:r`, `account-engage:r`, `repo-basic-info:r`, and `repo-code:rw` permissions. Authorization and repository API calls go directly to the selected platform. Tokens remain in the current connection only; restarting requires sign-in again. Builds without a Client ID show sign-in as unavailable and continue to support manual Git remotes.

CNB uses `POST https://cnb.cool/oauth2/device/auth` with a form-encoded `client_id`, then `POST https://cnb.cool/oauth2/token` with `client_id`, `device_code`, and the RFC 8628 `grant_type`. As in the official CNB CLI, the device request does not supply `scope`; permissions must be approved on the CNB application. A GitHub Actions variable only embeds the public identifier: it does not register or enable the application on CNB. If CNB returns `invalid_client` or `unauthorized_client`, contact the CNB application administrator to verify the exact issued Client ID, application approval/status, and public-client device authorization support. Do not add a client secret to the App or switch to authorization-code endpoints as a workaround. See [CNB OAuth registration](https://docs.cnb.cool/zh/oauth/developer.html) and [CNB CLI](https://docs.cnb.cool/zh/develops/cnb-cli.html). Do not paste raw OAuth response bodies, device grants, or tokens into support logs.

Provider login errors distinguish device authorization, token polling, account profile, and repository listing (`stage=device/token/account/repos`). Diagnostics show the HTTP status (or `HTTP=unavailable` for transport failures) and only format-validated `x-trace-id`, `traceparent`, or `x-github-request-id` response headers. Do not share raw response bodies or credentials. A browser approval screen alone does not prove token exchange or account/repository access succeeded. An unauthenticated device-flow check on 2026-11-05 observed CNB `400 authorization_pending`, which the existing poller supports; authorized flows still require device acceptance. A token result clears the device code before account loading, and terminal failures no longer display an active authorization wait or a false empty repository list.

CNB account/repository discovery uses the native `cnb_account_get` command for exactly `GET https://api.cnb.cool/user` and `GET https://api.cnb.cool/user/repos?page_size=100&page=N&role=Developer&status=active` (pages 1–1,000,000). The HTTP plugin otherwise adds the WebView Origin; CNB can reject that Origin even when the same Bearer token works without it. The command takes a resource selector, page and in-memory token, not a caller-provided URL or headers. A separate reqwest client sends no Origin or cookies, keeps normal TLS verification, requires HTTPS and refuses every redirect. It does not spoof a trusted Origin or enable `unsafe-headers`. CNB OAuth POSTs, GitHub, generic Git, AI and Studio server transport are unchanged.

The command permission is granted only to the bundled local `main` WebView, with no remote-origin or desktop-only exemption (iOS/Android use the same ACL). Native work is capped at four concurrent requests, 10 seconds to connect, 30 seconds total and 2 MiB per successful response. Error/redirect bodies are discarded; only HTTP status and format-validated CNB trace headers cross back for diagnostics. Oversized/invalid bodies retain status but fail parsing safely. Cancellation immediately rejects the frontend operation and discards late results; it does **not** interrupt an already-issued native request, which finishes or hits its timeout. Tokens are not persisted or logged by this command.

Regression coverage includes the actual JS adapter/IPC contract and Rust loopback HTTP tests asserting absence of Origin/cookies and refusal to follow redirects. The loopback destination/HTTP override exists only in Rust test code, never in production command parameters. The Rust tests are included in the existing `http_permissions` CI target. Browser IPC fixtures are not native transport or live iOS acceptance; runner-side compile/tests and real-device CNB sign-in remain necessary before claiming the fix is verified.

Provider-specific discovery is separate from the generic Git transport. Other Git providers continue to use explicit remote URLs. PR/MR and deployment-status APIs remain unimplemented. Automated tests use fixture credentials only; real account authorization needs a configured provider application.

On mobile, the installed App applies safe-area spacing, touch targets, 16px editing controls, pinch-zoom restrictions and keyboard-aware dialogs. The web edition retains browser zoom. CI checks the generated AppIcon catalog and captures an installed iOS simulator launch; physical-device gesture, keyboard and accessibility acceptance remains separate.

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
