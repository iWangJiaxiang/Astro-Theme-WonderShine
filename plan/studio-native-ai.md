# Native Studio API configuration and local verification

Approved scope: test the actual macOS App locally and let direct Git users configure an OpenAI-compatible API in the client. Keep the existing HTTP backend; no deployment or remote Git push.

Design: reuse portable AI text/image and translation services. A workspace-scoped native controller owns endpoint/model configuration and session-only keys, exposes redacted settings to React, and calls providers through Tauri HTTP. Settings never enter the content repository. Preserve translation review and preview-before-apply behavior. Support HTTPS and loopback HTTP for local providers.

- [x] Test configuration validation, key redaction/persistence, text/image/translation, disabled services and cancellation.
- [x] Move AI service into the portable core; add native configuration controller and transport endpoints.
- [x] Add bilingual client API settings and native HTTP permissions for loopback providers.
- [x] Verify actual macOS app launch, Git workspace editing, local commit, reconnect, AI configuration and generation using a local fixture provider.
- [x] Run focused regressions, production build, independent code review, and document actual coverage.

Important boundaries: no real API credentials supplied and no paid generation without user configuration. Use fixture responses for reproducible API tests; report them separately from live provider validation. Preserve personal blog checkout and theme submodule pointer.


## Verification completed — 2026-10-31

- `npm test`: 257 passing tests (73 theme, 183 Studio, 1 migration).
- `npm run check`: Astro and Studio TypeScript pass.
- Web UI, React lifecycle, portable native core and production native UI/CSP regressions pass.
- Actual macOS WebView, with real Tauri filesystem/HTTP/Git plugins and no IPC mocks: offline open, save, AI summary, cover prompt/image, translation draft/review provenance, local commit, reconnect and session-key clearing pass. Results: `apps/studio/test-results/native-macos/result.json`.
- Local OpenAI-compatible fixture received all four expected requests. No real provider credentials, paid generation or remote Git push used; real-provider authentication and mobile devices remain unverified.
- Fixed HTTP permission parsing for IPv6 loopback and explicit HTTPS ports. Rust permission regression test passes.
- Native acceptance uses a nonpersistent WebView data store. Missing binary, SIGINT and SIGTERM all report failure and remove their fixture. Independent review found no remaining blockers.
- Rebuilt and bundled the normal macOS debug App without the native-smoke feature. Test injection markers are absent from the delivered executable.
- Removed verified temporary fixtures/profiles and diagnostic files; stopped the temporary provider. Personal blog checkout remains clean; no commit, push or deployment.

Client configuration: endpoint/models persist per workspace outside Git; keys stay in memory and must be entered after reconnect/restart. One endpoint/key serves text and image requests; image responses require b64_json.
