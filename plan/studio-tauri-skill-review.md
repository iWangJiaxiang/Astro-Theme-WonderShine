# Studio Tauri skill review

## Scope

Apply `full-stack-skills/tauri-skills` at revision `77b57c4913873a0f8cab7db45116038dc18a27f0` to the existing Studio. Read the `tauri` router and the build, mobile, config, security, filesystem, persisted-scope and single-instance guides. Treat example snippets as guidance; verify APIs against the actual installed Tauri 2 sources. No Node sidecar, new secret persistence or automatic installer is required.

All builds, unit tests and browser tests run on GitHub Actions. Local work is limited to source edits and static inspection.

## Changes

- [x] Restore and show the desktop window before focusing it on a second launch.
- [x] Keep unsupported arbitrary-folder selection out of the mobile connection UI; returning from a remote service uses the repository URL flow.
- [x] Load repository inspection, Git/content runtime and remote-service transport on demand, after the user chooses a connection. Module loading remains inside the existing error and busy handling.
- [x] Add remote browser coverage for deferred loading and mobile return navigation.
- [x] Include the pending update-button contrast fix and its browser regression check.
- [x] Independent static review and final remote CI verification: `41266411593` passed at `a6bcd9e`.

## Reviewed boundaries

- Filesystem access remains limited to AppData workspaces and user-selected desktop folders. Desktop grants persist through the existing persisted-scope plugin.
- Desktop-only plugins remain gated out of Android/iOS. Mobile stores cloned repositories in app storage.
- CSP is enabled; Git transport validates the configured origin and disables redirects. HTTPS host scope remains broad to support user-configured Git/AI services; loopback HTTP supports local services.
- Session credentials are not persisted. Adding Stronghold would change the current credential policy and is outside this pass.
- App updates remain notifications with a restricted external download link. Signed automatic installation requires a separate signing/distribution decision.
- No unmeasured LTO or new plugin was added. Remote artifacts and browser results are the acceptance evidence; device startup-time improvements are not claimed without measurements.

## Baseline

Studio run `41265683995` passed at `33f5db1`: six desktop targets, Android debug APK, iOS simulator bundle and verification. Theme run `41265261166` also passed. Formal signed mobile releases have not been exercised.

## Final verification

Run `41266411593` passed for all eight packaging targets, 197 Studio tests, 4 release tests and browser regressions. The browser exercised the deferred native-runtime chunk before/after connection and the mobile service-return flow. The native-runtime chunk is 104.78 kB (32.83 kB gzip) in the CI output; this is its size, not a measured startup-time improvement. Desktop restoration compiled on all desktop targets; interactive minimized-window behavior is not covered by the headless browser suite.
