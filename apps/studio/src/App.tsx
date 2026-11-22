import QuickSync from "./components/QuickSync";
import { ErrorDetails, ErrorNotice } from "./components/ErrorNotice";
import { LegacyRecovery } from "../platform/LegacyRecovery";
import { configureSaving } from "./save-preferences";
import type { SaveCapabilities } from "../shared/save";
import { NativeAiSettings } from "../platform/NativeAiSettings";
import { WorkspacePanel } from "../platform/WorkspacePanel";
import "../platform/native.css";
import {
  component,
  element,
  Fragment,
  classes,
  portal,
  domRef,
  domEvent,
  combineEvents,
  renderList,
  modelValue,
  type EventHandler,
  type EditorHandle,
  type StudioComponent,
} from "./react-component";
import ViewTransition from "./components/ViewTransition";
import LoadingState from "./components/LoadingState";
import { installNavigationSwipe } from "./navigation-swipe";
import { navigationPosition } from "./navigation-position";
import { mediaUploading } from "./media-store";
import { subscribeWorkspaceChanged } from "./workspace-events";
import { locale, t, type Message } from "./i18n";
import { ref, watch, onMounted, onBeforeUnmount, computed } from "./reactivity";
import type { Json, ArticleSummary } from "../shared/types";
import { blogStyleFields } from "../shared/settings";
import { api, session, reauthentication, errorMessage, pendingMutations } from "./api";
import LoginView from "./components/LoginView";
import Modal from "./components/Modal";
import SettingsView from "./components/SettingsView";
import FormField from "./components/FormField";
import ContentLibrary from "./components/ContentLibrary";
import ThreadComposer from "./components/ThreadComposer";
import ThreadDetail from "./components/ThreadDetail";
import DocumentEditor from "./components/DocumentEditor";
import LocalizedContentLibrary from "./components/LocalizedContentLibrary";
import Icon from "./components/Icon";
import MediaLibrary from "./components/MediaLibrary";
import LanguageSwitcher from "./components/LanguageSwitcher";
import GettingStarted from "./components/GettingStarted";
import {
  collectionRoot,
  isLibraryItem,
  isSection,
  sortLibrary,
} from "../shared/library";

