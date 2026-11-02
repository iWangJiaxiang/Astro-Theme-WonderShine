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
import LoadingState from "./components/LoadingState";
import { mediaUploading } from "./media-store";
import { t, type Message } from "./i18n";
import { ref, watch, onMounted, onBeforeUnmount, computed } from "./reactivity";
import type { Json, ArticleSummary } from "../shared/types";
import { api, session, reauthentication, errorMessage } from "./api";
import LoginView from "./components/LoginView";
import SettingsView from "./components/SettingsView";
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

type Props = {};
type Events = {};
const App: StudioComponent<Props, Events> = component<Props, Events>(
  "App",
  (props, emit, expose) => {
    type Bootstrap = {
      site: Record<string, Json>;
      appearance: Record<string, Json>;
      mode: string;
      workspace?: boolean;
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
      menuOpen = ref(false),
      dark = ref(false);
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
    let generation = 0;
    const libraryArticles = computed(() =>
      sortLibrary(
        articles.value.filter(
          (item) => item.kind === "article" && isLibraryItem(item),
        ),
        "article",
      ),
    );
    function countContent(kind: string) {
      return articles.value.filter(
        (item) =>
          item.kind === kind &&
          isLibraryItem(item) &&
          (kind !== "collection" || isSection(item)),
      ).length;
    }
    const navigation = [
      { id: "home", label: "工作台", icon: "home" },
      { id: "article", label: "文章", icon: "pen" },
      { id: "thread", label: "动态", icon: "pen" },
      { id: "topic", label: "话题管理", icon: "tag" },
      { id: "collection", label: "合集管理", icon: "book" },
      { id: "page", label: "页面", icon: "file" },
      { id: "media", label: "媒体库", icon: "image" },
      { id: "native-ai", label: "客户端 API 设置", icon: "star" },
      { id: "workspace", label: "工作区同步", icon: "globe" },
      { id: "help", label: "使用指南", icon: "book" },
    ];
    const icons: Record<string, string> = {
      site: "globe",
      navigation: "menu",
      friends: "link",
      about: "user",
      taxonomies: "tag",
      recommendations: "star",
      appearance: "palette",
    };
    const contentKind = computed(() =>
      ["article", "page", "collection"].includes(view.value)
        ? (view.value as "article" | "page" | "collection")
        : null,
    );
    const siteUrl = computed(() => {
      try {
        const url = new URL(String(data.value?.site.base_url));
        return ["https:", "http:"].includes(url.protocol) ? url.href : null;
      } catch {
        return null;
      }
    });
    function applyTheme() {
      const appearance = data.value?.appearance;
      window.document.documentElement.dataset.theme = dark.value
        ? "dark"
        : "light";
      const color =
        appearance?.[
          dark.value
            ? "extra.style.theme_dark_skin"
            : "extra.style.theme_light_skin"
        ];
      if (typeof color === "string" && /^#[a-f0-9]{6}$/i.test(color))
        window.document.documentElement.style.setProperty("--wjx-theme", color);
      const font = appearance?.["extra.style.font_family"];
      if (typeof font === "string")
        window.document.documentElement.style.fontFamily = `${font}, -apple-system, BlinkMacSystemFont, sans-serif`;
    }
    watch(dark, applyTheme);
    async function bootstrap() {
      const current = generation;
      loadingSite.value = true;
      try {
        const result = await api<Bootstrap>("/bootstrap");
        if (current !== generation) return;
        configureSaving(`${session.value?.identity.id}:${result.saveScope}`, result.saveCapabilities);
        data.value = result;
        const scheme = result.appearance["extra.style.color_scheme"];
        dark.value =
          scheme === "dark" ||
          (scheme === "system" &&
            matchMedia("(prefers-color-scheme: dark)").matches);
        applyTheme();
      } catch (e) {
        if (current === generation) error.value = errorMessage(e);
      } finally {
        if (current === generation) loadingSite.value = false;
      }
    }
    async function loadArticles(refresh = false) {
      const current = generation;
      loadingArticles.value = true;
      try {
        const result = await api<ArticleSummary[]>(
          "/content" + (refresh ? "?refresh=1" : ""),
        );
        if (current === generation) {
          articles.value = result;
          articlesReady.value = true;
        }
      } catch (e) {
        if (current === generation) error.value = errorMessage(e);
      } finally {
        if (current === generation) loadingArticles.value = false;
      }
    }
    async function reloadWorkspace() {
      if (loadingSite.value || loadingArticles.value) return;
      error.value = "";
      await Promise.all([loadArticles(true), bootstrap()]);
    }
    watch(session, async (value) => {
      generation++;
      if (value) {
        error.value = "";
        await Promise.all([bootstrap(), loadArticles()]);
      } else {
        data.value = null;
        articles.value = [];
        articlesReady.value = false;
        loadingArticles.value = false;
        loadingSite.value = false;
        document.value = null;
        view.value = "home";
        dirty.value = false;
        error.value = "";
      }
    });
    onMounted(async () => {
      try {
        session.value = await api("/auth/session");
      } catch {
        /* Login is shown for an absent session. */
      } finally {
        checking.value = false;
      }
    });
    function leave() {
      if (libraryBusy.value || editorView.value?.isBusy?.()) {
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
    function navigate(next: string) {
      if (!leave()) return;
      document.value = null;
      dirty.value = false;
      view.value = next;
      menuOpen.value = false;
      if (next === "home") void loadArticles();
    }
    function open(
      path: string,
      initial?: Record<string, Json>,
      initialBody?: string,
    ) {
      if (!leave()) return false;
      document.value = {
        path,
        initial,
        initialBody,
        mode: !initial && path.startsWith("content/threads/") ? "detail" : "edit",
      };
      dirty.value = false;
      return true;
    }
    function edit(
      path: string,
      initial?: Record<string, Json>,
      initialBody?: string,
    ) {
      if (!leave()) return;
      document.value = { path, initial, initialBody, mode: "edit" };
      dirty.value = false;
    }
    function saved(path: string) {
      if (document.value?.path === path) {
        document.value.initial = undefined;
        document.value.initialBody = undefined;
      }
      void loadArticles();
    }
    function removed(path: string) {
      if (document.value?.path === path) {
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
        libraryBusy.value ||
        mediaUploading.value ||
        editorView.value?.isBusy?.()
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", beforeUnload);
    onBeforeUnmount(() =>
      window.removeEventListener("beforeunload", beforeUnload),
    );
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
                },
                menuOpen.value
                  ? element("button", {
                      "aria-label": t("关闭导航"),
                      className: classes("sidebar-backdrop"),
                      onClick: domEvent(($event: Event) => {
                        menuOpen.value = false;
                      }),
                    })
                  : null,
                element(
                  "aside",
                  { className: classes("sidebar", { open: menuOpen.value }) },
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
                  element(
                    "div",
                    { className: classes("sidebar-navigation") },
                    element(
                      "p",
                      { className: classes("nav-label") },
                      t("创作空间"),
                    ),
                    element(
                      "nav",
                      { "aria-label": t("内容导航") },
                      renderList(
                        navigation.filter(
                          (item) =>
                            (item.id !== "workspace" ||
                              data.value?.workspace) &&
                            (item.id !== "native-ai" || data.value?.nativeAi),
                        ),
                      ).map((item) =>
                        element(
                          "button",
                          {
                            key: item.id,
                            className: classes({
                              active: view.value === item.id,
                            }),
                            onClick: domEvent(($event: Event) => {
                              navigate(item.id);
                            }),
                          },
                          element(Icon, { name: item.icon }),
                          t(item.label),
                          view.value === item.id
                            ? element("span", {
                                className: classes("nav-indicator"),
                              })
                            : null,
                        ),
                      ),
                    ),
                    element(
                      "p",
                      { className: classes("nav-label") },
                      t("站点管理"),
                    ),
                    loadingSite.value && !data.value
                      ? element(LoadingState, {
                          label: "正在加载站点…",
                          compact: true,
                        })
                      : null,
                    element(
                      "nav",
                      { "aria-label": t("站点设置") },
                      renderList(data.value?.groups).map((group) =>
                        element(
                          "button",
                          {
                            key: group.id,
                            className: classes({
                              active: view.value === group.id,
                            }),
                            onClick: domEvent(($event: Event) => {
                              navigate(group.id);
                            }),
                          },
                          element(Icon, { name: icons[group.id] || "file" }),
                          t(group.title),
                        ),
                      ),
                    ),
                  ),
                  element(
                    "div",
                    { className: classes("sidebar-bottom") },
                    element(
                      "span",
                      { className: classes("avatar") },
                      session.value.identity.name.slice(0, 1).toUpperCase(),
                    ),
                    element(
                      "div",
                      null,
                      element("strong", null, session.value.identity.name),
                      element(
                        "small",
                        null,
                        session.value.identity.method === "oidc"
                          ? t("OIDC 管理员")
                          : t("站点管理员"),
                      ),
                    ),
                    element(
                      "button",
                      {
                        "aria-label": t("退出登录"),
                        className: classes("icon-button"),
                        onClick: domEvent(($event: Event) => {
                          logout();
                        }),
                      },
                      element(Icon, { name: "logout" }),
                    ),
                  ),
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
                        "button",
                        {
                          "aria-label": t("打开导航"),
                          className: classes("icon-button mobile-menu"),
                          onClick: domEvent(($event: Event) => {
                            menuOpen.value = !menuOpen.value;
                          }),
                        },
                        element(Icon, { name: "menu" }),
                      ),
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
                                navigation.find((n) => n.id === view.value)
                                  ?.label ||
                                  data.value?.groups.find(
                                    (g) => g.id === view.value,
                                  )?.title,
                              ),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("row topbar-actions") },
                      element(LanguageSwitcher, null),
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
                      element(
                        "button",
                        {
                          "aria-label": t("切换明暗模式"),
                          className: classes("icon-button"),
                          onClick: domEvent(($event: Event) => {
                            dark.value = !dark.value;
                          }),
                        },
                        element(Icon, { name: dark.value ? "sun" : "moon" }),
                      ),
                      siteUrl.value
                        ? element(
                            "a",
                            {
                              href: siteUrl.value,
                              target: "_blank",
                              rel: "noopener noreferrer",
                              className: classes("visit-site"),
                            },
                            t("访问主站 ↗"),
                          )
                        : null,
                    ),
                  ),
                  element(
                    "main",
                    { className: classes("main-content") },
                    error.value
                      ? element(
                          "p",
                          { role: "alert", className: classes("notice error") },
                          t(error.value),
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
                    document.value?.mode === "detail"
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
                            onBack: editorBack satisfies EventHandler<
                              typeof DocumentEditor,
                              "onBack"
                            >,
                          })
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
                                        articlesReady.value
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
                                  loadingArticles.value
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
                                    libraryArticles.value.slice(0, 5),
                                  ).map((item) =>
                                    element(
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
                                        item.error
                                          ? t("需要检查")
                                          : item.render === false
                                            ? t("仅作分组")
                                            : item.draft
                                              ? t("草稿")
                                              : t("已发布"),
                                      ),
                                    ),
                                  ),
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
                                      id: "appearance",
                                      name: t("外观样式"),
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
                              element(
                                "p",
                                {
                                  className: classes(
                                    "muted small workspace-note",
                                  ),
                                },
                                t("已发布的内容会在下次网站部署后上线。"),
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
                                      : element(SettingsView, {
                                          key: view.value,
                                          group: view.value,
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
                                        }),
                  ),
                  element(
                    "footer",
                    { className: classes("studio-footer") },
                    t("Wonder Shine · 创作中心"),
                    " ",
                  ),
                ),
              ),
        reauthentication.value && session.value
          ? element(
              "div",
              {
                role: "dialog",
                "aria-modal": "true",
                "aria-label": t("重新登录"),
                className: classes("reauth-backdrop"),
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
