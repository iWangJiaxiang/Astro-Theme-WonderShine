import { fileURLToPath } from 'node:url';

export const nativeScopeContract = Object.freeze({
  version: 1, hook: '__studioNativeScopeTraceV1',
  caps: { records: 64, bytes: 16384, faults: 8, runtimeFaults: 4, nodeFaults: 4, number: 2147483647 },
  events: ['caller-start', 'api-start', 'request-start', 'transport-return', 'api-catch', 'api-return', 'request-return', 'caller-return', 'caller-catch', 'guard', 'notice-write', 'loading-clear', 'caller-finally', 'api-finally', 'reject', 'scope-invalidate', 'transport-invalidate', 'mutation-begin', 'mutation-end', 'app-generation', 'app-unmount', 'settings-unmount'],
  owners: ['other', 'app-bootstrap', 'app-content', 'settings-main', 'settings-relations'],
  origins: ['content-scope', 'transport-reject', 'pre-json-scope', 'response-json', 'post-json-scope', 'response-status', 'request-abort', 'content-timeout', 'unclassified'],
  locales: ['en', 'zh-CN', 'other'],
  faults: ['clock', 'read', 'record', 'counter', 'context', 'snapshot', 'protocol'],
  columns: ['seq', 'time', 'event', 'owner', 'callerId', 'apiId', 'requestId', 'scope', 'transport', 'generation', 'counter', 'origin', 'responseStatus', 'errorStatus', 'guard', 'scopeMismatch', 'transportMismatch', 'aborted', 'reasonMask', 'refresh', 'locale'],
});
const virtualId = 'virtual:studio-test-native-scope-trace';
const resolvedVirtualId = `\0${virtualId}`;
const trace = '__studioNativeScope';
const targets = Object.fromEntries(['App.tsx', 'components/SettingsView.tsx', 'api.ts'].map(name => [
  fileURLToPath(new URL(`../../src/${name}`, import.meta.url)).replaceAll('\\', '/'), name,
]));

