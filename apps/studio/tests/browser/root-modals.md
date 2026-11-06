# Root modal regression (remote CI only)

The independent entry point is `root-modals-runner.mjs`. It runs all three `ROOT_MODAL_OUTCOMES`: `resume`, `cancel-before-release`, and `unmount-after-defer`. Each outcome starts its own **already-built** Studio server, disposable site/state directories and browser, authenticates with a random fixture password, creates six series to exercise SelectionField's native chooser, and invokes `checkRootModals`. It does not build Studio/Astro and does not contact real AI services.

Each service instance repeats the full creation, AI and DELETE prerequisites before one delayed outcome. Its four logins (initial + AI + DELETE + delayed) remain below the unmodified production limit of five attempts per 60 seconds; successful logins count toward that limit. Authentication must return HTTP 200 before checking removal of the blocking reauthentication dialog. A rejection fails immediately without retrying or waiting out the limit. Outcome failures are aggregated rather than silently skipping the remaining fixtures. The existing navigation-context suite runs once in the `resume` fixture after modal checks; that suite reloads the application and establishes its own editor state, not the exact mounted modal-suite editor.

The remote Linux runner bounds each outcome with a 70-second worker deadline. Its worker, HTTP service and explicitly spawned Chrome share a process group, so a deadline terminates the actual pending work rather than only abandoning a Promise. Spawn errors are captured, fetches and failure screenshots have deadlines, teardown escalates from SIGTERM to SIGKILL, and disposable directory removal runs in a bounded cleanup process. Including parent cleanup, the three outcomes have a planned ceiling of approximately 225 seconds within the existing five-minute CI step cap. Deadline or cleanup failures remain failures; the remaining independent outcomes are still attempted. Runtime process termination and timing require remote verification.

## Integration

After the existing remote CI Studio production build and Chromium setup, add this step from the repository root:

```yaml
- name: Studio root modal regressions
  working-directory: apps/studio
  run: npx tsx tests/browser/root-modals-runner.mjs
```

Use the same `STUDIO_TEST_BROWSER` as the existing browser job. No package.json or smoke.mjs edits are needed. Preserve/upload `apps/studio/test-results/root-modals/<outcome>/` with the existing browser artifacts, including on failure. Screenshots such as `root-modal-failure.png` are isolated by outcome. Do not run this on a personal site or locally under the repository's remote-validation policy.

Alternatively import `checkRootModals({ page, origin, password, screenshots, outcome })` and the fixed `ROOT_MODAL_OUTCOMES` list. The `outcome` argument is required and must be a member of that list. Run every outcome against a **separate service instance, site/state and fresh authenticated Chinese-language page**, with an Example article at `content/articles/example/index.md` and six collection-detail sections `modal-collection-0` through `modal-collection-5`. Merely replacing the browser context does not reset the service's in-memory login limiter. The helper owns request interception for that page and deliberately expires the fixture session three times (AI, DELETE and one delayed outcome). Do not use smoke.mjs's shared/intercepted page.

## Assertions

- Creation dialog is native `:modal`, has a resolvable accessible title and initial title-input focus, retains `.modal` form selectors, blocks background focus and Tab/Shift+Tab escape.
- Real backdrop pointer click keeps both the dialog and its fields; Escape and explicit Cancel restore opener focus; reopening retains title, slug and a committed series selection.
- Native SelectionField chooser opens above creation, owns Tab focus, and Escape closes only the chooser and returns to its trigger.
- Narrow 390×844 creation dialog stays within viewport and retains modal keyboard containment.
- Actual expired server session during AI generation or DELETE opens native reauthentication above the already-open native dialog. Login is labelled and blocking, background shell remains inert, lower-dialog focus attempts fail, Escape/empty-space clicks do not dismiss it.
- Password reauthentication retains the exact mounted editor DOM node and unsaved body, returns focus to the underlying dialog, does not replay AI or deletion, and preserves the stored article after rejected deletion.
- Delayed activation stays below the blocking login. After successful authentication, `resume` reopens and focuses the original mounted dialog; `cancel-before-release` and `unmount-after-defer` never reopen cancelled or disconnected owners. The editor node and unsaved draft remain intact.
- Page errors and React lifecycle/DOM warnings fail each isolated fixture and the independent runner.

## Boundaries

These sources have not been executed by the implementing subagent. CI should run the new runner plus existing Studio typecheck, smoke and React lifecycle coverage. Review desktop/mobile captures. Chromium keyboard coverage is not Safari/WebKit, physical iOS/Android, screen-reader or OIDC round-trip acceptance. The helper exercises existing mounted AI/delete dialogs rather than migrating their own lifecycles.

Creation values are intentionally retained only in the mounted ContentLibrary instance. Leaving the library, switching its kind or reloading clears this pre-editor form; it is not a persisted document draft. Native top-layer ordering is activation-order based: reauthentication opens after the failed operation dialog and supersedes it; no global priority manager for arbitrary later programmatic dialogs is added.
