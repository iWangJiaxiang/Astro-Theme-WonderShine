# Scoped content loading responsiveness

## Scope

- Current branch: `feat/studio-workspaces-loading`.
- Replace repeated translation-group scans with a per-list index; preserve sorted languages, duplicates, input order and malformed-document repair entries.
- Yield to real timer tasks during summary computation, using both a time budget and an item cap. No cache or setup/runtime changes.
- Bound native FileRepository list reads; retain read() safety and revision behavior, ordering and missing-file filtering. Stop scheduling after failures and drain in-flight reads.
- Leave splitDocument's delimiter validation unchanged for this focused change.

## Verification

Added focused scheduler responsiveness, grouping semantics, bounded-read and safety regressions in `apps/studio/tests/content-loading.test.ts` and `apps/studio/tests/native-files.test.ts`. Source/diff inspection completed; `git diff --check` passed. No local tests, builds or dependency installation performed. Tests, type checks, builds and native scrolling acceptance remain for remote CI/device verification. Existing TestFlight 51.1 source e9ff6fe / run41581861174 is baseline evidence, not verification of these edits.

Implementation uses a real timer task after 32 work items or 8 ms (checked between synchronous operations), and batches of at most eight full read() calls. Failed read batches settle before rejection; later batches do not start. Group indexing is linear, plus per-group sorting and the unavoidable output-array copying needed to preserve the API. Individual document parsing and an individual group sort remain synchronous; this is cooperative scheduling, not a worker or a hard frame-time guarantee. Existing delimiter parsing is unchanged, including its second metadata parse.
