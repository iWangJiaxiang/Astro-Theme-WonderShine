import type { ArticleSummary, Json } from "../../shared/types";
import { t } from "../i18n";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  portal,
  renderList,
  type StudioComponent,
} from "../react-component";
import { computed, nextTick, onBeforeUnmount, ref, useId } from "../reactivity";
import Icon from "./Icon";

type Props = {
  modelValue: Json | undefined;
  items: ArticleSummary[];
  language: string;
  disabled?: boolean;
  compact?: boolean;
};
type Events = { "update:modelValue": [value: Json] };
const ArticleReferences: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "ArticleReferences",
  (props, emit, expose) => {
    type Reference =
      | { kind: "internal"; path: string }
      | { kind: "external"; url: string; title: string };
    const id = useId(),
      dialog = ref<HTMLDialogElement>(),
      trigger = ref<HTMLButtonElement>();
    const opened = ref(false),
      mode = ref<"internal" | "external">("internal"),
      search = ref(""),
      selected = ref(""),
      url = ref(""),
      title = ref(""),
      error = ref("");
    const references = computed(() =>
      Array.isArray(props.modelValue) ? (props.modelValue as Reference[]) : [],
    );
    const key = (item: ArticleSummary) =>
      (item.translationKey || item.path).replace(/^content\//, "");
    const articles = computed(() => {
      const grouped = new Map<string, ArticleSummary>();
      for (const item of props.items.filter(
        (item) =>
          (item.kind === "article" ||
            (item.kind === "collection" &&
              !item.path.startsWith("content/collections/album/"))) &&
          !/\/_index(?:\.[^.]+)?\.md$/.test(item.path) &&
          !item.error,
      )) {
        const current = grouped.get(key(item));
        if (!current || item.lang === props.language)
          grouped.set(key(item), item);
      }
      return [...grouped.values()].sort(
        (a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0),
      );
    });
    const filtered = computed(() =>
      articles.value.filter((item) =>
        [item.title, item.path, ...item.tags]
          .join(" ")
          .toLowerCase()
          .includes(search.value.trim().toLowerCase()),
      ),
    );
    function label(reference: Reference) {
      return reference.kind === "external"
        ? reference.title || reference.url
        : articles.value.find((item) => key(item) === reference.path)?.title ||
            reference.path;
    }
    async function open() {
      if (props.disabled || references.value.length >= 12) return;
      search.value = "";
      selected.value = "";
      url.value = "";
      title.value = "";
      error.value = "";
      opened.value = true;
      await nextTick();
      dialog.value?.showModal();
    }
    function close() {
      dialog.value?.close();
      opened.value = false;
      trigger.value?.focus();
    }
    function add() {
      if (props.disabled) return;
      let reference: Reference;
      if (mode.value === "internal") {
        if (!selected.value) return;
        reference = { kind: "internal", path: selected.value };
      } else {
        try {
          const parsed = new URL(url.value.trim());
          if (
            !["https:", "http:"].includes(parsed.protocol) ||
            parsed.username ||
            parsed.password
          )
            throw new Error();
          reference = {
            kind: "external",
            url: parsed.href,
            title: title.value.trim() || parsed.hostname,
          };
        } catch {
          error.value = "请输入有效的 http 或 https 文章地址";
          return;
        }
      }
      if (
        !references.value.some(
          (item) =>
            item.kind === reference.kind &&
            (item.kind === "internal" && reference.kind === "internal"
              ? item.path === reference.path
              : item.kind === "external" &&
                reference.kind === "external" &&
                item.url === reference.url),
        )
      )
        emit("update:modelValue", [...references.value, reference]);
      close();
    }
    onBeforeUnmount(() => dialog.value?.close());
    return () =>
      element(
        "div",
        {
          className: classes("article-references", {
            "reference-compact": props.compact,
          }),
        },
        element(
          "div",
          { className: classes("reference-heading") },
          element(
            "button",
            {
              ref: domRef(trigger),
              disabled: props.disabled || references.value.length >= 12,
              "aria-haspopup": "dialog",
              "aria-expanded": opened.value,
              className: classes("text-button"),
              onClick: domEvent(($event: Event) => {
                open();
              }),
            },
            props.compact ? element(Icon, { name: "link", size: 16 }) : null,
            t("引用文章"),
            " ",
            !props.compact
              ? element("span", { "aria-hidden": "true" }, "＋")
              : null,
          ),
          references.value.length
            ? element(
                "span",
                { className: classes("muted small") },
                references.value.length,
                " / 12",
              )
            : null,
        ),
        references.value.length
          ? element(
              "ul",
              { className: classes("reference-chips") },
              renderList(references.value).map((reference, index) =>
                element(
                  "li",
                  { key: index },
                  element(
                    "span",
                    { className: classes("badge") },
                    t(reference.kind === "internal" ? "本站" : "外部"),
                  ),
                  element("span", null, label(reference)),
                  element(
                    "button",
                    {
                      disabled: props.disabled,
                      "aria-label": t("移除引用：{title}", {
                        title: label(reference),
                      }),
                      className: classes("text-button"),
                      onClick: domEvent(($event: Event) => {
                        emit(
                          "update:modelValue",
                          references.value.filter((_, i) => i !== index),
                        );
                      }),
                    },
                    "×",
                  ),
                ),
              ),
            )
          : null,
        portal(
          element(
            Fragment,
            null,
            opened.value
              ? element(
                  "dialog",
                  {
                    ref: domRef(dialog),
                    "aria-labelledby": `${id}-title`,
                    className: classes("selection-dialog reference-dialog"),
                    onCancel: domEvent(($event: Event) => {
                      $event.preventDefault();
                      close();
                    }),
                    onClick: domEvent(($event: Event) => {
                      $event.target === dialog.value && close();
                    }),
                  },
                  element(
                    "form",
                    {
                      className: classes("selection-panel"),
                      onSubmit: domEvent(($event: Event) => {
                        $event.preventDefault();
                        add();
                      }),
                    },
                    element(
                      "div",
                      { className: classes("card-heading") },
                      element("h2", { id: `${id}-title` }, t("引用文章")),
                      element(
                        "button",
                        {
                          type: "button",
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            close();
                          }),
                        },
                        t("取消"),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("editor-tabs") },
                      element(
                        "button",
                        {
                          type: "button",
                          className: classes({
                            active: mode.value === "internal",
                          }),
                          onClick: domEvent(($event: Event) => {
                            mode.value = "internal";
                          }),
                        },
                        t("本站文章"),
                      ),
                      element(
                        "button",
                        {
                          type: "button",
                          className: classes({
                            active: mode.value === "external",
                          }),
                          onClick: domEvent(($event: Event) => {
                            mode.value = "external";
                          }),
                        },
                        t("外部文章"),
                      ),
                    ),
                    mode.value === "internal"
                      ? element(
                          Fragment,
                          null,
                          element(
                            "label",
                            { className: classes("field selection-search") },
                            element("span", null, t("搜索文章")),
                            element("input", {
                              value: search.value ?? "",
                              type: "search",
                              autoFocus: true,
                              placeholder: t("搜索标题、标签或文件位置…"),
                              onInput: domEvent(($event: Event) => {
                                search.value = (
                                  $event.target as HTMLInputElement
                                ).value;
                              }),
                            }),
                          ),
                          element(
                            "fieldset",
                            {
                              "aria-label": t("本站文章"),
                              className: classes(
                                "selection-results reference-results",
                              ),
                            },
                            renderList(filtered.value).map((item) =>
                              element(
                                "label",
                                {
                                  key: key(item),
                                  className: classes("choice-tile", {
                                    selected: selected.value === key(item),
                                  }),
                                },
                                element("input", {
                                  checked: selected.value === key(item),
                                  type: "radio",
                                  name: "reference-article",
                                  value: key(item),
                                  onChange: domEvent(($event: Event) => {
                                    selected.value = (
                                      $event.target as HTMLInputElement
                                    ).value;
                                  }),
                                }),
                                element(
                                  "span",
                                  null,
                                  element("strong", null, item.title),
                                  element(
                                    "small",
                                    null,
                                    item.lang,
                                    " · ",
                                    t(item.draft ? "草稿" : "已发布"),
                                    item.lang !== props.language
                                      ? element(
                                          Fragment,
                                          null,
                                          " · ",
                                          t("缺少 {language} 译文", {
                                            language: props.language,
                                          }),
                                        )
                                      : null,
                                  ),
                                ),
                              ),
                            ),
                            !filtered.value.length
                              ? element(
                                  "p",
                                  { className: classes("muted") },
                                  t("没有找到匹配内容"),
                                )
                              : null,
                          ),
                        )
                      : element(
                          "div",
                          { className: classes("external-reference-fields") },
                          element(
                            "label",
                            { className: classes("field field-inline") },
                            element("span", null, t("文章地址")),
                            element("input", {
                              value: url.value ?? "",
                              type: "url",
                              required: true,
                              placeholder: "https://example.com/article",
                              onInput: domEvent(($event: Event) => {
                                url.value = (
                                  $event.target as HTMLInputElement
                                ).value;
                              }),
                            }),
                          ),
                          element(
                            "label",
                            { className: classes("field field-inline") },
                            element("span", null, t("标题（可选）")),
                            element("input", {
                              value: title.value ?? "",
                              maxLength: "300",
                              onInput: domEvent(($event: Event) => {
                                title.value = (
                                  $event.target as HTMLInputElement
                                ).value;
                              }),
                            }),
                          ),
                          error.value
                            ? element(
                                "p",
                                {
                                  role: "alert",
                                  className: classes("notice error"),
                                },
                                t(error.value),
                              )
                            : null,
                        ),
                    element(
                      "div",
                      { className: classes("selection-footer") },
                      element(
                        "small",
                        { className: classes("muted") },
                        t("本站引用自动匹配内容语言；缺少公开译文时显示原文。"),
                      ),
                      element(
                        "button",
                        {
                          disabled:
                            props.disabled ||
                            (mode.value === "internal" && !selected.value),
                          className: classes("primary"),
                        },
                        t("添加引用"),
                      ),
                    ),
                  ),
                )
              : null,
          ),
        ),
      );
  },
  {},
);
export default ArticleReferences;
