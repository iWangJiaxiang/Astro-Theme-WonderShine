import { isLibraryItem } from "../../shared/library";
import type { ArticleSummary, Json } from "../../shared/types";
import { api, errorMessage } from "../api";
import {
  newThread,
  newTopic,
  unclassifiedContentErrors,
  type ContentLanguages,
  type LocalizedKind,
} from "../content-model";
import { locale, t, type Message } from "../i18n";
import "../thread-detail.css";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  renderList,
  type EditorHandle,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, onMounted, ref, watch } from "../reactivity";
import DeleteContentDialog from "./DeleteContentDialog";
import Icon from "./Icon";
import LoadingState from "./LoadingState";
import ThreadComposer from "./ThreadComposer";
import SelectionField from "./SelectionField";

type Props = { kind: LocalizedKind };
type Events = {
  open: [path: string];
  create: [path: string, initial: Record<string, Json>];
  dirty: [value: boolean];
  deleted: [path: string];
};
const LocalizedContentLibrary: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "LocalizedContentLibrary",
  (props, emit, expose) => {
    const composer = ref<EditorHandle>();
    const pendingDelete = ref<ArticleSummary>(),
      deleting = ref(false),
      composerDirty = ref(false);
    function openItem(path: string) {
      emit("open", path);
    }
    function changed(value: boolean) {
      composerDirty.value = value;
      emit("dirty", value);
    }
    async function deleted(path: string) {
      pendingDelete.value = undefined;
      await composer.value?.forget(path);
      emit("deleted", path);
      await load();
    }
    expose({
      flush: () => composer.value?.flush(),
      isBusy: () => deleting.value || composer.value?.isBusy() || false,
    });
    const items = ref<ArticleSummary[]>([]),
      languages = ref<ContentLanguages>(),
      language = ref(""),
      search = ref(""),
      status = ref("all");
    const loading = ref(true),
      error = ref<Message>(""),
      page = ref(1);
    const unclassified = computed(() =>
      unclassifiedContentErrors(items.value, props.kind),
    );
    const filtered = computed(() =>
      items.value
        .filter(
          (item) =>
            item.lang === language.value &&
            [item.title, item.description, ...item.tags]
              .join(" ")
              .toLowerCase()
              .includes(search.value.trim().toLowerCase()) &&
            (status.value === "all" ||
              (status.value === "draft"
                ? item.draft
                : !item.draft && !item.error)),
        )
        .sort(
          (a, b) =>
            (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) ||
            a.path.localeCompare(b.path),
        ),
    );
    const pages = computed(() =>
      Math.max(1, Math.ceil(filtered.value.length / 20)),
    );
    const rows = computed(() =>
      filtered.value.slice((page.value - 1) * 20, page.value * 20),
    );
    watch([language, status, search], () => {
      page.value = 1;
    });
    async function load(refresh = false) {
      loading.value = true;
      error.value = "";
      try {
        const [content, config] = await Promise.all([
          api<ArticleSummary[]>(`/content${refresh ? "?refresh=1" : ""}`),
          api<ContentLanguages>("/content-languages"),
        ]);
        items.value = content.filter(
          (item) => item.kind === props.kind && isLibraryItem(item),
        );
        languages.value = config;
        if (!config.languages.includes(language.value))
          language.value = config.defaultLanguage;
        page.value = Math.min(page.value, pages.value);
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
      }
    }
    function displayDate(value: string) {
      const date = new Date(value);
      return !value
        ? "—"
        : Number.isNaN(date.getTime())
          ? value
          : new Intl.DateTimeFormat(locale.value, {
              dateStyle: "medium",
              ...(value.includes("T") ? { timeStyle: "short" as const } : {}),
            }).format(date);
    }
    function create() {
      if (!languages.value) return;
      const draft = (props.kind === "topic" ? newTopic : newThread)(
        language.value,
        languages.value.defaultLanguage,
      );
      emit("create", draft.path, draft.initial);
    }
    onMounted(() => load());
    return () =>
      element(
        "section",
        {
          className: classes(
            "content-library localized-library",
            `${props.kind}-library`,
          ),
        },
        element(
          "div",
          { className: classes("page-heading") },
          element(
            "div",
            null,

            element(
              "h1",
              null,
              t(props.kind === "topic" ? "话题管理" : "动态"),
            ),
          ),
          element(
            "div",
            { className: classes("row") },
            element(
              "button",
              {
                disabled: loading.value,
                className: classes("secondary"),
                onClick: domEvent(($event: Event) => {
                  load(true);
                }),
              },
              t("刷新内容"),
            ),
            props.kind === "topic"
              ? element(
                  "button",
                  {
                    disabled: loading.value || !!error.value,
                    className: classes("primary"),
                    onClick: domEvent(($event: Event) => {
                      create();
                    }),
                  },
                  element(Icon, { name: "plus" }),
                  t(props.kind === "topic" ? "新建话题" : "发动态"),
                )
              : null,
          ),
        ),
        props.kind === "thread"
          ? element(ThreadComposer, {
              ref: domRef(composer),
              onDirty: changed satisfies EventHandler<
                typeof ThreadComposer,
                "onDirty"
              >,
              onSaved: (() => {
                load();
              }) satisfies EventHandler<typeof ThreadComposer, "onSaved">,
            })
          : null,
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
                    load(true);
                  }),
                },
                t("重试"),
              ),
            )
          : null,
        !loading.value && unclassified.value.length
          ? element(
              "section",
              {
                "aria-label": t("需要检查"),
                className: classes("card thread-repair-list"),
              },
              element(
                "div",
                { className: classes("card-heading") },
                element(
                  "div",
                  null,
                  element("h2", null, t("需要检查")),
                  element(
                    "p",
                    { className: classes("muted small") },
                    t("以下内容无法识别语言，请检查文件名和内容。"),
                  ),
                ),
              ),
              renderList(unclassified.value).map((item) =>
                element(
                  "button",
                  {
                    key: item.path,
                    className: classes("content-row"),
                    onClick: domEvent(($event: Event) => {
                      openItem(item.path);
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
                    element("strong", null, item.title || t("无标题动态")),
                    element("small", null, t("文件位置"), "：", item.path),
                    element(
                      "span",
                      { className: classes("content-description") },
                      t(item.error),
                    ),
                  ),
                  element(
                    "span",
                    { className: classes("badge invalid") },
                    t("需要检查"),
                  ),
                  element(Icon, { name: "arrow" }),
                ),
              ),
            )
          : null,
        element(
          "div",
          { className: classes("card") },
          element(
            "div",
            { className: classes("library-toolbar thread-toolbar") },
            element(
              "div",
              { className: classes("search-box") },
              element(Icon, { name: "search" }),
              element("input", {
                value: search.value ?? "",
                "aria-label": t("搜索内容"),
                placeholder: t(
                  props.kind === "topic"
                    ? "搜索话题标题、介绍…"
                    : "搜索动态、标签…",
                ),
                onInput: domEvent(($event: Event) => {
                  search.value = ($event.target as HTMLInputElement).value;
                }),
              }),
            ),
            languages.value
              ? element(SelectionField, {
                  modelValue: language.value,
                  name: "thread-language",
                  label: t("内容语言"),
                  options: languages.value.languages.map((value) => ({
                    value,
                    label: value,
                  })),
                  onUpdateModelValue: (($event) => {
                    language.value = String($event);
                  }) satisfies EventHandler<
                    typeof SelectionField,
                    "onUpdateModelValue"
                  >,
                })
              : null,
            element(SelectionField, {
              modelValue: status.value,
              name: "thread-status",
              label: t("筛选状态"),
              options: [
                { value: "all", label: t("全部状态") },
                { value: "draft", label: t("草稿") },
                { value: "published", label: t("已发布") },
              ],
              onUpdateModelValue: (($event) => {
                status.value = String($event);
              }) satisfies EventHandler<
                typeof SelectionField,
                "onUpdateModelValue"
              >,
            }),
          ),
          loading.value
            ? element(LoadingState, { label: "正在读取内容…" })
            : !rows.value.length && !error.value
              ? element(
                  "div",
                  { className: classes("empty-state") },
                  element(
                    "h2",
                    null,
                    t(
                      search.value.trim() || status.value !== "all"
                        ? "没有找到匹配内容"
                        : props.kind === "topic"
                          ? "暂无话题"
                          : "暂无动态",
                    ),
                  ),
                  search.value.trim() || status.value !== "all"
                    ? element(
                        "p",
                        { className: classes("muted") },
                        t("试试其他关键词或筛选条件。"),
                      )
                    : null,
                )
              : null,
          renderList(rows.value).map((item) =>
            element(
              "div",
              { key: item.path, className: classes("library-row") },
              element(
                "button",
                {
                  "data-path": item.path,
                  className: classes("content-row"),
                  onClick: domEvent(($event: Event) => {
                    openItem(item.path);
                  }),
                },
                element(
                  "span",
                  { className: classes("content-icon") },
                  element(Icon, { name: "pen" }),
                ),
                element(
                  "span",
                  { className: classes("content-info") },
                  element(
                    "strong",
                    null,
                    item.title || item.description || t("无标题动态"),
                  ),
                  props.kind === "topic"
                    ? element(
                        "small",
                        null,
                        t("创建于"),
                        " ",
                        displayDate(item.date),
                        " · ",
                        t("资料更新于"),
                        " ",
                        displayDate(item.updated || item.date),
                        " · ",
                        item.lang,
                      )
                    : element(
                        "small",
                        null,
                        displayDate(item.date),
                        " · ",
                        item.lang,
                      ),
                  item.description && item.description !== item.title
                    ? element(
                        "span",
                        { className: classes("content-description") },
                        item.description,
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
                    : item.draft
                      ? t("草稿")
                      : t("已发布"),
                ),
                element(Icon, { name: "arrow" }),
              ),
              props.kind === "thread"
                ? element(
                    "div",
                    { className: classes("library-item-actions") },
                    element(
                      "button",
                      {
                        disabled: deleting.value,
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          openItem(item.path);
                        }),
                      },
                      t("详情"),
                    ),
                    element(
                      "button",
                      {
                        disabled:
                          deleting.value ||
                          composerDirty.value ||
                          composer.value?.isBusy(),
                        title: composerDirty.value
                          ? t("请先保存当前编辑，再删除列表中的内容。")
                          : undefined,
                        "aria-label": t("删除{title}的当前语言版本", {
                          title: item.title || t("无标题动态"),
                        }),
                        className: classes("text-button danger"),
                        onClick: domEvent(($event: Event) => {
                          pendingDelete.value = item;
                        }),
                      },
                      t("删除"),
                    ),
                  )
                : null,
            ),
          ),
          !loading.value && !error.value
            ? element(
                "div",
                { className: classes("list-footer library-footer") },
                element(
                  "span",
                  null,
                  t("共 {count} 项", { count: filtered.value.length }),
                  " · ",
                  t("网站内容将在下次部署后更新"),
                ),
                pages.value > 1
                  ? element(
                      "div",
                      { className: classes("row") },
                      element(
                        "button",
                        {
                          disabled: page.value <= 1,
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            page.value--;
                          }),
                        },
                        t("上一页"),
                      ),
                      element("span", null, page.value, " / ", pages.value),
                      element(
                        "button",
                        {
                          disabled: page.value >= pages.value,
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            page.value++;
                          }),
                        },
                        t("下一页"),
                      ),
                    )
                  : null,
              )
            : null,
        ),

        pendingDelete.value
          ? element(DeleteContentDialog, {
              path: pendingDelete.value.path,
              title: pendingDelete.value.title,
              onClose: (() => {
                pendingDelete.value = undefined;
              }) satisfies EventHandler<typeof DeleteContentDialog, "onClose">,
              onWorking: (($event) => {
                deleting.value = $event;
              }) satisfies EventHandler<
                typeof DeleteContentDialog,
                "onWorking"
              >,
              onDeleted: deleted satisfies EventHandler<
                typeof DeleteContentDialog,
                "onDeleted"
              >,
            })
          : null,
      );
  },
  {},
);
export default LocalizedContentLibrary;