// Serialized into a build-only virtual module. Never retain business callbacks,
// promises, errors, identities, paths or tuple values from the application.
function installRuntime(untracked, contract) {
  const { caps, hook, events, owners, origins, locales } = contract;
  let session = null, context = null, installed = false;
  const fault = code => {
    try {
      if (!session) return;
      session.failed = true;
      session.faultAttempts = increment(session.faultAttempts);
      if (session.faults.length < caps.runtimeFaults) session.faults.push(contract.faults.includes(code) ? code : 'protocol');
      else session.droppedFaults = increment(session.droppedFaults);
    } catch { /* No diagnostic exception may enter application code. */ }
  };
  const increment = value => {
    if (value >= caps.number - 1) { session.saturated = session.failed = true; return caps.number; }
    return value + 1;
  };
  const active = () => installed && session?.active === true;
  const valid = token => active() && token?.session === session.id;
  const safe = (operation, fallback = null) => {
    try { return untracked(operation); } catch { fault('read'); return fallback; }
  };
  const clock = () => {
    try {
      const value = Math.round((performance.now() - session.startedAt) * 1000) / 1000;
      if (!Number.isFinite(value) || value < 0 || value >= caps.number) throw new Error();
      return value;
    } catch { fault('clock'); return null; }
  };
  const numeric = value => value === null || (Number.isSafeInteger(value) && value >= 0 && value < caps.number);
  const boolean = value => value === null || typeof value === 'boolean';
  const emit = (token, event, read) => {
    if (!active() || (token && !valid(token))) return;
    // An invocation begun before capture has no token: omit its later events.
    // A new request may start during capture under an older API; it is 'other'
    // with no captured parent. This is not complete async work-lineage tracing.
    if (!token && !['scope-invalidate', 'transport-invalidate', 'app-generation', 'app-unmount', 'settings-unmount'].includes(event)) return;
    try {
      const seq = session.attempts = increment(session.attempts);
      if (session.records.length >= caps.records || session.saturated) {
        session.droppedRecords = increment(session.droppedRecords);
        return;
      }
      // Only diagnostic getters are untracked; never a business invocation.
      const p = read ? safe(read) : {};
      if (!p) { session.droppedRecords = increment(session.droppedRecords); return; }
      const row = [seq, clock(), event, token?.owner ?? 'other', token?.caller ?? null, token?.api ?? null, token?.request ?? null,
        p.scope ?? null, p.transport ?? null, p.generation ?? null, p.counter ?? null, p.origin ?? null,
        p.responseStatus ?? null, p.errorStatus ?? null, p.guard ?? null, p.scopeMismatch ?? null,
        p.transportMismatch ?? null, p.aborted ?? null, p.reasonMask ?? null, p.refresh ?? null,
        p.locale === undefined ? null : locales.includes(p.locale) ? p.locale : 'other'];
      if (!events.includes(row[2]) || !owners.includes(row[3]) || (row[11] !== null && !origins.includes(row[11])) ||
          ![4, 5, 6, 7, 8, 9, 10, 12, 13, 18].every(i => numeric(row[i])) ||
          ![14, 15, 16, 17, 19].every(i => boolean(row[i]))) {
        fault('record'); session.droppedRecords = increment(session.droppedRecords); return;
      }
      session.records.push(row);
      if (event === 'notice-write' && (row[3] === 'app-bootstrap' || row[3] === 'app-content')) {
        session.lastObservedAppErrorWriter = row[3];
      }
    } catch {
      fault('record');
      try { session.droppedRecords = increment(session.droppedRecords); } catch { /* Sticky failure already set. */ }
    }
  };
  const allocate = (kind, owner, read) => {
    if (!active()) return null;
    try {
      const parent = kind === 'caller' ? null : context;
      if (kind !== 'caller') context = null; // A synchronous context is consumed once.
      const id = session[kind] = increment(session[kind]);
      if (session.saturated) { fault('counter'); return null; }
      const token = { session: session.id, owner: kind === 'caller' ? owner : valid(parent) ? parent.owner : 'other',
        caller: kind === 'caller' ? id : valid(parent) ? parent.caller : null,
        api: kind === 'api' ? id : valid(parent) ? parent.api : null,
        request: kind === 'request' ? id : null };
      emit(token, `${kind}-start`, read);
      return token;
    } catch { fault('context'); return null; }
  };
  const api = Object.freeze({
    version: 1,
    start(owner) {
      try {
        if (!installed || session || !Number.isSafeInteger(owner) || owner <= 0 || owner >= caps.number) return null;
        session = { id: 1, owner, active: true, startedAt: 0, caller: 0, api: 0, request: 0,
          attempts: 0, droppedRecords: 0, faultAttempts: 0, droppedFaults: 0, faults: [], records: [],
          saturated: false, failed: false, lastObservedAppErrorWriter: null };
        session.startedAt = safe(() => performance.now());
        if (typeof session.startedAt !== 'number' || !Number.isFinite(session.startedAt)) fault('clock');
        return { version: 1, owner, sessionId: 1 };
      } catch { fault('protocol'); return null; }
    },
    finish(owner) {
      if (!session || session.owner !== owner || !session.active) return null;
      try {
        // Stop first; getters and export cannot admit new business records.
        session.active = false;
        context = null;
        const stoppedAt = clock();
        const appNotice = safe(() => !!document.querySelector('.main-content > .notice.error'));
        const relationsNotice = safe(() => !!document.querySelector('.settings-card > .notice.error'));
        return { version: 1, owner, sessionId: session.id, active: false, stoppedAt,
          attempts: session.attempts, retainedRecords: session.records.length, droppedRecords: session.droppedRecords,
          faultAttempts: session.faultAttempts, faults: [...session.faults], droppedFaults: session.droppedFaults,
          saturated: session.saturated, failed: session.failed,
          lastObservedAppErrorWriter: session.lastObservedAppErrorWriter, writerKnown: false,
          appNotice, relationsNotice, records: session.records.map(row => [...row]) };
      } catch { fault('snapshot'); return null; }
    },
  });
  try {
    if (Object.hasOwn(globalThis, `${hook}Unavailable`)) {
      // Preserve the existing marker descriptor/value, including accessors.
    } else if (Object.hasOwn(globalThis, hook)) {
      Object.defineProperty(globalThis, `${hook}Unavailable`, { value: true, configurable: false, writable: false });
    } else {
      Object.defineProperty(globalThis, hook, { value: api, configurable: false, writable: false });
      installed = true;
    }
  } catch { /* Collision or blocked installation is unavailable, never adopted. */ }
  return Object.freeze({
    caller: (owner, read) => allocate('caller', owner, read),
    api: read => allocate('api', null, read),
    request: read => allocate('request', null, read),
    event: emit,
    call(token, business) {
      // This helper is deliberately NOT async. Return the original promise/value,
      // invoke exactly once, and preserve the original thrown object and arguments.
      let previous = null;
      try { previous = context; context = valid(token) ? token : null; }
      catch { fault('context'); context = null; }
      try { return business(); }
      finally { context = previous; }
    },
  });
}

