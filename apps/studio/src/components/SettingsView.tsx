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
import { api, errorMessage, session } from "../api";
import { formContext } from "../form-context";
import { t, type Message } from "../i18n";
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

type Props = { group: string; embedded?: boolean; language?: string };
type Events = { dirty: [value: boolean]; saved: [] };
const SettingsView: StudioComponent<Props, Events> = component<Props, Events>(
  "SettingsView",
  (props, emit, expose) => {
    const saveMode = ref<SaveMode>(saveContext.value.defaultMode), branchPending = ref(false), savedBranch = ref("");
    const endpoint = computed(
      () =>
        `/settings/${props.group}${props.language ? `?language=${encodeURIComponent(props.language)}` : ""}`,
    );
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
    async function loadRelations() {
      relationsLoading.value = true;
      relationsError.value = "";
      try {
        const items = await api<ArticleSummary[]>("/content");
        unresolvedItems.value = items.filter((item) => item.linkWarning);
        postItems.value = items.filter(
          (item) =>
            !item.error &&
            item.kind !== "page" &&
            !/\/_index(?:\.[^.]+)?\.md$/.test(item.path),
        );
        links.value = [
          ...items
            .filter(
              (item) => !item.error && item.publicPath && item.render !== false,
            )
            .map((item) => ({ value: item.publicPath!, label: item.title })),
        ].filter(
          (item, index, all) =>
            all.findIndex((other) => other.value === item.value) === index,
        );
      } catch (e) {
        relationsError.value = errorMessage(e);
      } finally {
        relationsLoading.value = false;
      }
    }
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
      appearance: [
        {
          title: "主题与字体",
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
        definitions = groupDefinitions[props.group] || [];
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
    const ready = ref(false);
    const storageKey = `studio-settings:${session.value?.identity.method}:${session.value?.identity.id}:${props.group}:${props.language || "default"}`;
    const busy = ref(false),
      error = ref<Message>(""),
      message = ref<Message>("");
    const changes = computed(() =>
      Object.fromEntries(
        Object.entries(values.value).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify(baseline.value[key]),
        ),
      ),
    );
    const dirty = computed(() => Object.keys(changes.value).length > 0);
    watch([dirty, branchPending], ([value, pending]) => emit("dirty", value || pending), { flush: "sync" });
    watch(
      [values, baseline, () => settings.value?.revision],
      () => {
        if (!ready.value || !settings.value) return;
        try {
          if (dirty.value)
            sessionStorage.setItem(
              storageKey,
              JSON.stringify({
                values: values.value,
                baseline: baseline.value,
                revision: settings.value.revision,
              }),
            );
          else sessionStorage.removeItem(storageKey);
        } catch {
          /* The mounted form remains available when tab storage is disabled. */
        }
      },
      { deep: true },
    );
    let requestId = 0;
    async function load() {
      const id = ++requestId;
      ready.value = false;
      error.value = "";
      settings.value = null;
      message.value = "";
      try {
        const result = await api<Settings>(endpoint.value);
        if (id !== requestId) return;
        settings.value = result;
        values.value = structuredClone(result.values);
        baseline.value = structuredClone(result.values);
        try {
          const draft = JSON.parse(
            sessionStorage.getItem(storageKey) || "null",
          );
          if (
            draft?.values &&
            draft?.baseline &&
            typeof draft.revision === "string"
          ) {
            values.value = draft.values;
            baseline.value = draft.baseline;
            settings.value.revision = draft.revision;
            message.value =
              "已恢复当前标签页中的配置草稿；保存时仍会检查仓库版本。";
          }
        } catch {
          /* Invalid or unavailable tab storage does not block loading. */
        }
        ready.value = true;
      } catch (e) {
        if (id === requestId) error.value = errorMessage(e);
      }
    }
    watch(() => props.group, load, { immediate: true });
    onBeforeUnmount(() => {
      requestId++;
      emit("dirty", false);
    });
    function reload() {
      if (
        !dirty.value ||
        window.confirm(t("重新加载会丢弃当前未保存修改，继续吗？"))
      ) {
        ready.value = false;
        try {
          sessionStorage.removeItem(storageKey);
        } catch {}
        void load();
      }
    }
    async function save() {
      if (!settings.value) return;
      busy.value = true;
      error.value = "";
      message.value = "";
      const submitted = JSON.parse(JSON.stringify(values.value));
      try {
        const result = await api<SaveResult>(endpoint.value, "PUT", {
          revision: settings.value.revision,
          changes: changes.value,
          saveMode: saveMode.value,
        });
        settings.value.revision = result.revision;
        baseline.value = submitted;
        branchPending.value = result.branchPending === true;
        savedBranch.value = result.branch || "";
        message.value = result.branchPending ? "" : result.message;
        if (result.branchPending) error.value = result.message;
        else emit("saved");
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        busy.value = false;
      }
    }
    return () =>
      settings.value
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
                      pending: dirty.value,
                    }),
                  },
                  dirty.value ? t("有未保存的更改") : t("已保存"),
                ),
                element(SaveButton, {
                  mode: saveMode.value,
                  label: props.embedded ? t(saveMode.value === "branch" ? "分支保存设置" : saveMode.value === "remote" ? "远端保存设置" : "本地保存设置") : undefined,
                  onModeChange: (value: SaveMode) => { saveMode.value = value; },
                  busy: busy.value,
                  disabled: !dirty.value && !branchPending.value && saveMode.value !== "branch",
                  onSave: () => { void save(); },
                }),
              ),
            ),
            savedBranch.value ? element("code", { className: "saved-branch" }, savedBranch.value) : null,
            error.value
              ? element(
                  "p",
                  { role: "alert", className: classes("notice error") },
                  t(error.value),
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
            dirty.value
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

              relationsError.value
                ? element(
                    "p",
                    { className: classes("notice error") },
                    t("无法加载可选内容："),
                    t(relationsError.value),
                    " ",
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          loadRelations();
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
                      renderList(section.fields).map((field) =>
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
                                    values.value[field.path] = $event;
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
                                  values.value[field.path] = $event;
                                }) satisfies EventHandler<
                                  typeof FormField,
                                  "onUpdateModelValue"
                                >,
                              }),
                        ),
                      ),
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
        : error.value
          ? element(
              "p",
              { role: "alert", className: classes("notice error") },
              t(error.value),
              " ",
              element(
                "button",
                {
                  onClick: domEvent(($event: Event) => {
                    load();
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
