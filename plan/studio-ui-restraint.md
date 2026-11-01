# Studio UI restraint

Scope: simplify secondary labels and explanatory copy across Creator Studio without changing content, persistence or publishing behavior. Keep bilingual UI, accessible control names, errors, review requirements and destructive-action explanations.

- [x] Remove repetitive page eyebrows/subtitles and decorative control state captions.
- [x] Reduce editor/media guidance; show relevant constraints in context.
- [x] Align native connection/API/sync forms and group related controls visually.
- [x] Inspect desktop/mobile and English screenshots; run UI regression, typecheck and code review.
- [x] Rebuild local macOS App; no commit, push or deployment.


## Verification — 2026-10-31

- Studio build and TypeScript check pass; 183 Studio tests pass.
- Web browser regression and React lifecycle pass: settings, multilingual UI, forms, media, upload, editor, draft recovery and save conflicts.
- Final production native UI regression passes with desktop/mobile screenshots of connection, dashboard, notes, topics, site settings, editor, media, synchronization and client API. English API screenshots confirm notices follow language changes; no horizontal overflow.
- Independent review passes. Retained contextual shared-setting effects, translation review, upload persistence, error messages and session-key lifetime.
- Normal macOS debug App rebuilt and bundled without smoke-test injection. No commit, push or deployment; personal blog checkout unchanged.

Screenshots: `apps/studio/test-results/native-ui/` (API settings, site settings, dashboard and notes desktop/mobile).