const callerEdits = () => {
  const edits = [];
  for (const [name, owner, counter, loading, type, expression] of [
    ['bootstrap', 'app-bootstrap', 'bootstrapRequest', 'loadingSite', 'Bootstrap', '"/bootstrap" + (refresh ? "?refresh=1" : "")'],
    ['loadArticles', 'app-content', 'articleRequest', 'loadingArticles', 'ArticleSummary[]', '\n          "/content" + (refresh ? "?refresh=1" : ""),\n        '],
  ]) {
    const start = `    async function ${name}(refresh = false) {\n      const current = generation, request = ++${counter};\n      const isCurrent = () => current === generation && request === ${counter};`;
    edits.push([start, `${start}\n      const __nsCaller = ${trace}.caller("${owner}", () => ({ generation, counter: request, refresh }));`]);
    const call = `const result = await api<${type}>(${expression});`;
    edits.push([call, `const result = await ${trace}.call(__nsCaller, () => api<${type}>(${expression}));\n        ${trace}.event(__nsCaller, "caller-return");`]);
    const end = `      } catch (e) {\n        if (isCurrent()) error.value = errorMessage(e);\n      } finally {\n        if (isCurrent()) ${loading}.value = false;\n      }`;
    edits.push([end, `      } catch (e) {\n        ${trace}.event(__nsCaller, "caller-catch");\n        const __nsGuard = isCurrent();\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, generation, counter: ${counter} }));\n        if (__nsGuard) {\n          error.value = errorMessage(e);\n          ${trace}.event(__nsCaller, "notice-write");\n        }\n      } finally {\n        const __nsGuard = isCurrent();\n        ${trace}.event(__nsCaller, "caller-finally", () => ({ guard: __nsGuard, generation, counter: ${counter} }));\n        if (__nsGuard) {\n          ${loading}.value = false;\n          ${trace}.event(__nsCaller, "loading-clear");\n        }\n      }`]);
  }
  return edits;
};
const appEdits = () => [
  ...callerEdits(),
  ['        if (!isCurrent()) return;\n        configureSaving', `        const __nsGuard = !isCurrent();\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, generation, counter: bootstrapRequest }));\n        if (__nsGuard) return;\n        configureSaving`],
  ['        if (isCurrent()) {\n          articles.value = result;', `        const __nsGuard = isCurrent();\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, generation, counter: articleRequest }));\n        if (__nsGuard) {\n          articles.value = result;`],
  ['    ] as const, async (next, previous) => {\n      generation++;', `    ] as const, async (next, previous) => {\n      generation++;\n      ${trace}.event(null, "app-generation", () => ({ generation, reasonMask: previous ? next.reduce((mask, item, index) => mask | (!Object.is(item, previous[index]) ? 1 << index : 0), 0) : null }));`],
  ['    onBeforeUnmount(() => {\n      generation++;\n      window.removeEventListener("beforeunload", beforeUnload);', `    onBeforeUnmount(() => {\n      generation++;\n      ${trace}.event(null, "app-unmount", () => ({ generation }));\n      window.removeEventListener("beforeunload", beforeUnload);`],
];
const settingsEdits = () => [
  ['    onBeforeUnmount(() => {\n      requestId++;\n      emit("dirty", false);', `    onBeforeUnmount(() => {\n      requestId++;\n      ${trace}.event(null, "settings-unmount", () => ({ counter: requestId }));\n      emit("dirty", false);`],
  ['    async function loadRelations(refresh = false) {\n      const id = ++relationsRequestId;\n      const current = () => relationsAlive && id === relationsRequestId;\n      relationsRefreshPending = relationsRefreshPending || refresh;', `    async function loadRelations(refresh = false) {\n      const id = ++relationsRequestId;\n      const current = () => relationsAlive && id === relationsRequestId;\n      relationsRefreshPending = relationsRefreshPending || refresh;\n      const __nsCaller = ${trace}.caller("settings-relations", () => ({ counter: id, refresh: relationsRefreshPending }));`],
  ['        const items = await api<ArticleSummary[]>("/content" + (relationsRefreshPending ? "?refresh=1" : ""));\n        if (!current()) return;', `        const items = await ${trace}.call(__nsCaller, () => api<ArticleSummary[]>("/content" + (relationsRefreshPending ? "?refresh=1" : "")));\n        ${trace}.event(__nsCaller, "caller-return");\n        const __nsGuard = current();\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, counter: relationsRequestId }));\n        if (!__nsGuard) return;`],
  ['      } catch (e) {\n        if (current()) relationsError.value = errorMessage(e);\n      } finally {\n        if (current()) {\n          relationsRefreshPending = false;\n          relationsLoading.value = false;\n        }\n      }', `      } catch (e) {\n        ${trace}.event(__nsCaller, "caller-catch");\n        const __nsGuard = current();\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, counter: relationsRequestId }));\n        if (__nsGuard) {\n          relationsError.value = errorMessage(e);\n          ${trace}.event(__nsCaller, "notice-write");\n        }\n      } finally {\n        const __nsGuard = current();\n        ${trace}.event(__nsCaller, "caller-finally", () => ({ guard: __nsGuard, counter: relationsRequestId }));\n        if (__nsGuard) {\n          relationsRefreshPending = false;\n          relationsLoading.value = false;\n          ${trace}.event(__nsCaller, "loading-clear");\n        }\n      }`],
  ['    async function load() {\n      const id = ++requestId;', `    async function load() {\n      const id = ++requestId;\n      const __nsCaller = ${trace}.caller("settings-main", () => ({ counter: id }));`],
  ['        const result = await api<Settings>(endpoint.value);\n        if (id !== requestId) return;', `        const result = await ${trace}.call(__nsCaller, () => api<Settings>(endpoint.value));\n        ${trace}.event(__nsCaller, "caller-return");\n        const __nsGuard = id !== requestId;\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, counter: requestId }));\n        if (__nsGuard) return;`],
  ['      } catch (e) {\n        if (id === requestId) error.value = errorMessage(e);\n      }\n    }', `      } catch (e) {\n        ${trace}.event(__nsCaller, "caller-catch");\n        const __nsGuard = id === requestId;\n        ${trace}.event(__nsCaller, "guard", () => ({ guard: __nsGuard, counter: requestId }));\n        if (__nsGuard) {\n          error.value = errorMessage(e);\n          ${trace}.event(__nsCaller, "notice-write");\n        }\n      } finally {\n        ${trace}.event(__nsCaller, "caller-finally");\n      }\n    }`],
];
const apiEdits = () => {
  const state = 'scope: scopeGeneration, transport: transportGeneration, locale: locale.value';
  const mismatch = 'scopeMismatch: activeScope !== scopeGeneration, transportMismatch: activeTransportGeneration !== transportGeneration';
  const requestState = `${state}, ${mismatch}, aborted: signal?.aborted ?? null`;
  const stale = "if ((activeTransportGeneration !== transportGeneration || (method === 'GET' && activeScope !== scopeGeneration)) && path !== '/auth/logout') throw new ApiError('连接已更换，请重试', 409);";
  const abort = `try { signal?.throwIfAborted(); } catch (__nsError) {\n    ${trace}.event(__nsRequest, "reject", () => ({ ${requestState}, origin: "request-abort", responseStatus: response.status }));\n    throw __nsError;\n  }`;
  const staleBranch = origin => `if ((activeTransportGeneration !== transportGeneration || (method === 'GET' && activeScope !== scopeGeneration)) && path !== '/auth/logout') {\n    ${trace}.event(__nsRequest, "reject", () => ({ ${requestState}, origin: "${origin}", responseStatus: response.status, errorStatus: 409 }));\n    throw new ApiError('连接已更换，请重试', 409);\n  }`;
  const unauthorized = "    if (response.status === 401 && path !== '/auth/login' && session.value && activeAuthenticationEpoch === authenticationEpoch.value && activeTransportGeneration === transportGeneration) reauthentication.value = true;\n    throw new ApiError(data.messageKey || data.error || '请求失败，请稍后再试', response.status, data.params);";
  return [
    // Contract-only validation: the status instrumentation below owns the throw.
    [unauthorized, unauthorized],
    ['  const activeAuthenticationEpoch = authenticationEpoch.value;', '  const activeAuthenticationEpoch = authenticationEpoch.value;'],
    ['function invalidateSessionScope() {\n  scopeGeneration++;\n  contentQueries.invalidate();\n}', `function invalidateSessionScope() {\n  scopeGeneration++;\n  ${trace}.event(null, "scope-invalidate", () => ({ ${state}, reasonMask: null }));\n  contentQueries.invalidate();\n}`],
    ['watch(locale, () => {\n  scopeGeneration++;\n  contentQueries.invalidate();\n});', `watch(locale, () => {\n  scopeGeneration++;\n  ${trace}.event(null, "scope-invalidate", () => ({ ${state}, reasonMask: 1 << 5 }));\n  contentQueries.invalidate();\n});`],
    ["export function setApiTransport(next?: ApiTransport) {\n  if (transportGeneration === Number.MAX_SAFE_INTEGER) throw new Error('Transport generation exhausted');\n  batch(() => {\n    transport = next || ((path, init) => fetch(`/api${path}`, init));\n    transportGeneration++;\n    try {\n      contentQueries.invalidate();\n    } finally {\n      // Invalidation/notification may reenter; publish only the latest authority.\n      transportRevision.value = transportRevision.peek() + 1;\n    }\n  });\n}", `export function setApiTransport(next?: ApiTransport) {\n  if (transportGeneration === Number.MAX_SAFE_INTEGER) throw new Error('Transport generation exhausted');\n  batch(() => {\n    transport = next || ((path, init) => fetch(\`/api\${path}\`, init));\n    transportGeneration++;\n    try {\n      contentQueries.invalidate();\n      ${trace}.event(null, "transport-invalidate", () => ({ ${state} }));\n    } finally {\n      // Invalidation/notification may reenter; publish only the latest authority.\n      transportRevision.value = transportRevision.peek() + 1;\n    }\n  });\n}`],
    ["export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {\n  const mutation", `export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {\n  const __nsApi = ${trace}.api(() => ({ ${state} }));\n  const mutation`],
    ["  if (loggingOut || (logout && pendingMutations.value > 0)) throw new ApiError('正在保存或生成译文，请稍候。', 409);", `  if (loggingOut || (logout && pendingMutations.value > 0)) {\n    ${trace}.event(__nsApi, "reject", () => ({ ${state}, origin: "unclassified", errorStatus: 409 }));\n    throw new ApiError('正在保存或生成译文，请稍候。', 409);\n  }`],
    ['    pendingMutations.value++;\n    contentQueries.invalidate();', `    pendingMutations.value++;\n    contentQueries.invalidate();\n    ${trace}.event(__nsApi, "mutation-begin", () => ({ ${state} }));`],
    ["        if (activeTransportGeneration !== transportGeneration || activeScope !== scopeGeneration || loggingOut) {\n          throw new ApiError('连接已更换，请重试', 409);", `        if (activeTransportGeneration !== transportGeneration || activeScope !== scopeGeneration || loggingOut) {\n          ${trace}.event(__nsApi, "reject", () => ({ ${state}, ${mismatch}, origin: "content-scope", errorStatus: 409 }));\n          throw new ApiError('连接已更换，请重试', 409);`],
    ['          return request<T>(path, method, body, signal);', `          return ${trace}.call(__nsApi, () => request<T>(path, method, body, signal));`],
    ['        assertCurrent();\n        return result;', `        assertCurrent();\n        ${trace}.event(__nsApi, "api-return", () => ({ ${state} }));\n        return result;`],
    ["        if (error instanceof Error && error.name === 'TimeoutError') throw new ApiError('连接超时，请重试。', 408);", `        if (error instanceof Error && error.name === 'TimeoutError') {\n          ${trace}.event(__nsApi, "reject", () => ({ ${state}, origin: "content-timeout", errorStatus: 408 }));\n          throw new ApiError('连接超时，请重试。', 408);\n        }`],
    ['    return await request<T>(path, method, body);\n  } finally {', `    const __nsResult = await ${trace}.call(__nsApi, () => request<T>(path, method, body));\n    ${trace}.event(__nsApi, "api-return", () => ({ ${state} }));\n    return __nsResult;\n  } catch (__nsError) {\n    ${trace}.event(__nsApi, "api-catch", () => ({ ${state}, origin: "unclassified" }));\n    throw __nsError;\n  } finally {\n    ${trace}.event(__nsApi, "api-finally", () => ({ ${state} }));`],
    ["    body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });\n  } catch (error) {", `    body: body === undefined ? undefined : binary ? body : JSON.stringify(body) });\n    ${trace}.event(__nsRequest, "transport-return", () => ({ ${requestState}, responseStatus: response.status }));\n  } catch (error) {`],
    ['      contentQueries.invalidate();\n      pendingMutations.value--;', `      contentQueries.invalidate();\n      ${trace}.event(__nsApi, "mutation-end", () => ({ ${state} }));\n      pendingMutations.value--;`],
    ['async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {\n  const binary', `async function request<T>(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {\n  const __nsRequest = ${trace}.request(() => ({ ${state}, aborted: signal?.aborted ?? null }));\n  const binary`],
    ["  } catch (error) {\n    if (method !== 'GET') throw error;", `  } catch (error) {\n    ${trace}.event(__nsRequest, "reject", () => ({ ${requestState}, origin: "transport-reject", errorStatus: method === "GET" ? 408 : null }));\n    if (method !== 'GET') throw error;`],
    [`  signal?.throwIfAborted();\n  ${stale}\n  const data = await response.json().catch(() => { throw new ApiError(response.status === 413 ? '文件超过服务器上传限制，请选择较小的图片' : '请求失败，请稍后再试', response.ok ? 502 : response.status); });`, `  ${abort}\n  ${staleBranch('pre-json-scope')}\n  const data = await response.json().catch(() => {\n    ${trace}.event(__nsRequest, "reject", () => ({ ${requestState}, origin: "response-json", responseStatus: response.status, errorStatus: response.ok ? 502 : response.status }));\n    throw new ApiError(response.status === 413 ? '文件超过服务器上传限制，请选择较小的图片' : '请求失败，请稍后再试', response.ok ? 502 : response.status);\n  });`],
    [`  signal?.throwIfAborted();\n  ${stale}\n  if (!response.ok) {`, `  ${abort}\n  ${staleBranch('post-json-scope')}\n  if (!response.ok) {`],
    ["    throw new ApiError(data.messageKey || data.error || '请求失败，请稍后再试', response.status, data.params);", `    ${trace}.event(__nsRequest, "reject", () => ({ ${requestState}, origin: "response-status", responseStatus: response.status, errorStatus: response.status }));\n    throw new ApiError(data.messageKey || data.error || '请求失败，请稍后再试', response.status, data.params);`],
    ['  return data as T;\n}', `  ${trace}.event(__nsRequest, "request-return", () => ({ ${requestState}, responseStatus: response.status }));\n  return data as T;\n}`],
  ];
};

