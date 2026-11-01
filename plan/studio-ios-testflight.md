# Independent iOS / TestFlight distribution

User scope: TestFlight must depend only on iOS build and Studio verification, without desktop/Android build or signing requirements. Keep Apple account identifiers in Secrets. All builds and tests run in remote CI.

## Design

- Extend the existing Studio workflow with a manual `target` choice: `all` (existing behavior) or `ios`.
- `target=ios, publish=false`: Studio verification and unsigned iOS simulator build only.
- `target=ios, publish=true`: Studio verification, signed iOS build, TestFlight upload; no GitHub Release or desktop/Android jobs. Only Apple Secrets are required.
- Keep `studio-v*` Release behavior for full-platform distribution. Its optional TestFlight job depends on verification and iOS only, so other platform failures do not block Apple upload.
- Separate publication metadata checks from platform signing checks. Android and Apple credentials are checked within their own build jobs before expensive work starts.
- Keep one workflow and build-number sequence for both iOS paths. Existing artifact collection and API-key upload remain shared.

## Checklist

- [x] Regression cases for manual target selection, safe push/PR behavior and per-platform credential validation.
- [x] Workflow and release-context implementation; documentation and Secret configuration guidance.
- [ ] Static review, push, remote iOS-only verification and simulator build; confirm other platform jobs are skipped.
- [ ] Record actual CI results and the unverified real-signing/TestFlight boundary.

Real Apple upload is not part of the test run: validation uses `publish=false`, fixtures and an unsigned simulator build. Do not read or print account identifiers or credential values.