type Props = { workspaceSwitcher?: boolean };
type Events = {};
const appearanceStorageKey = "studio-appearance";
const schemePath = "extra.style.color_scheme";
function readStudioAppearance(): Record<string, string> {
  try {
    const stored = localStorage.getItem(appearanceStorageKey);
    if (stored !== null) {
      const values = JSON.parse(stored);
      return Object.fromEntries(blogStyleFields.flatMap(({ path }) => typeof values?.[path] === "string" ? [[path, values[path]]] : []));
    }
    const legacy = localStorage.getItem("studio-theme");
    if (legacy === "light" || legacy === "dark") return { [schemePath]: legacy };
  } catch { /* Use site defaults when device storage is unavailable. */ }
  return {};
}
const App: StudioComponent<Props, Events> = component<Props, Events>(
  "App",
  (props, emit, expose) => {
    type Bootstrap = {
      site: Record<string, Json>;
      appearance: Record<string, Json>;
      mode: string;
      workspace?: boolean;
      quickSync?: boolean;
      saveScope: string;
      saveCapabilities: SaveCapabilities;
      nativeAi?: boolean;
      groups: { id: string; title: string }[];
    };
    const editorView = ref<{
      flush: () => void;
      isBusy?: () => boolean;
    } | null>(null);
    const checking = ref(true),
      data = ref<Bootstrap | null>(null),
      error = ref<Message>(""),
      view = ref("home"),
      dirty = ref(false),
      dark = ref(window.document.documentElement.dataset.theme === "dark");
    const studioAppearance = ref(readStudioAppearance()), appearanceError = ref(false);
    const systemScheme = matchMedia("(prefers-color-scheme: dark)");
    const studioStyle = computed<Record<string, Json>>(() => Object.fromEntries(blogStyleFields.map(({ path, default: fallback }) =>
      [path, studioAppearance.value[path] || data.value?.appearance[path] || fallback])));
    // Capture before the shell becomes inert, including focus inside portalled dialogs.
    const reauthenticationFocus = ref<HTMLElement | null>(null);
    watch(reauthentication, (required) => {
      if (!required) return;
      const focused = window.document.activeElement;
      // An in-flight mutation may disable its trigger and move focus to body.
      const underlying = [...window.document.querySelectorAll<HTMLDialogElement>("dialog:modal")].at(-1);
      reauthenticationFocus.value = focused instanceof HTMLElement && focused !== window.document.body
        ? focused
        : underlying || null;
    });
    const navigationSize = window.matchMedia("(max-width: 760px), (max-width: 1024px) and (pointer: coarse)");
    const mobileNavigation = ref(navigationSize.matches);
    let navigationFrame = 0;
    onMounted(() => {
      const media = navigationSize;
      const resize = () => {
        const focused = window.document.activeElement;
        // Only migrate controls that this breakpoint hides or makes inert.
        const needsFocus = media.matches
          ? focused?.closest('.sidebar')
          : focused?.closest('.mobile-tabbar');
        mobileNavigation.value = media.matches;
        window.cancelAnimationFrame(navigationFrame);
        if (!needsFocus) return;
        navigationFrame = window.requestAnimationFrame(() => {
          const active = window.document.activeElement;
          // Do not override a new focus choice made while React commits the layout.
          if (active !== focused && active !== window.document.body) return;
          const selector = mobileNavigation.value
            ? '.mobile-menu'
            : '.sidebar nav button[aria-current="page"], .sidebar nav button';
          const targets = [...window.document.querySelectorAll<HTMLButtonElement>(selector)];
          const target = targets.find(node => node.hasAttribute('aria-current')) || targets[0];
          if (target && !target.closest('[inert]') && target.getClientRects().length) target.focus();
        });
      };
      media.addEventListener('change', resize);
      navigationCleanup = () => { media.removeEventListener('change', resize); window.cancelAnimationFrame(navigationFrame); };
    });
    let navigationCleanup = () => {};
    onBeforeUnmount(() => navigationCleanup());
    const articles = ref<ArticleSummary[]>([]),
      document = ref<{
        path: string;
        initial?: Record<string, Json>;
        initialBody?: string;
        mode: "detail" | "edit";
      } | null>(null);
    const libraryBusy = ref(false);
    const collectionFolder = ref(collectionRoot);
    const loadingArticles = ref(false),
      articlesReady = ref(false),
      loadingSite = ref(false);
    // Display-only projection: never assign these rows to the live content list.
    type PreviewRow = Pick<ArticleSummary, "path" | "title" | "date" | "draft" | "kind" | "tags" | "categories">;
    type DashboardPreview = { source: "cache"; authoritative: false; rows: PreviewRow[] };
    const dashboardPreview = ref<DashboardPreview | null>(null);
    const showingPreview = computed(() => !articlesReady.value && dashboardPreview.value !== null);
    const dashboardRows = computed(() => articlesReady.value ? articles.value : dashboardPreview.value?.rows || []);
    let generation = 0, articleRequest = 0, bootstrapRequest = 0, workspaceRequest = 0;
    let workspaceRefreshPending = false;
    const dashboardArticles = computed(() =>
      sortLibrary(
        dashboardRows.value.filter(
          (item) => item.kind === "article" && isLibraryItem(item),
        ),
        "article",
      ),
    );
    function countContent(kind: string) {
      return dashboardRows.value.filter(
        (item) =>
          item.kind === kind &&
          isLibraryItem(item) &&
          (kind !== "collection" || isSection(item)),
      ).length;
    }
    const navigation = [
      { id: "home", label: "工作台", icon: "home" },
      { id: "article", label: "文章", icon: "pen" },
      { id: "thread", label: "动态", icon: "thread" },
      { id: "topic", label: "话题管理", icon: "tag" },
      { id: "collection", label: "合集管理", icon: "book" },
      { id: "page", label: "页面", icon: "file" },
      { id: "media", label: "媒体库", icon: "image" },
      { id: "native-ai", label: "客户端 API 设置", icon: "star" },
      { id: "workspace", label: "工作区同步", icon: "globe" },
      { id: "help", label: "使用指南", icon: "book" },
    ];
    const primaryNavigation = navigation.filter(item => ["home", "article", "thread", "media"].includes(item.id));
    const tabs = [...primaryNavigation, { id: "more", label: "更多", icon: "more" }];
    const availableNavigation = () => navigation.filter(item =>
      (item.id !== "workspace" || data.value?.workspace) && (item.id !== "native-ai" || data.value?.nativeAi));
    const siteGroups = () => (data.value?.groups ?? []).filter(group => group.id !== "appearance");
    const icons: Record<string, string> = {
      site: "globe",
      navigation: "menu",
      friends: "link",
      about: "user",
      taxonomies: "tag",
      recommendations: "star",
      theme: "palette",
    };
    const contentKind = computed(() =>
      ["article", "page", "collection"].includes(view.value)
        ? (view.value as "article" | "page" | "collection")
        : null,
    );
    const siteUrl = computed(() => {
      try {
        const url = new URL(String(data.value?.site.base_url));
        return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
      } catch {
        return null;
      }
    });
    function applyTheme() {
      const style = studioStyle.value;
      const scheme = style[schemePath];
      dark.value = scheme === "dark" || (scheme !== "light" && systemScheme.matches);
      const root = window.document.documentElement;
      root.dataset.theme = dark.value ? "dark" : "light";
      const color = style[dark.value ? "extra.style.theme_dark_skin" : "extra.style.theme_light_skin"];
      if (typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color))
        root.style.setProperty("--wjx-theme", color);
      else root.style.removeProperty("--wjx-theme");
      const font = style["extra.style.font_family"];
      if (typeof font === "string")
        root.style.fontFamily = `${font}, -apple-system, BlinkMacSystemFont, sans-serif`;
    }
    function saveStudioAppearance(values: Record<string, string>) {
      appearanceError.value = false;
      try { localStorage.setItem(appearanceStorageKey, JSON.stringify(values)); }
      catch { appearanceError.value = true; }
      studioAppearance.value = values;
      applyTheme();
    }
    onMounted(() => systemScheme.addEventListener("change", applyTheme));
    onBeforeUnmount(() => systemScheme.removeEventListener("change", applyTheme));
    async function bootstrap(refresh = false) {
      const current = generation, request = ++bootstrapRequest;
      const isCurrent = () => current === generation && request === bootstrapRequest;
      loadingSite.value = true;
      try {
        const result = await api<Bootstrap>("/bootstrap" + (refresh ? "?refresh=1" : ""));
        if (!isCurrent()) return;
        configureSaving(`${session.value?.identity.id}:${result.saveScope}`, result.saveCapabilities, result.workspace);
        data.value = result;
        const scheme = result.appearance[schemePath];
        try {
          if (scheme === "dark" || scheme === "light" || scheme === "system") localStorage.setItem("studio-site-scheme", scheme);
        } catch {}
        applyTheme();
      } catch (e) {
        if (isCurrent()) error.value = errorMessage(e);
      } finally {
        if (isCurrent()) loadingSite.value = false;
      }
    }
    async function loadDashboardPreview(isCurrent: () => boolean) {
      try {
        const result = await api<DashboardPreview | null>("/content-preview");
        if (isCurrent() && !articlesReady.value && result?.source === "cache" && result.authoritative === false && Array.isArray(result.rows)) {
          dashboardPreview.value = result;
        }
      } catch {
        // Optional acceleration, including 404 on older services. Fresh reads own errors.
      }
    }
    async function loadArticles(refresh = false) {
      const current = generation, request = ++articleRequest;
      const isCurrent = () => current === generation && request === articleRequest;
      loadingArticles.value = true;
      // A forced post-sync read must not revive a pre-sync persisted projection.
      if (refresh) dashboardPreview.value = null;
      else if (!articlesReady.value && view.value === "home" && !document.value) void loadDashboardPreview(isCurrent);
      try {
        const result = await api<ArticleSummary[]>(
          "/content" + (refresh ? "?refresh=1" : ""),
        );
        if (isCurrent()) {
          articles.value = result;
          articlesReady.value = true;
          dashboardPreview.value = null;
        }
      } catch (e) {
        if (isCurrent()) error.value = errorMessage(e);
      } finally {
        if (isCurrent()) loadingArticles.value = false;
      }
    }
    async function refreshWorkspace(clearError = true) {
      const current = generation, request = ++workspaceRequest;
      workspaceRefreshPending = true;
      if (clearError) error.value = "";
      // Invalidate old content/preview callbacks before awaiting the checkout refresh.
      articleRequest++;
      dashboardPreview.value = null;
      loadingArticles.value = true;
      try {
        // Bootstrap must not race a content refresh against an already warm checkout.
        // Continue with the authoritative content read even if bootstrap reports an error.
        await bootstrap(true);
        if (current !== generation || request !== workspaceRequest) return;
        await loadArticles(true);
      } finally {
        if (current === generation && request === workspaceRequest) workspaceRefreshPending = false;
      }
    }
    async function reloadWorkspace() {
      if (loadingSite.value || loadingArticles.value) return;
      await refreshWorkspace();
    }
    const unsubscribeWorkspace = subscribeWorkspaceChanged(() => {
      if (!session.value) return;
      // Do not navigate, clear dirty state, or remount the active editor/settings.
      // Supersede pending reads rather than dropping a sync notification as busy.
      return refreshWorkspace();
    });
    onBeforeUnmount(unsubscribeWorkspace);
    watch([
      session,
      () => session.value?.identity.id,
      () => session.value?.identity.method,
      () => session.value?.csrf,
      () => session.value?.expires,
      locale,
    ] as const, async (next, previous) => {
      generation++;
      const [value] = next;
      const sessionChanged = next.slice(0, 5).some((item, index) => !Object.is(item, previous[index]));
      if (!sessionChanged) {
        if (checking.value) {
          await checkSession();
          return;
        }
        if (!value) return;
        // Locale invalidates pending reads, not the mounted editing context.
        if (workspaceRefreshPending) {
          await refreshWorkspace(false);
          return;
        }
        await Promise.all([
          loadingSite.value || !data.value ? bootstrap() : Promise.resolve(),
          loadingArticles.value || !articlesReady.value ? loadArticles() : Promise.resolve(),
        ]);
        return;
      }
      workspaceRequest++;
      workspaceRefreshPending = false;
      checking.value = false;
      dashboardPreview.value = null;
      articles.value = [];
      articlesReady.value = false;
      data.value = null;
      if (value) {
        error.value = "";
        await Promise.all([bootstrap(), loadArticles()]);
      } else {
        loadingArticles.value = false;
        loadingSite.value = false;
        document.value = null;
        view.value = "home";
        dirty.value = false;
        error.value = "";
      }
    });
    async function checkSession() {
      const current = generation;
      try {
        const result = await api<NonNullable<typeof session.value>>("/auth/session");
        if (current === generation) session.value = result;
      } catch {
        /* Login is shown for an absent session. */
      } finally {
        if (current === generation) checking.value = false;
      }
    }
    onMounted(checkSession);
    function leave() {
      if (pendingMutations.value || libraryBusy.value || editorView.value?.isBusy?.()) {
        alert(t("正在保存或生成译文，请稍候。"));
        return false;
      }
      if (mediaUploading.value) {
        alert(t("图片正在上传，请完成后再离开。"));
        return false;
      }
      editorView.value?.flush();
      return (
        !dirty.value ||
        confirm(
          t(
            "还有未保存的更改，确定离开吗？文章本地草稿会保留，配置表单不会自动保存。",
          ),
        )
      );
    }
    const viewportPosition = navigationPosition();
    type Destination = { view: string; doc: { path: string; mode: "detail" | "edit" } | null };
    const previous = ref<Destination[]>([]);
    watch(session, () => { viewportPosition.clear(); previous.value = []; });
    const canSwipeBack = () => previous.value.length > 0;
    function rememberDestination(nextKey: string) {
      const key = positionKey();
      viewportPosition.remember(key);
      if (key === nextKey) return;
      const last = previous.value.at(-1);
      if (last && positionKey(last.view, last.doc) === nextKey) {
        previous.value.pop();
        return;
      }
      // Draft contents belong to the editor's recovery store, never navigation.
      const doc = document.value;
      if (doc?.initial) return;
      previous.value = [...previous.value.slice(-31), {
        view: view.value, doc: doc && { path: doc.path, mode: doc.mode },
      }];
    }
    function swipeBack() {
      const destination = previous.value.at(-1);
      if (!destination || !leave()) return;
      viewportPosition.remember(positionKey());
      previous.value.pop();
      document.value = destination.doc;
      view.value = destination.view;
      dirty.value = false;
      viewportPosition.enter(positionKey(), true);
      if (!destination.doc && destination.view === "home") void loadArticles();
    }
    let removeSwipe = () => {};
    onMounted(() => {
      removeSwipe = installNavigationSwipe(
        () => !!session.value && !reauthentication.value && mobileNavigation.value,
        canSwipeBack,
        action => {
          if (action === "back") { swipeBack(); return; }
          const index = tabs.findIndex(item => item.id === view.value);
          const next = tabs[index + (action === "next" ? 1 : -1)];
          if (index >= 0 && next) navigate(next.id);
        },
      );
    });
    onBeforeUnmount(() => removeSwipe());
    onBeforeUnmount(() => viewportPosition.dispose());
    function navigationGroups(more: boolean) {
      function destination(id: string, title: string, icon: string) {
        const active = view.value === id;
        return <button key={id} type="button" aria-current={active ? "page" : undefined}
          className={classes({ active })} onClick={() => navigate(id)}>
          <Icon name={icon} size={18} />{t(title)}
          {more ? <Icon name="arrow" size={16} /> : active ? <span className="nav-indicator" /> : null}
        </button>;
      }
      const content = availableNavigation().filter(item => !more || !primaryNavigation.includes(item));
      return <div className={more ? "more-groups" : "sidebar-navigation"}>
        <p className="nav-label">{t("创作空间")}</p>
        <nav aria-label={t("内容导航")}>{content.map(item => destination(item.id, item.label, item.icon))}</nav>
        <p className="nav-label">{t("站点管理")}</p>
        {loadingSite.value && !data.value && <LoadingState label="正在加载站点…" compact />}
        <nav aria-label={t("站点设置")}>{siteGroups().map(group => destination(group.id, group.title, icons[group.id] || "file"))}</nav>
        <details className="studio-preferences" open={more || undefined}><summary>{t("界面设置")}</summary>
          <LanguageSwitcher />
          <button type="button" aria-current={view.value === "appearance" ? "page" : undefined} onClick={() => navigate("appearance")}><Icon size={18} name="palette" />{t("外观样式")}</button>
          <button type="button" className="theme-switch" aria-pressed={dark.value} onClick={() => {
            saveStudioAppearance({ ...studioAppearance.value, [schemePath]: dark.value ? "light" : "dark" });
          }}>{t("切换明暗模式")}</button>
          {props.workspaceSwitcher && <button type="button" disabled={pendingMutations.value > 0} onClick={() => void logout()}><Icon size={18} name="switchWorkspace" />{t("切换工作区")}</button>}
        </details>
      </div>;
    }
    function accountControls() {
      const identity = session.value!.identity;
      return <Fragment>
        <LegacyRecovery />
        <div className="sidebar-bottom">
          <span className="avatar">{identity.name.slice(0, 1).toUpperCase()}</span>
          <div><strong>{identity.name}</strong><small>{t(identity.method === "oidc" ? "OIDC 管理员" : "站点管理员")}</small></div>
          <button type="button" aria-label={t("退出登录")} className="icon-button" onClick={() => void logout()}><Icon name="logout" size={18} /></button>
        </div>
      </Fragment>;
    }
    function positionKey(section = view.value, doc: Destination["doc"] = document.value) {
      return doc ? `document:${doc.path}:${doc.mode}` : `view:${section}`;
    }
    function navigate(next: string) {
      if (!leave()) return;
      const returning = (!!document.value && next === view.value) || (next === "more" && previous.value.at(-1)?.view === "more");
      rememberDestination(positionKey(next, null));
      if (next === "home") previous.value = [];
      document.value = null;
      dirty.value = false;
      view.value = next;
      viewportPosition.enter(positionKey(), returning);
      if (next === "home") void loadArticles();
    }
    function open(
      path: string,
      initial?: Record<string, Json>,
      initialBody?: string,
    ) {
      if (!leave()) return false;
      const mode = !initial && path.startsWith("content/threads/") ? "detail" : "edit";
      rememberDestination(positionKey(view.value, { path, mode }));
      document.value = { path, initial, initialBody, mode };
      dirty.value = false;
      viewportPosition.enter(positionKey());
      return true;
    }
    function edit(
      path: string,
      initial?: Record<string, Json>,
      initialBody?: string,
    ) {
      if (!leave()) return;
      rememberDestination(positionKey(view.value, { path, mode: "edit" }));
      document.value = { path, initial, initialBody, mode: "edit" };
      dirty.value = false;
      viewportPosition.enter(positionKey());
    }
    function saved(path: string) {
      if (document.value?.path === path) {
        document.value.initial = undefined;
        document.value.initialBody = undefined;
      }
      void loadArticles();
    }
    function removed(paths: string[]) {
      previous.value = previous.value.filter(entry => !entry.doc || !paths.includes(entry.doc.path));
      if (document.value && paths.includes(document.value.path)) {
        document.value = null;
        dirty.value = false;
      }
      void loadArticles();
    }
    function editorBack() {
      if (
        document.value?.path.startsWith("content/threads/") &&
        !document.value.initial
      )
        open(document.value.path);
      else navigate(view.value);
    }
    async function logout() {
      if (!leave()) return;
      const previousSession = session.value;
      try {
        await api("/auth/logout", "POST");
        if (session.value === previousSession) {
          reauthentication.value = false;
          session.value = null;
        }
      } catch (e) {
        error.value = errorMessage(e);
      }
    }
    function beforeUnload(event: BeforeUnloadEvent) {
      editorView.value?.flush();
      if (
        dirty.value ||
        pendingMutations.value > 0 ||
        libraryBusy.value ||
        mediaUploading.value ||
        editorView.value?.isBusy?.()
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    onBeforeUnmount(() => {
      generation++;
      window.removeEventListener("beforeunload", beforeUnload);
    });
    return () =>
      element(
        Fragment,
        null,
        checking.value
          ? element(LoadingState, { label: "正在打开创作中心…" })
          : !session.value
            ? element(LoginView, null)
            : element(
                "div",
                {
                  inert: reauthentication.value,
                  className: classes("studio-shell"),
                  "data-swipe-back": mobileNavigation.value && canSwipeBack() ? "" : undefined,
                },
                element(
                  "aside",
                  { id: "studio-navigation", hidden: mobileNavigation.value, className: classes("sidebar") },
                  element(
                    "div",
                    { className: classes("brand") },
                    element(
                      "span",
                      { className: classes("brand-mark") },
                      "W",
                      element("span", null, "·"),
                    ),
                    element(
                      "div",
                      null,
                      "Wonder Shine",
                      element("small", null, t("创作中心")),
                    ),
                  ),
                  mobileNavigation.value ? null : navigationGroups(false),
                  mobileNavigation.value ? null : accountControls(),
                ),
                element(
                  "div",
                  { className: classes("main-shell") },
                  element(
                    "header",
                    { className: classes("topbar") },
                    element(
                      "div",
                      { className: classes("row") },
                      element(
                        "span",
                        { className: classes("muted") },
                        t("创作中心"),
                      ),
                      element(
                        "span",
                        { className: classes("breadcrumb") },
                        "/",
                      ),
                      element(
                        "span",
                        null,
                        document.value
                          ? t(
                              document.value.mode === "detail"
                                ? "动态详情"
                                : "编辑内容",
                            )
                          : view.value === "home"
                            ? t("工作台")
                            : t(
                                tabs.find((n) => n.id === view.value)?.label ||
                                navigation.find((n) => n.id === view.value)?.label ||
                                  (view.value === "appearance" ? "外观样式" : data.value?.groups.find(
                                    (g) => g.id === view.value,
                                  )?.title),
                              ),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("row topbar-actions") },
                      data.value?.quickSync ? <QuickSync key={session.value.identity.id} editing={() => dirty.value || !!editorView.value?.isBusy?.()} onManage={() => navigate("workspace")} /> : null,
                      data.value
                        ? element(
                            "span",
                            { className: classes("connection") },
                            element("span", {
                              className: classes("status-dot"),
                            }),
                            data.value?.mode === "git"
                              ? t("Git 内容仓库")
                              : t("本地站点"),
                          )
                        : null,
                      siteUrl.value
                        ? element(
                            "a",
                            {
                              href: siteUrl.value,
                              "aria-label": t("访问主站 ↗"),
                              onClick: domEvent((event: Event) => {
                                if (!("__TAURI_INTERNALS__" in window) || !siteUrl.value) return;
                                event.preventDefault();
                                const url = siteUrl.value;
                                void import("@tauri-apps/plugin-opener").then(opener => opener.openUrl(url)).catch(() => { error.value = "无法打开主站，请检查系统浏览器。"; });
                              }),
                              target: "_blank",
                              rel: "noopener noreferrer",
                              className: classes("visit-site"),
                              title: t("访问主站 ↗"),
                            },
                            element(Icon, { name: "external" }),
                            element("span", null, t("访问主站 ↗")),
                          )
                        : null,
                    ),
                  ),
                  element(
                    "nav",
                    { className: classes("mobile-tabbar"), hidden: !mobileNavigation.value, "aria-label": t("主导航") },
                    tabs.map(item => element("button", {
                      key: item.id,
                      type: "button",
                      className: item.id === "more" ? "mobile-menu" : undefined,
                      hidden: !mobileNavigation.value,
                      "data-destination": item.id,
                      "aria-current": view.value === item.id ? "page"
                        : item.id === "more" && !primaryNavigation.some(tab => tab.id === view.value) ? "true" : undefined,
                      onClick: domEvent(() => {
                        if (view.value === item.id && !document.value) window.scrollTo(0, 0);
                        else navigate(item.id);
                      }),
                    }, element(Icon, { name: item.icon }), t(item.id === "media" ? "媒体" : item.label))),
                  ),
                  element(
                    "main",
                    { className: classes("main-content") },
                    error.value
                      ? element(
                          ErrorNotice,
                          { source: "App", message: error.value },
                          " ",
                          element(
                            "button",
                            {
                              disabled:
                                loadingSite.value || loadingArticles.value,
                              className: classes("text-button"),
                              onClick: domEvent(($event: Event) => {
                                reloadWorkspace();
                              }),
                            },
                            t("重试连接"),
                          ),
                        )
                      : null,
                    <ViewTransition
                      viewId={document.value?.path ?? view.value}
                      mode={document.value?.mode ?? "section"}
                    >
                      {document.value?.mode === "detail"
                      ? element(ThreadDetail, {
                          ref: domRef(editorView),
                          key: `detail:${document.value.path}`,
                          path: document.value.path,
                          siteUrl: siteUrl.value || undefined,
                          onBack: (() => {
                            navigate("thread");
                          }) satisfies EventHandler<
                            typeof ThreadDetail,
                            "onBack"
                          >,
                          onEdit: edit satisfies EventHandler<
                            typeof ThreadDetail,
                            "onEdit"
                          >,
                          onOpen: open satisfies EventHandler<
                            typeof ThreadDetail,
                            "onOpen"
                          >,
                          onDeleted: removed satisfies EventHandler<
                            typeof ThreadDetail,
                            "onDeleted"
                          >,
                        })
                      : document.value
                        ? element(DocumentEditor, {
                            ref: domRef(editorView),
                            key: `edit:${document.value.path}`,
                            backLabel:
                              document.value.path.startsWith(
                                "content/threads/",
                              ) && !document.value.initial
                                ? "← 返回动态详情"
                                : undefined,
                            path: document.value.path,
                            initial: document.value.initial,
                            initialBody: document.value.initialBody,
                            onOpen: edit satisfies EventHandler<
                              typeof DocumentEditor,
                              "onOpen"
                            >,
                            onDirty: (($event) => {
                              dirty.value = $event;
                            }) satisfies EventHandler<
                              typeof DocumentEditor,
                              "onDirty"
                            >,
                            onSaved: saved satisfies EventHandler<
                              typeof DocumentEditor,
                              "onSaved"
                            >,
                            onDeleted: removed satisfies EventHandler<
                              typeof DocumentEditor,
                              "onDeleted"
                            >,
                            onExit: (() => navigate("home")) satisfies EventHandler<typeof DocumentEditor, "onExit">,
                            onBack: editorBack satisfies EventHandler<
                              typeof DocumentEditor,
                              "onBack"
                            >,
                          })
                        : view.value === "more"
                          ? <section className="more-page">
                              <div className="page-heading"><h1>{t("更多")}</h1></div>
                              {navigationGroups(true)}
                              {accountControls()}
                            </section>
                          : view.value === "home"
                          ? element(
                              Fragment,
                              null,
                              element(
                                "div",
                                { className: classes("page-heading") },
                                element(
                                  "div",
                                  null,

                                  element("h1", null, t("今天，写点什么？")),
                                ),
                                element(
                                  "button",
                                  {
                                    className: classes("primary"),
                                    onClick: domEvent(($event: Event) => {
                                      navigate("article");
                                    }),
                                  },
                                  element(Icon, { name: "plus" }),
                                  t("开始创作"),
                                ),
                              ),
                              element(ThreadComposer, {
                                ref: domRef(editorView),
                                onDirty: (($event) => {
                                  dirty.value = $event;
                                }) satisfies EventHandler<
                                  typeof ThreadComposer,
                                  "onDirty"
                                >,
                                onSaved: (() => {
                                  loadArticles();
                                }) satisfies EventHandler<
                                  typeof ThreadComposer,
                                  "onSaved"
                                >,
                              }),
                              showingPreview.value
                                ? element(
                                    "p",
                                    { role: "status", className: classes("notice"), "data-dashboard-preview": true },
                                    t(loadingArticles.value
                                      ? "正在检查远程内容是否有更新"
                                      : "显示上次缓存的摘要，可能已过期；最新内容读取失败，请重试。"),
                                  )
                                : null,
                              element(
                                "div",
                                { className: classes("stats-grid") },
                                renderList([
                                  {
                                    name: t("文章"),
                                    kind: "article",
                                    icon: "pen",
                                  },
                                  {
                                    name: t("动态"),
                                    kind: "thread",
                                    icon: "pen",
                                  },
                                  {
                                    name: t("合集管理"),
                                    kind: "collection",
                                    icon: "book",
                                  },
                                  {
                                    name: t("页面"),
                                    kind: "page",
                                    icon: "file",
                                  },
                                ]).map((item) =>
                                  element(
                                    "button",
                                    {
                                      key: item.kind,
                                      className: classes("card stat-card"),
                                      onClick: domEvent(($event: Event) => {
                                        navigate(item.kind);
                                      }),
                                    },
                                    element(
                                      "span",
                                      { className: classes("stat-icon") },
                                      element(Icon, { name: item.icon }),
                                    ),
                                    element(
                                      "div",
                                      null,
                                      element(
                                        "span",
                                        { className: classes("muted") },
                                        item.name,
                                      ),
                                      element(
                                        "strong",
                                        null,
                                        articlesReady.value || showingPreview.value
                                          ? countContent(item.kind)
                                          : "—",
                                      ),
                                    ),
                                    element(Icon, { name: "arrow" }),
                                  ),
                                ),
                              ),
                              data.value
                                ? element(GettingStarted, {
                                    identityKey: `${session.value.identity.method}:${session.value.identity.id}`,
                                    mode: data.value.mode,
                                    onNavigate: navigate satisfies EventHandler<
                                      typeof GettingStarted,
                                      "onNavigate"
                                    >,
                                  })
                                : null,
                              element(
                                "div",
                                { className: classes("home-grid") },
                                element(
                                  "section",
                                  { className: classes("card") },
                                  element(
                                    "div",
                                    { className: classes("card-heading") },
                                    element("h2", null, t("继续创作")),
                                    element(
                                      "button",
                                      {
                                        className: classes("text-button"),
                                        onClick: domEvent(($event: Event) => {
                                          navigate("article");
                                        }),
                                      },
                                      t("全部文章 →"),
                                    ),
                                  ),
                                  loadingArticles.value && !showingPreview.value
                                    ? element(LoadingState, {
                                        label: "正在读取内容…",
                                      })
                                    : articlesReady.value &&
                                        !articles.value.length
                                      ? element(
                                          "div",
                                          {
                                            className:
                                              classes("empty-state muted"),
                                          },
                                          t("创建第一篇文章，开始记录。"),
                                        )
                                      : null,
                                  renderList(
                                    dashboardArticles.value.slice(0, 5),
                                  ).map((item) => {
                                    const row = element(
                                      "button",
                                      {
                                        key: item.path,
                                        className: classes("content-row"),
                                        onClick: domEvent(($event: Event) => {
                                          if (open(item.path))
                                            view.value = "article";
                                        }),
                                      },
                                      element(
                                        "span",
                                        { className: classes("content-icon") },
                                        element(Icon, { name: "file" }),
                                      ),
                                      element(
                                        "span",
                                        { className: classes("content-info") },
                                        element("strong", null, item.title),
                                        item.tags.length
                                          ? element(
                                              "small",
                                              null,
                                              item.tags.join(" · "),
                                            )
                                          : null,
                                      ),
                                      element(
                                        "span",
                                        {
                                          className: classes("badge", {
                                            draft: item.draft,
                                            invalid: item.error,
                                          }),
                                        },
                                        showingPreview.value
                                          ? t("缓存摘要")
                                          : item.error
                                            ? t("需要检查")
                                            : item.render === false
                                              ? t("仅作分组")
                                              : item.draft
                                                ? t("草稿")
                                                : t("已发布"),
                                      ),
                                    );
                                    return item.error && !showingPreview.value
                                      ? <div className="library-row" key={item.path}>{row}<ErrorDetails message={item.error} source="App" /></div>
                                      : row;
                                  }),
                                ),
                                element(
                                  "section",
                                  { className: classes("card quick-links") },
                                  element("h2", null, t("打理你的站点")),

                                  renderList([
                                    {
                                      id: "site",
                                      name: t("站点信息"),
                                      icon: "globe",
                                    },
                                    {
                                      id: "navigation",
                                      name: t("导航菜单"),
                                      icon: "menu",
                                    },
                                    {
                                      id: "friends",
                                      name: t("友链管理"),
                                      icon: "link",
                                    },
                                    {
                                      id: "theme",
                                      name: t("主题维护"),
                                      icon: "palette",
                                    },
                                  ]).map((item) =>
                                    element(
                                      "button",
                                      {
                                        key: item.id,
                                        onClick: domEvent(($event: Event) => {
                                          navigate(item.id);
                                        }),
                                      },
                                      element(Icon, { name: item.icon }),
                                      item.name,
                                      element(Icon, { name: "arrow" }),
                                    ),
                                  ),
                                ),
                              ),
                            )
                          : view.value === "thread" || view.value === "topic"
                            ? element(LocalizedContentLibrary, {
                                ref: domRef(editorView),
                                key: view.value,
                                kind: view.value,
                                onDirty: (($event) => {
                                  dirty.value = $event;
                                }) satisfies EventHandler<
                                  typeof LocalizedContentLibrary,
                                  "onDirty"
                                >,
                                onOpen: open satisfies EventHandler<
                                  typeof LocalizedContentLibrary,
                                  "onOpen"
                                >,
                                onCreate: open satisfies EventHandler<
                                  typeof LocalizedContentLibrary,
                                  "onCreate"
                                >,
                                onDeleted: removed satisfies EventHandler<
                                  typeof LocalizedContentLibrary,
                                  "onDeleted"
                                >,
                              })
                            : contentKind.value
                              ? element(ContentLibrary, {
                                  key: view.value,
                                  kind: contentKind.value,
                                  folder: collectionFolder.value,
                                  onWorking: (($event) => {
                                    libraryBusy.value = $event;
                                  }) satisfies EventHandler<
                                    typeof ContentLibrary,
                                    "onWorking"
                                  >,
                                  onDeleted: removed satisfies EventHandler<
                                    typeof ContentLibrary,
                                    "onDeleted"
                                  >,
                                  onBrowse: (($event) => {
                                    collectionFolder.value = $event;
                                  }) satisfies EventHandler<
                                    typeof ContentLibrary,
                                    "onBrowse"
                                  >,
                                  onOpen: open satisfies EventHandler<
                                    typeof ContentLibrary,
                                    "onOpen"
                                  >,
                                  onCreate: open satisfies EventHandler<
                                    typeof ContentLibrary,
                                    "onCreate"
                                  >,
                                })
                              : view.value === "media"
                                ? element(MediaLibrary, null)
                                : view.value === "help"
                                  ? element(GettingStarted, {
                                      expanded: true,
                                      identityKey: `${session.value.identity.method}:${session.value.identity.id}`,
                                      mode: data.value?.mode,
                                      onNavigate:
                                        navigate satisfies EventHandler<
                                          typeof GettingStarted,
                                          "onNavigate"
                                        >,
                                    })
                                  : view.value === "native-ai"
                                    ? element(NativeAiSettings, {
                                        onDirty: (value: boolean) => {
                                          dirty.value = value;
                                        },
                                      })
                                    : view.value === "workspace"
                                      ? element(WorkspacePanel, {})
                                      : view.value === "appearance"
                                        ? <section className="settings-page" data-settings-group="appearance">
                                            <div className="page-heading"><div><h1>{t("外观样式")}</h1><p className="muted">{t("仅应用于此设备上的 Studio。")}</p></div>
                                              <button className="secondary" type="button" disabled={!Object.keys(studioAppearance.value).length} onClick={() => saveStudioAppearance({})}>{t("恢复站点默认外观")}</button>
                                            </div>
                                            {appearanceError.value && <p className="notice error" role="alert">{t("无法保存设备外观设置。当前会话仍可使用。")}</p>}
                                            <div className="card settings-card"><div className="settings-form-group"><div className="settings-grid">
                                              {blogStyleFields.map(field => <FormField key={field.path} name={field.path} label={field.label} modelValue={studioStyle.value[field.path]}
                                                onUpdateModelValue={value => saveStudioAppearance({ ...studioAppearance.value, [field.path]: String(value) })} />)}
                                            </div></div></div>
                                          </section>
                                      : element(SettingsView, {
                                          key: view.value,
                                          group: view.value,
                                          manageWorkspace: () => navigate("workspace"),
                                          onExit: (() => navigate("home")) satisfies EventHandler<typeof SettingsView, "onExit">,
                                          onDirty: (($event) => {
                                            dirty.value = $event;
                                          }) satisfies EventHandler<
                                            typeof SettingsView,
                                            "onDirty"
                                          >,
                                          onSaved:
                                            bootstrap satisfies EventHandler<
                                              typeof SettingsView,
                                              "onSaved"
                                            >,
                                        })}
                    </ViewTransition>,
                  ),
                  !props.workspaceSwitcher && element(
                    "footer",
                    { className: classes("studio-footer") },
                    t("Wonder Shine · 创作中心"),
                    " ",
                  ),
                ),
              ),
        reauthentication.value && session.value
          ? element(
              Modal,
              {
                label: t("重新登录"),
                className: "reauth-backdrop",
                blocking: true,
                initialFocus: '[name="username"]',
                returnFocus: reauthenticationFocus.value,
              },
              element(
                "p",
                { className: classes("reauth-note") },
                t("登录已过期，请重新登录。当前编辑内容已保留。"),
              ),
              element(LoginView, null),
            )
          : null,
      );
  },
  {},
);
export default App;