export function nativeScopeBuildPlugin() {
  let configured = false, loaded = 0;
  const transformed = new Set();
  return {
    name: 'studio-test-native-scope-trace-v1', enforce: 'pre', apply: 'build',
    configResolved(config) {
      if (process.env.CI !== 'true' || process.env.STUDIO_TEST_NATIVE_SCOPE_TRACE !== '1' || config.command !== 'build' || config.build.ssr) {
        throw new Error('Native scope tracing requires an explicitly enabled non-SSR CI build');
      }
      configured = true;
    },
    resolveId(id) { if (id === virtualId) return resolvedVirtualId; },
    load(id) {
      if (id !== resolvedVirtualId) return;
      if (!configured || ++loaded !== 1) throw new Error('Native scope virtual module must load exactly once');
      return `import { untracked } from '@preact/signals-react';\nexport const nativeScopeTrace = (${installRuntime.toString()})(untracked, ${JSON.stringify(nativeScopeContract)});\n`;
    },
    transform(source, id, options) {
      const name = targets[id.replaceAll('\\', '/')];
      if (!name) return;
      if (!configured || options?.ssr || transformed.has(name)) throw new Error('Native scope target transform refused');
      const edits = name === 'App.tsx' ? appEdits() : name === 'api.ts' ? apiEdits() : settingsEdits();
      // Validate every exact multiline sentinel before changing any source bytes.
      const counts = edits.map(([before]) => source.split(before).length - 1);
      if (counts.some(count => count !== 1) || source.includes(trace) || source.includes(virtualId)) {
        throw new Error(`Native scope ${name} sentinels changed: ${counts.join(',')}`);
      }
      let code = source;
      for (const [before, after] of edits) code = code.replace(before, after);
      transformed.add(name);
      return { code: `import { nativeScopeTrace as ${trace} } from "${virtualId}";\n${code}`, map: null };
    },
    buildEnd(error) {
      if (error) return; // An existing build failure already fails closed.
      if (!configured || transformed.size !== 3 || loaded !== 1) {
        throw new Error(`Native scope tracing incomplete: transformed=${transformed.size}, virtualLoads=${loaded}`);
      }
    },
  };
}
export default nativeScopeBuildPlugin;
