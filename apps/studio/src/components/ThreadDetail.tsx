import DOMPurify from "dompurify";
import { marked } from "marked";
import { stringValues, taxonomyChoices } from "../../shared/choices";
import { mediaURL, storedMediaPath } from "../../shared/media";
import { translationLocation } from "../../shared/translation";
import type {
  Article,
  ArticleSummary,
  ContentLanguages,
  Settings,
} from "../../shared/types";
import { api, errorMessage } from "../api";
import { topicOptions } from "../content-model";
import { locale, t, type Message } from "../i18n";
import {
  isPublishedContent,
  metadataValue,
  threadReferences,
  previewLink,
  publicContentUrl,
} from "../thread-detail";
import "../thread-detail.css";
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
import { computed, onBeforeUnmount, onMounted, ref } from "../reactivity";
import DeleteContentDialog from "./DeleteContentDialog";
import Icon from "./Icon";
import LoadingState from "./LoadingState";

type Props = { path: string; siteUrl?: string };
type Events = {
  back: [];
  edit: [path: string];
  open: [path: string];
  deleted: [path: string];
};
const ThreadDetail: StudioComponent<Props, Events> = component<Props, Events>(
  "ThreadDetail",
  (props, emit, expose) => {
    const document = ref<Article>(),
      items = ref<ArticleSummary[]>([]),
      languages = ref<ContentLanguages>();
    const loading = ref(true),
      error = ref<Message>(""),
      deleting = ref(false),
      busy = ref(false);
    const tagLabels = ref(new Map<string, string>());
    let alive = true;
    onBeforeUnmount(() => {
      alive = false;
    });
    const summary = computed(() =>
      items.value.find((item) => item.path === props.path),
    );
    const language = computed(
      () =>
        summary.value?.lang ||
        (languages.value
          ? translationLocation(
              props.path,
              languages.value.defaultLanguage,
              languages.value,
            ).sourceLanguage
          : ""),
    );
    const versions = computed(() =>
      items.value.filter(
        (item) =>
          item.kind === "thread" &&
          item.translationKey === summary.value?.translationKey &&
          !item.error,
      ),
    );
    const meta = (path: string) =>
      document.value ? metadataValue(document.value.metadata, path) : undefined;
    const topics = computed(() =>
      topicOptions(items.value, language.value).filter((item) =>
        stringValues(meta("extra.topics")).includes(item.id || ""),
      ),
    );
    const tags = computed(() =>
      stringValues(meta("taxonomies.tags")).map(
        (tag) => tagLabels.value.get(tag) || tag,
      ),
    );
    const references = computed(() =>
      threadReferences(
        meta("extra.references"),
        items.value,
        language.value,
        languages.value?.defaultLanguage || language.value,
      ),
    );
    const publicUrl = computed(() =>
      isPublishedContent(summary.value)
        ? publicContentUrl(summary.value?.publicPath, props.siteUrl)
        : undefined,
    );
    const hasShortcode = computed(() =>
      /\{%|\{\{/.test(document.value?.body || ""),
    );
    const preview = computed(() => {
      const html = DOMPurify.sanitize(
        marked.parse(document.value?.body || "", { async: false }) as string,
      );
      const parsed = new DOMParser().parseFromString(html, "text/html");
      for (const image of parsed.querySelectorAll("img")) {
        try {
          const path = storedMediaPath(
            decodeURIComponent(image.getAttribute("src") || ""),
            "document",
            props.path,
          );
          if (path) image.setAttribute("src", mediaURL(path));
        } catch {
          /* Keep unrecognized images unchanged. */
        }
      }
      for (const link of parsed.querySelectorAll("a[href]")) {
        const href = link.getAttribute("href") || "";
        if (href.startsWith("#")) continue;
        const target = previewLink(
          href,
          items.value,
          summary.value?.publicPath,
          props.siteUrl,
        );
        if (!target) {
          link.removeAttribute("href");
          continue;
        }
        link.setAttribute("href", target);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
      }
      return parsed.body.innerHTML;
    });
    function date(value: string | undefined) {
      if (!value) return "—";
      const time = new Date(value);
      return Number.isNaN(time.getTime())
        ? value
        : new Intl.DateTimeFormat(locale.value, {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(time);
    }
    async function load(refresh = false) {
      loading.value = true;
      error.value = "";
      try {
        const [doc, content, config] = await Promise.all([
          api<Article>(`/document?path=${encodeURIComponent(props.path)}`),
          api<ArticleSummary[]>("/content" + (refresh ? "?refresh=1" : "")),
          api<ContentLanguages>("/content-languages"),
        ]);
        if (!alive) return;
        document.value = doc;
        items.value = content;
        languages.value = config;
        try {
          const settings = await api<Settings>(
            `/settings/taxonomies?language=${encodeURIComponent(language.value)}`,
          );
          if (alive)
            tagLabels.value = new Map(
              taxonomyChoices(settings.values["post.tags"], []).map((tag) => [
                tag.value,
                tag.label,
              ]),
            );
        } catch {
          /* Stored IDs remain useful when the label dictionary is unavailable. */
        }
      } catch (e) {
        if (alive) error.value = errorMessage(e);
      } finally {
        if (alive) loading.value = false;
      }
    }
    onMounted(load);
    expose({ flush: () => {}, isBusy: () => busy.value });
    return () =>
      element(
        "section",
        { className: classes("thread-detail-page") },
        element(
          "div",
          { className: classes("page-heading") },
          element(
            "div",
            null,
            element(
              "button",
              {
                disabled: busy.value,
                className: classes("text-button detail-back"),
                onClick: domEvent(($event: Event) => {
                  emit("back");
                }),
              },
              t("← 返回动态列表"),
            ),

            element("h1", null, t("动态详情")),
          ),
          document.value && !loading.value && !error.value
            ? element(
                "div",
                { className: classes("row") },
                element(
                  "button",
                  {
                    disabled: busy.value,
                    className: classes("text-button danger"),
                    onClick: domEvent(($event: Event) => {
                      deleting.value = true;
                    }),
                  },
                  t("删除"),
                ),
                publicUrl.value
                  ? element(
                      "a",
                      {
                        href: publicUrl.value,
                        target: "_blank",
                        rel: "noopener noreferrer",
                        className: classes("secondary"),
                      },
                      t("查看网站 ↗"),
                    )
                  : null,
                element(
                  "button",
                  {
                    disabled: busy.value,
                    className: classes("primary"),
                    onClick: domEvent(($event: Event) => {
                      emit("edit", props.path);
                    }),
                  },
                  element(Icon, { name: "pen", size: 16 }),
                  t("编辑动态"),
                ),
              )
            : null,
        ),
        loading.value
          ? element(LoadingState, { label: "正在载入文稿…" })
          : error.value
            ? element(
                "div",
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
            : document.value
              ? element(
                  Fragment,
                  null,
                  element(
                    "nav",
                    {
                      "aria-label": t("语言版本"),
                      className: classes("detail-language-tabs"),
                    },
                    element(
                      "span",
                      { className: classes("muted small") },
                      t("语言版本"),
                    ),
                    renderList(versions.value).map((version) =>
                      element(
                        "button",
                        {
                          key: version.path,
                          "aria-current":
                            version.path === props.path ? "page" : undefined,
                          disabled: busy.value,
                          className: classes({
                            active: version.path === props.path,
                          }),
                          onClick: domEvent(($event: Event) => {
                            version.path !== props.path &&
                              emit("open", version.path);
                          }),
                        },
                        version.lang,
                        version.draft
                          ? element("span", {
                              title: t("草稿"),
                              className: classes("detail-draft-dot"),
                            })
                          : null,
                      ),
                    ),
                    languages.value &&
                      versions.value.length < languages.value.languages.length
                      ? element(
                          "button",
                          {
                            disabled: busy.value,
                            className: classes("text-button"),
                            onClick: domEvent(($event: Event) => {
                              emit("edit", props.path);
                            }),
                          },
                          t("管理语言版本"),
                          element(Icon, { name: "plus", size: 14 }),
                        )
                      : null,
                  ),
                  element(
                    "div",
                    { className: classes("thread-detail-layout") },
                    element(
                      "article",
                      { className: classes("card thread-reading-card") },
                      element(
                        "header",
                        { className: classes("thread-reading-header") },
                        element(
                          "span",
                          { className: classes("detail-thread-icon") },
                          element(Icon, { name: "pen" }),
                        ),
                        element(
                          "div",
                          null,
                          element("strong", null, t("动态")),
                          element("time", null, date(summary.value?.date)),
                        ),
                        element(
                          "span",
                          {
                            className: classes("badge", {
                              draft: summary.value?.draft,
                            }),
                          },
                          t(summary.value?.draft ? "草稿" : "已发布"),
                        ),
                      ),
                      meta("title")
                        ? element(
                            "h2",
                            { className: classes("thread-reading-title") },
                            meta("title"),
                          )
                        : null,
                      hasShortcode.value
                        ? element(
                            "p",
                            { className: classes("notice small") },
                            t(
                              "这里只预览 Markdown；shortcode 和主题页面请在 Astro 网站预览中查看。",
                            ),
                          )
                        : null,
                      document.value.body.trim()
                        ? element("div", {
                            dangerouslySetInnerHTML: { __html: preview.value },
                            className: classes(
                              "markdown-preview thread-reading-body",
                            ),
                          })
                        : element(
                            "p",
                            { className: classes("muted thread-reading-body") },
                            t("这条动态没有正文。"),
                          ),
                      references.value.length
                        ? element(
                            "section",
                            {
                              "aria-label": t("引用文章"),
                              className: classes("thread-detail-references"),
                            },
                            element(
                              "h3",
                              null,
                              t("引用文章"),
                              " ",
                              element("span", null, references.value.length),
                            ),
                            renderList(references.value).map(
                              (reference, index) =>
                                element(
                                  "div",
                                  {
                                    key: index,
                                    className: classes("detail-reference"),
                                  },
                                  element(
                                    "span",
                                    {
                                      className: classes(
                                        "detail-reference-icon",
                                      ),
                                    },
                                    element(Icon, {
                                      name:
                                        reference.kind === "internal"
                                          ? "file"
                                          : "link",
                                      size: 18,
                                    }),
                                  ),
                                  element(
                                    "div",
                                    null,
                                    element(
                                      "small",
                                      null,
                                      t(
                                        reference.kind === "internal"
                                          ? "本站文章"
                                          : "外部文章",
                                      ),
                                      reference.language
                                        ? element(
                                            Fragment,
                                            null,
                                            " · ",
                                            reference.language,
                                          )
                                        : null,
                                      reference.draft
                                        ? element(
                                            Fragment,
                                            null,
                                            " · ",
                                            t("草稿"),
                                          )
                                        : null,
                                    ),
                                    reference.path
                                      ? element(
                                          "button",
                                          {
                                            disabled: busy.value,
                                            className: classes("text-button"),
                                            onClick: domEvent(
                                              ($event: Event) => {
                                                reference.path &&
                                                  emit("edit", reference.path);
                                              },
                                            ),
                                          },
                                          reference.title,
                                          " ↗",
                                        )
                                      : reference.href
                                        ? element(
                                            "a",
                                            {
                                              href: reference.href,
                                              target: "_blank",
                                              rel: "noopener noreferrer",
                                            },
                                            reference.title,
                                            " ↗",
                                          )
                                        : element(
                                            "strong",
                                            null,
                                            reference.title,
                                          ),
                                    reference.missing
                                      ? element(
                                          "small",
                                          null,
                                          t(
                                            "引用内容暂不可用，请在编辑器中检查。",
                                          ),
                                        )
                                      : null,
                                  ),
                                ),
                            ),
                          )
                        : null,
                      tags.value.length || topics.value.length
                        ? element(
                            "footer",
                            { className: classes("thread-reading-footer") },
                            tags.value.length
                              ? element(
                                  "div",
                                  {
                                    "aria-label": t("标签"),
                                    className: classes("detail-tags"),
                                  },
                                  renderList(tags.value).map((tag) =>
                                    element("span", { key: tag }, "# ", tag),
                                  ),
                                )
                              : null,
                            topics.value.length
                              ? element(
                                  "div",
                                  { className: classes("detail-topics") },
                                  element(
                                    "span",
                                    { className: classes("muted small") },
                                    t("关联话题"),
                                  ),
                                  renderList(topics.value).map((topic) =>
                                    element(
                                      "button",
                                      {
                                        key: topic.path,
                                        disabled: busy.value,
                                        className: classes("text-button"),
                                        onClick: domEvent(($event: Event) => {
                                          emit("edit", topic.path);
                                        }),
                                      },
                                      topic.title,
                                      topic.lang !== language.value
                                        ? element(
                                            "span",
                                            null,
                                            " · ",
                                            topic.lang,
                                          )
                                        : null,
                                    ),
                                  ),
                                )
                              : null,
                          )
                        : null,
                    ),
                    element(
                      "aside",
                      { className: classes("thread-detail-aside") },
                      element(
                        "section",
                        { className: classes("card detail-properties") },
                        element("h2", null, t("发布信息")),
                        element(
                          "dl",
                          null,
                          element(
                            "div",
                            null,
                            element("dt", null, t("内容语言")),
                            element("dd", null, language.value),
                          ),
                          element(
                            "div",
                            null,
                            element("dt", null, t("发布时间")),
                            element("dd", null, date(summary.value?.date)),
                          ),
                          summary.value?.updated
                            ? element(
                                "div",
                                null,
                                element("dt", null, t("更新时间")),
                                element(
                                  "dd",
                                  null,
                                  date(summary.value.updated),
                                ),
                              )
                            : null,
                          element(
                            "div",
                            null,
                            element("dt", null, t("评论")),
                            element(
                              "dd",
                              null,
                              t(
                                meta("extra.disable_comment")
                                  ? "已关闭"
                                  : "已开启",
                              ),
                            ),
                          ),
                          meta("extra.ai_translation")
                            ? element(
                                "div",
                                null,
                                element("dt", null, t("AI 翻译")),
                                element(
                                  "dd",
                                  null,
                                  t(
                                    meta("extra.translation_reviewed")
                                      ? "译文已审核"
                                      : "译文待审核",
                                  ),
                                ),
                              )
                            : null,
                        ),
                        element(
                          "p",
                          { className: classes("muted small") },
                          t("网站内容将在下次部署后更新"),
                        ),
                      ),
                      element(
                        "details",
                        { className: classes("detail-file") },
                        element("summary", null, t("文件位置")),
                        element("p", null, props.path),
                      ),
                    ),
                  ),
                )
              : null,
        deleting.value && document.value
          ? element(DeleteContentDialog, {
              path: props.path,
              title: summary.value?.title || t("无标题动态"),
              revision: document.value.revision,
              onClose: (() => {
                deleting.value = false;
              }) satisfies EventHandler<typeof DeleteContentDialog, "onClose">,
              onWorking: (($event) => {
                busy.value = $event;
              }) satisfies EventHandler<
                typeof DeleteContentDialog,
                "onWorking"
              >,
              onDeleted: (($event) => {
                emit("deleted", $event);
              }) satisfies EventHandler<
                typeof DeleteContentDialog,
                "onDeleted"
              >,
            })
          : null,
      );
  },
  {},
);
export default ThreadDetail;
