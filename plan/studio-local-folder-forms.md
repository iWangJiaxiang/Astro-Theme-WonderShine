# App local repositories and form audit

- [x] Add explicit local-folder and remote-URL entry paths, retaining self-hosted Studio login.
- [x] Open selected desktop repositories in place; detect branch, origin and commit identity without cloning or checking out. Keep recovery state outside the repository. Support offline repositories with no HTTPS remote.
- [x] Grant access only through the native directory picker; retain selected-folder access across restarts. Preserve existing cached clone profiles.
- [x] Test local open/save/commit, invalid paths, cancellation and existing remote workflow.
- [x] Capture and inspect form pages and dialogs at desktop, medium and mobile widths; fix clipping, overflow and alignment.
- [x] Build/typecheck, run relevant regressions, review changes and record verified boundaries.

Keep existing edits, personal repositories and running app data intact. No pushes or publication. Use temporary test repositories. Avoid incremental Rust debug caches due to disk constraints.

## Final acceptance (2026-11-01)

- Round 1: native local/remote initialization; compact responsive forms; stable React ref lifecycle.
- Round 2: mobile first-launch remote entry; upload-label grid overlap; English autosave option.
- Final visual pass also separated medium-width editor headings from action buttons; a width assertion catches squeezed titles.
- Main screenshot audit: 46 scenarios × 3 widths = 138 screenshots, no overflow, compressed controls, label overlap or browser errors.
- Native browser audit: folder selection/cancellation, existing cloned profiles, offline save, API forms and actual mobile UA, including English.
- Unit tests: 185 passed; TypeScript and frontend build passed.
- Real macOS acceptance: external local repository saved and committed in place; API requests used a local fixture; restart without a new permission grant restored filesystem and image access. Existing downloaded-workspace flow also passed.
- Smoke code uses a separate App identifier and is excluded from ordinary/release builds. OS directory-dialog clicks and Android/iOS devices remain outside automated acceptance.
- Last-round screenshots only: `apps/studio/test-results/form-audit/` and `apps/studio/test-results/native-ui/`.
- Technology decisions: `docs/studio-technology.md`. Onboarding and migration docs updated.

Full integration rerun passed, including Astro rendering and React StrictMode. The fixture uses a fixed past publication date so UTC-midnight scheduling cannot suppress the test article.

Ordinary macOS debug App packaged locally without signing or publication; test-injection feature excluded.
