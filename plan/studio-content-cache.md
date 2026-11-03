# Studio native content summary cache

## Plan

1. Inspect native transport, ContentService reads and UI refresh callers.
2. Cache only `/api/content` summaries in each transport lifetime; deduplicate pending scans, return independent Responses, and keep document/revision reads unchanged.
3. Invalidate before and after content/settings writes, deletes, manual/AI translations, workspace sync and logout; invalidate on explicit refresh. Prevent old in-flight scans and scans during mutations from populating the next generation.
4. Update explicit UI reload actions and add regression coverage for navigation, concurrency, failure retry, mutations, isolation, and external edits.
5. Review diff only locally. Build/typecheck/tests and native performance validation must run remotely after authorization; no commit or push in this task.

## Implementation review

Implemented transport-local summary promise reuse with before/finally invalidation and mutation-time cache suppression. Existing library/dashboard refresh requests already use `refresh=1`; editor/settings relation retries and thread/localized context retries now do too. Revision watchers remain ordinary loads. Added regression tests in `apps/studio/tests/content-cache.test.ts` for dedupe, independent response bodies, external refresh, live revisions/conflicts, save/delete/manual translation/settings invalidation, scan retry, isolated transports/workspaces, late refresh completion, partial AI translation failure, and reads during failed sync.

Local validation: `git diff --check` passed. No dependencies installed, tests/builds executed, commits or pushes made. Remote plan: run Studio typecheck and unit tests (including portable browser bundle test), then Studio browser refresh/navigation regression. On iOS TestFlight compare first entry, repeated page switches, explicit external-edit refresh and post-sync navigation with the same repository; report measured timings and memory rather than assuming all page-switch costs disappear.

This plan directory is ignored by the repository; durable design notes are also in `apps/studio/core/README.md`.

## Boundaries

No persistent cache, secrets, repository read cache, filesystem watcher, or Node HTTP behavior changes. First scan and explicit refresh still traverse the repository and use the existing bounded reads/task yielding. External edits require explicit refresh; a request already underway may return its earlier snapshot, but cannot seed the subsequent cache. Separate transport instances do not share invalidations. Actual iOS latency and memory improvements remain unmeasured.
