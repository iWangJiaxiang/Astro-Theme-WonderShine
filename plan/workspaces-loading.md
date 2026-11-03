# Workspace selection and loading responsiveness

## Requirements
- Fix avoidable main-thread work while native content loading is displayed; do not claim device resolution without actual acceptance.
- Introduce multiple named workspaces with local and remote repositories coexisting, preserving existing setup and user data.
- Separate credentials, drafts and async results by workspace; guard unsaved edits during switching and never delete repository data implicitly.

## Execution
1. Reduce verified content-list overhead: linear language grouping, bounded native reads, cooperative task yielding and regression tests.
2. Inspect workspace persistence and implement selection/migration with isolation tests after architecture review.
3. Review diffs, push remote CI only, inspect browser evidence and resolve failures.
4. Merge verified changes before any distribution. User requested TestFlight-only distribution, no new GitHub Release or tags.

No local installs, builds or tests. Existing TestFlight build 51.1 maps to verified main e9ff6fe via run 41581861174; reports of loading stalls remain unresolved.
