import { ErrorNotice } from "./ErrorNotice";
import SaveButton from "./SaveButton";
import { saveContext } from "../save-preferences";
import type { SaveMode } from "../../shared/save";
import type { Choice } from "../../shared/choices";
import type {
  ArticleSummary,
  Field,
  Json,
  SaveResult,
  Settings,
} from "../../shared/types";
import { api, apiTransportGeneration, authenticationEpoch, errorMessage, identityEpoch, session } from "../api";
import { formContext } from "../form-context";
import { locale, t, type Message } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  Fragment,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import {
  batch,
  computed,
  onBeforeUnmount,
  provide,
  ref,
  shallowRef,
  watch,
} from "../reactivity";
import FormField from "./FormField";
import LoadingState from "./LoadingState";
import ValueEditor from "./ValueEditor";
import type { ThemeUpdateCheck, ThemeUpdateResult } from "../../shared/theme-update";
import { notifyWorkspaceChanged } from "../workspace-events";

type Props = { group: string; embedded?: boolean; language?: string };
type Events = { dirty: [value: boolean]; saved: []; exit: []; manageWorkspace: [] };
const themeFields = ["extra.theme.channel", "extra.theme.pinned", "extra.theme.version"];
const SettingsView: StudioComponent<Props, Events> = component<Props, Events>(
  "SettingsView",
  (props, emit, expose) => {
    const initialIdentityEpoch = identityEpoch.value,
      initialTransportGeneration = apiTransportGeneration.value,
      initialIdentity = session.value ? { id: session.value.identity.id, method: session.value.identity.method } : null,
      initialGroup = props.group,
      initialLanguage = props.language;
    const endpoint = `/settings/${initialGroup}${initialLanguage ? `?language=${encodeURIComponent(initialLanguage)}` : ""}`;
    const storageKey = `studio-settings:${initialIdentity?.method}:${initialIdentity?.id}:${initialGroup === "theme" ? "appearance" : initialGroup}:${initialLanguage || "default"}`;
    let alive = true, observedAuthenticationEpoch = authenticationEpoch.value;
    const retired = ref(initialIdentity === null), mainNeedsReload = ref(false),
      relationsNeedsRetry = ref(false), unknownSaveObligation = ref(false);
    const ready = ref(false), busy = ref(false),
      error = ref<Message>(""), message = ref<Message>("");
    const themeCheck = shallowRef<ThemeUpdateCheck | null>(null);
    const themeOperation = ref<"check" | "apply" | null>(null), themeNeedsSync = ref(false);
    let requestId = 0, mainPending = false;
    let relationsRequestId = 0, relationsRefreshPending = false,
      relationsAuthenticationEpoch = observedAuthenticationEpoch;
    let activeSave: { authentication: number; initiated: boolean } | null = null;
    const saveMode = ref<SaveMode>(saveContext.value.defaultMode), branchPending = ref(false), savedBranch = ref("");
    function ownsInstance() {
      return alive && !retired.value && initialIdentity !== null && session.value !== null &&
        identityEpoch.value === initialIdentityEpoch &&
        apiTransportGeneration.value === initialTransportGeneration &&
        props.group === initialGroup && props.language === initialLanguage;
    }
    function reconcileBoundary() {
      if (!alive || retired.value) return;
      const owns = ownsInstance(), authentication = authenticationEpoch.value;
      if (owns && authentication === observedAuthenticationEpoch) return;
      // Revoke tokens before publishing reactive state or notifying parents.
      observedAuthenticationEpoch = authentication;
      requestId++;
      relationsRequestId++;
      const abandonedMain = mainPending;
      mainPending = false;
      batch(() => {
        if (!owns) retired.value = true;
        if (abandonedMain) mainNeedsReload.value = true;
        if (relationsLoading.value) relationsNeedsRetry.value = true;
        relationsLoading.value = false;
        themeCheck.value = null;
        if (activeSave?.initiated) unknownSaveObligation.value = true;
      });
    }
    function canInteract() {
      reconcileBoundary();
      return ownsInstance();
    }
    function exit() {
      reconcileBoundary();
      if (alive) emit("exit");
    }
    const settings = shallowRef<Settings | null>(null),
      values = ref<Record<string, Json>>({}),
      baseline = ref<Record<string, Json>>({});
    const unresolvedItems = ref<ArticleSummary[]>([]);
    const unresolved = computed(() =>
      unresolvedItems.value.map(
        (item) => `${item.title}: ${t(item.linkWarning)}`,
      ),
    );
    const postItems = ref<ArticleSummary[]>([]);
    const posts = computed<Choice[]>(() =>
      postItems.value.map((item) => ({
        value: item.path.replace(/^content\//, ""),
        label: `${item.title} · ${t("文件位置")}：${item.path.replace(/^content\//, "")}`,
      })),
    );
    const links = ref<Choice[]>([]),
      relationsLoading = ref(false),
      relationsError = ref<Message>("");
    const siteLinks = computed(() => [
      { value: "/", label: t("首页") },
      ...links.value.filter((item) => item.value !== "/"),
    ]);
    provide(formContext, {
      unresolved,
      posts,
      links: siteLinks,
      values,
      loading: relationsLoading,
      error: relationsError,
    });
    async function loadRelations(refresh = false) {
      if (!canInteract()) return;
      const id = ++relationsRequestId, authentication = authenticationEpoch.value;
      const current = () => ownsInstance() && authentication === authenticationEpoch.value && id === relationsRequestId;
      relationsAuthenticationEpoch = authentication;
      relationsRefreshPending = relationsRefreshPending || refresh;
      batch(() => {
        relationsLoading.value = true;
        relationsError.value = "";
        relationsNeedsRetry.value = false;
      });
      try {
        if (!current()) return;
        const items = await api<ArticleSummary[]>("/content" + (relationsRefreshPending ? "?refresh=1" : ""));
        if (!current()) return;
        const nextUnresolved = items.filter((item) => item.linkWarning);
        const nextPosts = items.filter(
          (item) =>
            !item.error &&
            item.kind !== "page" &&
            !/\/_index(?:\.[^.]+)?\.md$/.test(item.path),
        );
        const nextLinks = [
          ...items
            .filter(
              (item) => !item.error && item.publicPath && item.render !== false,
            )
            .map((item) => ({ value: item.publicPath!, label: item.title })),
        ].filter(
          (item, index, all) =>
            all.findIndex((other) => other.value === item.value) === index,
        );
        if (!current()) return;
        batch(() => {
          unresolvedItems.value = nextUnresolved;
          postItems.value = nextPosts;
          links.value = nextLinks;
        });
      } catch (e) {
        const notice = errorMessage(e);
        if (current()) relationsError.value = notice;
      } finally {
        if (current()) {
          relationsRefreshPending = false;
          relationsLoading.value = false;
        }
      }
    }
    watch([
      identityEpoch, apiTransportGeneration, authenticationEpoch,
      () => props.group, () => props.language,
    ], reconcileBoundary);
    watch(locale, () => {
      // Loaded options and settled errors survive presentation-only changes.
      // A pending replacement retains any unfinished forced-refresh obligation.
      if (!canInteract()) return;
      if (relationsLoading.value && relationsAuthenticationEpoch === authenticationEpoch.value)
        void loadRelations();
    });
    void loadRelations();
    // Presentation groups only: schema keys and saved values remain unchanged.
    const groupDefinitions: Record<
      string,
      {
        title: string;
        paths: string[];
      }[]
    > = {
      site: [
        {
          title: "基本信息",
          paths: [
            "title",
            "author",
            "base_url",
            "default_language",
            "description",
            "extra.site.seo",
          ],
        },
        {
          title: "站点视觉",
          paths: [
            "extra.site.logo",
            "extra.site.favicon",
            "extra.site.default_cover",
            "extra.site.author.avatar",
            "extra.site.author.about_image",
          ],
        },
        {
          title: "联系与备案",
          paths: [
            "extra.site.email",
            "extra.site.start_year",
            "extra.site.compliance_icp",
            "extra.site.compliance_security",
            "extra.site.compliance_security_link",
          ],
        },
      ],
      theme: [
        { title: "主题版本", paths: themeFields },
        {
          title: "博客样式",
          paths: [
            "extra.style.theme_light_skin",
            "extra.style.theme_dark_skin",
            "extra.style.color_scheme",
            "extra.style.font_family",
          ],
        },
        { title: "显示效果", paths: ["extra.style.universe"] },
      ],
      recommendations: [
        { title: "推荐内容", paths: ["post.recommend_posts"] },
        {
          title: "今日推荐",
          paths: [
            "post.today_recommend.post_path",
            "post.today_recommend.title",
            "post.today_recommend.small_title",
            "post.today_recommend.url",
            "post.today_recommend.cover",
          ],
        },
      ],
      about: [
        {
          title: "个人介绍",
          paths: [
            "extra.about.hello",
            "extra.about.content",
            "extra.about.idea",
          ],
        },
        {
          title: "个人标签与经历",
          paths: [
            "extra.about.author_info_left_tags",
            "extra.about.author_info_right_tags",
            "extra.about.careers",
            "extra.about.map",
          ],
        },
        {
          title: "生活与偏好",
          paths: [
            "extra.about.photos",
            "extra.about.hobbies",
            "extra.about.like",
            "extra.about.music",
          ],
        },
        {
          title: "页面布局",
          paths: [
            "extra.about.widget_list",
            "extra.about.textarea_left",
            "extra.about.textarea_right",
          ],
        },
      ],
    };
    const fieldGroups = computed(() => {
      const fields = settings.value?.fields || [],
        definitions = groupDefinitions[initialGroup] || [];
      const used = new Set<string>(),
        groups: {
          title: string;
          fields: Field[];
        }[] = [];
      for (const definition of definitions) {
        const members = definition.paths.flatMap((path) => {
          const field = fields.find((field) => field.path === path);
          return field ? [field] : [];
        });
        if (!members.length) continue;
        members.forEach((field) => used.add(field.path));
        groups.push({ title: definition.title, fields: members });
      }
      const remaining = fields.filter((field) => !used.has(field.path));
      if (remaining.length) groups.push({ title: "", fields: remaining });
      return groups;
    });
    const changes = computed(() =>
      Object.fromEntries(
        Object.entries(values.value).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(baseline.value[key]),
        ),
      ),
    );
    const dirty = computed(() => Object.keys(changes.value).length > 0);
    const themeDirty = computed(() => themeFields.some(path => Object.hasOwn(changes.value, path)));
    watch(() => dirty.value || branchPending.value || unknownSaveObligation.value, () => {
      reconcileBoundary();
      const obligation = dirty.value || branchPending.value || unknownSaveObligation.value;
      if (alive && (ownsInstance() || obligation)) emit("dirty", obligation);
    }, { flush: "sync" });
    watch(
      [values, baseline, () => settings.value?.revision],
      () => {
        if (!canInteract() || !ready.value || !settings.value) return;
        try {
          const draft = dirty.value ? JSON.stringify({
            values: values.value,
            baseline: baseline.value,
            revision: settings.value.revision,
          }) : null;
          if (!ownsInstance()) return;
          if (draft !== null) sessionStorage.setItem(storageKey, draft);
          else if (!unknownSaveObligation.value) sessionStorage.removeItem(storageKey);
        } catch {
          /* The mounted form remains available when tab storage is disabled. */
        }
      },
      { deep: true },
    );
    async function load(discard = false) {
      if (!canInteract() || ready.value || busy.value || unknownSaveObligation.value || branchPending.value || (dirty.value && !discard)) return;
      const id = ++requestId, authentication = authenticationEpoch.value;
      const current = () => ownsInstance() && authentication === authenticationEpoch.value && id === requestId;
      mainPending = true;
      batch(() => {
        ready.value = false;
        error.value = "";
        settings.value = null;
        message.value = "";
        themeCheck.value = null;
        mainNeedsReload.value = false;
      });
      try {
        if (!current()) return;
        const result = await api<Settings>(endpoint);
        if (!current()) return;
        let nextValues = structuredClone(result.values), nextBaseline = structuredClone(result.values),
          nextRevision = result.revision, restored = false;
        try {
          const draft = JSON.parse(sessionStorage.getItem(storageKey) || "null");
          if (draft?.values && draft?.baseline && typeof draft.revision === "string") {
            nextValues = draft.values;
            nextBaseline = draft.baseline;
            nextRevision = draft.revision;
            restored = true;
          }
        } catch {
          /* Invalid or unavailable tab storage does not block loading. */
        }
        if (!current()) return;
        mainPending = false;
        batch(() => {
          settings.value = { ...result, revision: nextRevision };
          values.value = nextValues;
          baseline.value = nextBaseline;
          message.value = restored ? "已恢复当前标签页中的配置草稿；保存时仍会检查仓库版本。" : "";
          ready.value = true;
        });
      } catch (e) {
        const notice = errorMessage(e);
        if (current()) {
          mainPending = false;
          error.value = notice;
        }
      } finally {
        if (current()) mainPending = false;
      }
    }
    void load();
    onBeforeUnmount(() => {
      alive = false;
      requestId++;
      relationsRequestId++;
      emit("dirty", false);
    });
    function reload() {
      if (!canInteract() || busy.value) return;
      const authentication = authenticationEpoch.value;
      if ((dirty.value || branchPending.value || unknownSaveObligation.value) &&
        !window.confirm(t("重新加载会丢弃当前未保存修改，继续吗？"))) return;
      if (!canInteract() || busy.value || authentication !== authenticationEpoch.value) return;
      try {
        sessionStorage.removeItem(storageKey);
      } catch {}
      // Storage hooks and parent notifications can synchronously change authority.
      if (!canInteract() || busy.value || authentication !== authenticationEpoch.value) return;
      batch(() => {
        ready.value = false;
        branchPending.value = false;
        unknownSaveObligation.value = false;
      });
      if (!ownsInstance() || authentication !== authenticationEpoch.value) return;
      void load(true);
      if (ownsInstance() && authentication === authenticationEpoch.value) void loadRelations(true);
    }
    async function save() {
      if (!canInteract() || !ready.value || !settings.value || busy.value || unknownSaveObligation.value) return;
      const operation = { authentication: authenticationEpoch.value, initiated: false };
      const submitted = JSON.parse(JSON.stringify(values.value));
      const input = {
        revision: settings.value.revision,
        changes: JSON.parse(JSON.stringify(changes.value)),
        saveMode: saveMode.value,
      };
      const current = () => ownsInstance() && operation.authentication === authenticationEpoch.value && activeSave === operation;
      activeSave = operation;
      batch(() => {
        busy.value = true;
        error.value = "";
        message.value = "";
        themeCheck.value = null;
      });
      try {
        if (!current()) return;
        operation.initiated = true;
        const result = await api<SaveResult & { pinnedThemeVersion?: string | null }>(endpoint, "PUT", input);
        if (!current()) return;
        batch(() => {
          settings.value = { ...settings.value!, revision: result.revision };
          if (result.pinnedThemeVersion !== undefined) {
            const key = "extra.theme.version";
            if ([key, "extra.theme.channel", "extra.theme.pinned"].every(path => values.value[path] === submitted[path])) {
              values.value[key] = result.pinnedThemeVersion ?? "";
            }
            submitted[key] = result.pinnedThemeVersion ?? "";
          }
          baseline.value = submitted;
          branchPending.value = result.branchPending === true;
          savedBranch.value = result.branch || "";
          message.value = result.branchPending ? "" : result.message;
          if (result.branchPending) error.value = result.message;
          operation.initiated = false;
        });
        if (current() && !result.branchPending) emit("saved");
      } catch (e) {
        const notice = errorMessage(e);
        if (current()) {
          operation.initiated = false;
          error.value = notice;
        }
      } finally {
        // Settlement owns busy, even when this operation can no longer adopt data.
        reconcileBoundary();
        if (alive && activeSave === operation) {
          activeSave = null;
          busy.value = false;
        }
      }
    }
    async function updateTheme(apply: boolean) {
      if (!canInteract() || !ready.value || !settings.value || busy.value || themeDirty.value || branchPending.value || unknownSaveObligation.value) return;
      const check = themeCheck.value;
      if (apply && (!check || (check.revision ?? "") !== settings.value.revision)) return;
      if (!apply) themeCheck.value = null;
      const operation = { authentication: authenticationEpoch.value, initiated: false };
      const current = () => ownsInstance() && operation.authentication === authenticationEpoch.value && activeSave === operation;
      activeSave = operation;
      batch(() => {
        busy.value = true;
        themeOperation.value = apply ? "apply" : "check";
        error.value = "";
        message.value = "";
      });
      try {
        if (!current()) return;
        if (!check || !apply) {
          const result = await api<ThemeUpdateCheck>("/theme-update");
          if (!current()) return;
          if ((result.revision ?? "") !== settings.value?.revision) {
            error.value = "主题设置已变化，请重新加载后检查更新";
          } else themeCheck.value = result;
          return;
        }
        operation.initiated = true;
        const result = await api<ThemeUpdateResult>("/theme-update", "POST", { revision: check.revision, channelVersion: check.channelVersion });
        if (!current()) return;
        operation.initiated = false;
        batch(() => {
          settings.value = { ...settings.value!, revision: result.revision };
          if (result.pinnedThemeVersion) {
            const path = "extra.theme.version";
            if (!themeDirty.value) values.value[path] = result.pinnedThemeVersion;
            baseline.value[path] = result.pinnedThemeVersion;
          }
          themeCheck.value = null;
          themeNeedsSync.value = check.destination === "workspace";
          if (result.localCommitPending) error.value = result.message;
          else message.value = result.message;
        });
        if (current() && check.destination === "workspace") notifyWorkspaceChanged();
      } catch (reason) {
        if (current()) {
          operation.initiated = false;
          error.value = errorMessage(reason);
          themeCheck.value = null;
        }
      } finally {
        reconcileBoundary();
        if (alive && activeSave === operation) {
          activeSave = null;
          busy.value = false;
          themeOperation.value = null;
        }
      }
    }
    function themeUpdateControls() {
      const check = themeCheck.value;
      const disabled = busy.value || themeDirty.value || branchPending.value || unknownSaveObligation.value;
      const sameVersion = check?.pinned && check.currentVersion === check.channelVersion;
      return <div className="full-width theme-update-controls">
        <div className="row">
          <button className="secondary" type="button" disabled={disabled} onClick={() => void updateTheme(false)}>
            {t(themeOperation.value === "check" ? "正在检查更新…" : "检查更新")}
          </button>
          {check && !sameVersion && <button className="primary" type="button" disabled={disabled} onClick={() => void updateTheme(true)}>
            {t(themeOperation.value === "apply" ? "正在应用主题更新…" : check.pinned ? "更新到此版本" : "请求重新构建")}
          </button>}
          {themeNeedsSync.value && <button className="secondary" type="button" disabled={busy.value} onClick={() => emit("manageWorkspace")}>
            {t("前往工作区同步")}
          </button>}
        </div>
        {themeDirty.value ? <p className="muted small">{t("保存版本设置后可检查更新。")}</p> : check && <div role="status" className="small">
          {check.pinned && check.currentVersion && <p>{t("已固定版本 {version}", { version: check.currentVersion })}</p>}
          <p>{t("渠道当前版本 {version}", { version: check.channelVersion })}</p>
          <p className="muted">{t(sameVersion ? "已是该渠道当前版本" : !check.pinned ? "已部署版本未知。重新构建时会使用渠道当时的版本。"
            : check.destination === "remote" ? "确认后将提交并推送版本变更。" : check.destination === "workspace" ? "确认后将提交版本变更，随后可在工作区同步。" : "确认后将写入版本设置。")}</p>
          {!check.pinned && <p className="muted">{t(check.destination === "remote" ? "确认后将提交并推送重建请求。"
            : check.destination === "workspace" ? "确认后将提交重建请求，随后可在工作区同步。" : "确认后将写入重建注释，供你提交。")}</p>}
        </div>}
      </div>;
    }
    const exitControl = () => element("button", {
      className: classes("text-button settings-exit"),
      onClick: domEvent(exit),
    }, t("返回工作台"));
    return () =>
      !ownsInstance()
        ? element("section", { className: classes("notice settings-retired"), role: "status" },
            element("p", null, t("当前会话或连接已更换，此设置页已停用。")),
            exitControl())
        : settings.value
        ? element(
            "section",
            {
              "data-settings-group": props.group,
              className: classes("settings-page", {
                "embedded-settings": props.embedded,
              }),
            },
            element(
              "div",
              { className: classes("page-heading") },
              element(
                "div",
                null,

                element(
                  props.embedded ? "h3" : "h1",
                  null,
                  t(settings.value.title),
                ),
              ),
              element(
                "div",
                { className: classes("row settings-save-actions") },
                element(
                  "span",
                  {
                    role: "status",
                    className: classes("settings-state", {
                      pending: dirty.value || branchPending.value || unknownSaveObligation.value,
                    }),
                  },
                  dirty.value || branchPending.value || unknownSaveObligation.value ? t("有未保存的更改") : t("已保存"),
                ),
                element(SaveButton, {
                  mode: saveMode.value,
                  label: props.embedded ? t(saveMode.value === "branch" ? "分支保存设置" : saveMode.value === "remote" ? "远端保存设置" : "本地保存设置") : undefined,
                  onModeChange: (value: SaveMode) => { if (canInteract()) saveMode.value = value; },
                  canInteract,
                  busy: busy.value,
                  disabled: unknownSaveObligation.value || (!dirty.value && !branchPending.value && saveMode.value !== "branch"),
                  onSave: () => { void save(); },
                }),
              ),
            ),
            unknownSaveObligation.value
              ? element("p", { role: "status", className: classes("notice") },
                  t(busy.value
                    ? "登录信息已更新，先前保存的结果暂时无法确认。请等待保存请求结束。"
                    : "先前保存的结果无法确认，当前表单和版本信息未更新。"))
              : null,
            exitControl(),
            savedBranch.value ? element("code", { className: "saved-branch" }, savedBranch.value) : null,
            error.value
              ? element(
                  ErrorNotice,
                  { source: "SettingsView", message: error.value },
                  " ",
                  element(
                    "button",
                    {
                      className: classes("text-button"),
                      onClick: domEvent(($event: Event) => {
                        reload();
                      }),
                    },
                    t("重新加载"),
                  ),
                )
              : null,
            message.value
              ? element(
                  "p",
                  { role: "status", className: classes("notice success") },
                  t(message.value),
                )
              : null,
            dirty.value || unknownSaveObligation.value || branchPending.value
              ? element(
                  "button",
                  {
                    className: classes("text-button settings-discard"),
                    onClick: domEvent(($event: Event) => {
                      reload();
                    }),
                  },
                  t("放弃更改并重新加载"),
                )
              : null,
            element(
              "div",
              { className: classes("card settings-card") },

              relationsError.value || relationsNeedsRetry.value
                ? element(
                    ErrorNotice,
                    { source: "SettingsView", message: relationsError.value || "登录信息已更新，请重试加载选项。", prefix: relationsError.value ? t("无法加载可选内容：") : undefined },
                    " ",
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          loadRelations(true);
                        }),
                      },
                      t("重试选项"),
                    ),
                  )
                : null,
              element(
                "div",
                { className: classes("settings-groups") },
                renderList(fieldGroups.value).map((section, index) =>
                  element(
                    "section",
                    {
                      key: section.title || index,
                      className: classes("settings-form-group", {
                        "has-heading": section.title,
                      }),
                    },
                    section.title
                      ? element(
                          "header",
                          { className: classes("settings-group-heading") },

                          element("h3", null, t(section.title)),
                        )
                      : null,
                    element(
                      "div",
                      { className: classes("settings-grid") },
                      renderList(section.fields.filter(field => field.path !== "extra.theme.version" || values.value["extra.theme.pinned"])).map((field) =>
                        element(
                          Fragment,
                          { key: field.path },
                          field.kind === "structured"
                            ? element(
                                "div",
                                { className: classes("full-width") },
                                element(ValueEditor, {
                                  modelValue: values.value[field.path],
                                  name: field.path,
                                  label: t(field.label),
                                  sprite: String(
                                    values.value["skill.svg_sprite"] || "",
                                  ),
                                  onUpdateModelValue: (($event) => {
                                    if (canInteract()) values.value[field.path] = $event;
                                  }) satisfies EventHandler<
                                    typeof ValueEditor,
                                    "onUpdateModelValue"
                                  >,
                                }),
                              )
                            : element(FormField, {
                                modelValue: values.value[field.path],
                                name: field.path,
                                label: t(field.label),
                                kind: field.kind,
                                hint: t(field.hint),
                                className: classes({
                                  "full-width": field.kind === "textarea",
                                }),
                                onUpdateModelValue: (($event) => {
                                  if (!canInteract()) return;
                                  if (field.path === "extra.theme.channel" || (field.path === "extra.theme.pinned" && !$event)) {
                                    values.value["extra.theme.version"] = "";
                                  }
                                  values.value[field.path] = $event;
                                }) satisfies EventHandler<
                                  typeof FormField,
                                  "onUpdateModelValue"
                                >,
                              }),
                        ),
                      ),
                      initialGroup === "theme" && section.title === "主题版本" ? themeUpdateControls() : null,
                    ),
                  ),
                ),
              ),
            ),

            settings.value.id === "taxonomies"
              ? element(
                  "p",
                  { className: classes("muted small") },
                  t("删除名称不会移除已有内容中的标签或分类。"),
                )
              : null,
          )
        : mainNeedsReload.value
          ? element("section", { className: classes("notice"), role: "status" },
              element("p", null, t("登录信息已更新，请重新加载设置。")),
              element("button", { className: classes("text-button"), onClick: domEvent(reload) }, t("重新加载")),
              exitControl())
          : error.value
          ? element(
              ErrorNotice,
              { source: "SettingsView", message: error.value },
              " ",
              element(
                "button",
                {
                  onClick: domEvent(($event: Event) => {
                    reload();
                  }),
                },
                t("重试"),
              ),
            )
          : element(LoadingState, { label: "正在读取配置…" });
  },
  {},
);
export default SettingsView;
