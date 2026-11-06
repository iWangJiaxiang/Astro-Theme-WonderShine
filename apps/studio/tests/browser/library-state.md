# Library context restoration (remote validation)

`ContentLibrary` uses `library-state.ts` for memory-only restoration. No App prop or router/history change is required. The key is `[session.identity.method, session.identity.id, saveContext.scope]`; only one active account/workspace is retained. Each list kind remembers its last content language and independent search/status/folder/page for each language. Logout or any context change erases the entire memory and invalidates old component leases, including while the library is unmounted. Token renewal with the same identity/scope does not clear it.

The existing `saveContext.scope` comes from successful App bootstrap (`identity.id` plus repository save scope). Empty/unconfigured scope disables storage. A new bootstrap scope observed by an already-mounted library resets only list controls and starts fresh reads; outgoing async reads cannot update or write the new context. New-create dialog state is not cached and mutation/draft guards remain unchanged.

## Remote checks

The helper unit tests are included in the existing `apps/studio/tests/*.test.ts` glob (`tests/library-state.test.ts`). Run the normal Studio tests and typecheck in CI, not locally. Browser follow-up:

1. Prepare >40 articles, at least two content languages, and nested collection sections.
2. Choose a language, search text and draft/published filter; select page 2 or 3. Open a row, then use the existing editor back action. Verify all controls and visible rows return together; existing App scroll restoration should now have the correct rows available. Also hold the returning `/api/content` read and type into the rendered search or change status before releasing it: explicit field edits (including clearing search or selecting All) must win over the cached values and reset pagination to 1, while untouched filters and the saved language still restore. The search DOM node/focus must remain unchanged; `navigation-context.mjs` already exercises the delayed-search case without any navigation test changes.
3. Change to another content language, use different filters/page/folder, switch back. Each language resumes its own context, and remount resumes the last selected language.
4. Remove matching rows or the selected section through a second fixture client, return/refresh. Page clamps to the new last page; a missing section falls back to the language root without clearing search/status. Remove a configured language: selected language falls back to the current default.
5. Logout/login, switch account (including equal IDs with a different auth method), or switch workspace. No list search/state may carry across. Also switch context while a list load is delayed and while no list is mounted; old completion/unmount must not resurrect the outgoing state.
6. Reauthenticate the same identity while a dialog is open: editor/modal remain mounted, and returning to library keeps list state. Verify draft and in-flight mutation navigation guards still refuse unsafe departure.

The legacy unstamped `props.folder` is not used to seed a new scoped list: App may retain that prop across logout, so an absent scoped snapshot starts at the language root. `browse` still reports the resolved restored folder to App. A future explicit programmatic folder-navigation API should carry a workspace/context stamp rather than reuse that legacy fallback. No data is written to localStorage/sessionStorage or URLs. This does not restore scroll or a disconnected row's focus itself; App's `navigation-position.ts` owns that behavior.
