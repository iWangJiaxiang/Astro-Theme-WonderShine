# Studio React UI

The entry point mounts React DOM. All components render React elements; there is no Vue runtime or Vue compiler in the dependency tree. Vite uses the React plugin.

`reactivity.ts` adapts observable editor state to Preact Signals for React, which subscribes through React's external-store mechanism. Existing editor controllers keep their tested save/recovery/translation flows. Only plain records and arrays receive nested change tracking; DOM handles, files, maps and sets retain their native identity. `react-component.tsx` creates controllers after React commits and owns their effects, context, imperative editor handle and cleanup. StrictMode/Fast Refresh effect reactivation creates a fresh controller, including watcher subscriptions and async guards. Abandoned renders never create controllers. Render functions produce normal React elements, so regular function components and React hooks can be added alongside them. The application is a browser/WebView UI, not an SSR entry point.

New platform components may use ordinary React hooks. Call `useSignals()` from `reactivity.ts` when rendering shared observable state such as `session.value` or translated labels. Keep content rules and storage protocols outside this directory.

`api.ts` provides the default same-origin HTTP transport and `setApiTransport()` for the native shell. Authentication/CSRF and error handling remain in one place. API transport injection does not change the contract used by editors.

Verification:

- `npm run typecheck -w @wondershine/studio`
- `npm run build -w @wondershine/studio`
- `npm run test:browser -w @wondershine/studio`
- `STUDIO_TEST_DEV=1 npm run test:browser -w @wondershine/studio` also checks the Vite development path.
- `tests/browser/react-lifecycle.mjs` exercises actual React StrictMode, real unmount/remount, prop changes and abandoned Suspense renders in Chromium.
- `tests/reactivity.test.ts` protects nested draft mutation, watcher isolation, batching and lifecycle disposal.
