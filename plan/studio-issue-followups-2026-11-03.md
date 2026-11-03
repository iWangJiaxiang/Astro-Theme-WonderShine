# Remaining issue follow-ups

## Scope

- Blog #6: inspect editor hot paths and implement evidence-based improvements with regression tests. Real iOS reproduction and acceptance remain required; do not close based on CI alone.
- Blog #7: inspect existing workspace Git capabilities and add an explicit reviewed commit/sync action where supported. Preserve ordinary save behavior, managed-file boundaries, workspace locks and conflict detection. Never imply deployment completion.
- Blog #8: audit and improve verified onboarding and Studio operation documentation without inventing configuration.
- Blog #9: await target platforms and content requirements before implementing POSSE integrations.

## Verification

Read and review diffs locally; do not install dependencies or run builds/tests locally. Push the feature branch and run remote CI, inspect failures and UI artifacts, then merge only after required checks pass. Any later release must originate from verified main. Keep issues open where user acceptance or scope is still missing.
