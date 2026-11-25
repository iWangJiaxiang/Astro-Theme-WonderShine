import { ErrorDetails, ErrorNotice } from "./ErrorNotice";
import {
  formatBytes,
  imageExtension,
  mediaValue,
  supportsColocatedMedia,
  type MediaItem,
  type MediaMode,
} from "../../shared/media";
import { session } from "../api";
import { t } from "../i18n";
import { subscribeWorkspaceChanged } from "../workspace-events";
import {
  loadMedia,
  mediaError,
  mediaListing,
  mediaLoading,
  mediaUploading,
  mediaVersion,
} from "../media-store";
import { inMediaDirectory, mediaDirectoryTree } from "../media-tree";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "../reactivity";
import Icon from "./Icon";
import LoadingState from "./LoadingState";
import MediaDirectoryNode from "./MediaDirectoryNode";
import MediaPreviewImage from "./MediaPreviewImage";
import MediaUpload, { type MediaUploadFeedback } from "./MediaUpload";
import SelectionField from "./SelectionField";

const pageSize = 24;

type Props = {
  mode: MediaMode;
  documentPath: string;
  selected: string;
  current?: string;
  svgOnly: boolean;
};
type Events = {
  select: [item: MediaItem, value: string, trigger?: HTMLButtonElement];
  visibleSelection: [path: string];
};
const MediaBrowser: StudioComponent<Props, Events> = component<Props, Events>(
  "MediaBrowser",
  (props, emit, expose) => {
    const search = ref(""),
      source = ref("all"),
      folder = ref(""),
      page = ref(1),
      failed = ref(new Set<string>());
    const eligible = computed(() =>
      mediaListing.value.items.filter(
        (item) =>
          (!props.svgOnly || imageExtension(item.path) === "svg") &&
          (props.mode === "library" ||
            mediaValue(item, props.mode, props.documentPath) !== null),
      ),
    );
    const tree = computed(() => mediaDirectoryTree(eligible.value));
    const uploadExpanded = ref(false);
    const uploadFeedback = ref<MediaUploadFeedback>();
    watch(
      () =>
        [session.value, session.value?.identity.id, session.value?.identity.method] as const,
      () => {
        uploadFeedback.value = undefined;
      },
    );
    // This browser is client-only. Reset the default only when crossing the
    // layout breakpoint, so manual disclosure choices survive ordinary renders.
    const narrowLayout = window.matchMedia("(max-width: 760px)");
    const browseExpanded = ref(!narrowLayout.matches);
    const browseDisclosure = ref<HTMLDetailsElement>();
    function layoutChanged(event: MediaQueryListEvent) {
      const disclosure = browseDisclosure.value;
      if (event.matches && disclosure?.contains(document.activeElement))
        disclosure.querySelector("summary")?.focus({ preventScroll: true });
      if (disclosure) disclosure.open = !event.matches;
      browseExpanded.value = !event.matches;
    }
    narrowLayout.addEventListener("change", layoutChanged);
    onBeforeUnmount(() => {
      narrowLayout.removeEventListener("change", layoutChanged);
    });
    const browseDisclosureProps = () => ({
      ref: domRef(browseDisclosure),
      open: browseExpanded.value,
      onToggle: domEvent(($event: Event) => {
        if ($event.target !== $event.currentTarget) return;
        browseExpanded.value = ($event.currentTarget as HTMLDetailsElement).open;
      }),
    });
    const sourceItems = computed(() => source.value === "all"
      ? eligible.value
      : eligible.value.filter(item => item.path.startsWith(source.value + "/")));
    const folders = computed(() => [
      { value: "", label: t("全部文件夹") },
      ...[...new Set(sourceItems.value.map((item) => item.directory))]
        .sort()
        .map((value) => ({ value, label: `${t("文件位置")}：${value}` })),
    ]);
    const filtered = computed(() =>
      sourceItems.value.filter(
        (item) =>
          (props.mode === "library"
            ? inMediaDirectory(item, folder.value)
            : !folder.value || item.directory === folder.value) &&
          item.path
            .toLocaleLowerCase()
            .includes(search.value.trim().toLocaleLowerCase()),
      ),
    );
    const pages = computed(() =>
      Math.max(1, Math.ceil(filtered.value.length / pageSize)),
    );
    const items = computed(() =>
      filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize),
    );
    watch(() => props.mode !== "library" && items.value.some(item =>
      item.path === props.selected && !item.unavailable) ? props.selected : "",
      path => emit("visibleSelection", path));
    watch(folders, choices => {
      if (props.mode !== "library" && !choices.some(choice => choice.value === folder.value))
        folder.value = "";
    });
    watch([search, source, folder], () => {
      page.value = 1;
    });
    function pageContaining(path: string) {
      const index = filtered.value.findIndex(item => item.path === path && !item.unavailable);
      return index < 0 ? undefined : Math.floor(index / pageSize) + 1;
    }
    watch(mediaVersion, () => {
      failed.value = new Set();
      if (
        folder.value &&
        !eligible.value.some((item) => inMediaDirectory(item, folder.value))
      )
        folder.value = "";
      page.value = props.mode === "library" ? 1
        : pageContaining(props.selected) ?? Math.min(page.value, pages.value);
    });
    onMounted(() => {
      void loadMedia();
    });
    onBeforeUnmount(subscribeWorkspaceChanged(() => loadMedia()));
    function uploaded(item: MediaItem) {
      search.value = "";
      source.value = "all";
      folder.value = props.mode === "library" ? item.directory : "";
      page.value = pageContaining(item.path) ?? 1;
      const value = mediaValue(item, props.mode, props.documentPath);
      if (value !== null) emit("select", item, value);
    }
    function uploadStatus() {
      const feedback = uploadFeedback.value;
      return element(
        "div",
        {
          role: "status",
          "aria-atomic": true,
          className: classes("media-upload-feedback"),
        },
        feedback?.validation
          ? element("p", null, t(feedback.validation))
          : null,
        feedback && feedback.total > 0
          ? element(
              "p",
              null,
              feedback.validation ? t("上次上传") + " · " : "",
              element(
                "strong",
                null,
                feedback.active
                  ? t("正在处理上传")
                  : feedback.paused
                    ? t("上传已暂停")
                    : t("上传处理结束"),
              ),
              " · ",
              t("已处理 {completed}/{total}，已上传 {uploaded}，失败 {failed}，未尝试 {skipped}", {
                completed: feedback.completed,
                total: feedback.total,
                uploaded: feedback.uploaded,
                failed: feedback.failed,
                skipped: feedback.skipped,
              }),
            )
          : null,
        feedback && feedback.uploaded > 0
          ? element(
              "p",
              { className: classes("muted") },
              t("已上传的图片已保存到仓库，选用后仍需保存表单。"),
            )
          : null,
      );
    }
    function choose(item: MediaItem, trigger: HTMLButtonElement) {
      const value = mediaValue(item, props.mode, props.documentPath);
      if (value !== null && !mediaLoading.value && !mediaError.value)
        emit("select", item, value, trigger);
    }
    return () =>
      element(
        "div",
        {
          "aria-busy": mediaLoading.value || mediaUploading.value,
          className: classes("media-browser"),
        },
        element(
          "div",
          {
            className: classes("media-workspace", {
              "has-directory-tree": props.mode === "library",
            }),
          },
          props.mode === "library"
            ? element(
                "details",
                {
                  ...browseDisclosureProps(),
                  className: classes("media-directory-disclosure"),
                },
                element(
                  "summary",
                  null,
                  element("strong", null, t("图片目录")),
                  element("span", null, folder.value || t("全部图片")),
                ),
                element(
                  "nav",
                  {
                    "aria-label": t("图片目录"),
                    className: classes("media-directory-tree"),
                  },
                  element(
                    "button",
                    {
                      "aria-current": folder.value ? undefined : "location",
                      className: classes("directory-all", {
                        active: !folder.value,
                      }),
                      onClick: domEvent(($event: Event) => {
                        folder.value = "";
                      }),
                    },
                    t("全部图片"),
                    element("small", null, eligible.value.length),
                  ),
                  element(
                    "ul",
                    null,
                    renderList(tree.value).map((node) =>
                      element(MediaDirectoryNode, {
                        key: node.path,
                        node: node,
                        selected: folder.value,
                        depth: 0,
                        onSelect: (($event) => {
                          folder.value = $event;
                        }) satisfies EventHandler<
                          typeof MediaDirectoryNode,
                          "onSelect"
                        >,
                      }),
                    ),
                  ),
                  !tree.value.length
                    ? element(
                        "p",
                        { className: classes("muted small") },
                        t("上传后显示图片目录"),
                      )
                    : null,
                ),
              )
            : null,
          element(
            "div",
            { className: classes("media-results") },
            element(
              "details",
              {
                open: uploadExpanded.value,
                className: classes("media-upload-disclosure"),
                onToggle: domEvent(($event: Event) => {
                  uploadExpanded.value = (
                    $event.target as HTMLDetailsElement
                  ).open;
                }),
              },
              element(
                "summary",
                null,
                element("strong", null, "＋ ", t("上传图片")),
              ),
              element(MediaUpload, {
                mode: props.mode,
                documentPath: props.documentPath,
                svgOnly: props.svgOnly,
                preferredDirectory: props.mode === "library" ? folder.value : undefined,
                feedbackMode: "external",
                onFeedback: (($event) => {
                  uploadFeedback.value = $event;
                }) satisfies EventHandler<typeof MediaUpload, "onFeedback">,
                onUploaded: uploaded satisfies EventHandler<
                  typeof MediaUpload,
                  "onUploaded"
                >,
              }),
            ),
            uploadStatus(),
            element(
              "div",
              { className: classes("media-toolbar") },
              element(
                "label",
                { className: classes("field field-inline media-search") },
                element("span", null, t("搜索图片")),
                element("input", {
                  value: search.value ?? "",
                  type: "search",
                  "aria-label": t("搜索仓库图片"),
                  placeholder: t("搜索文件名或路径…"),
                  onInput: domEvent(($event: Event) => {
                    search.value = ($event.target as HTMLInputElement).value;
                  }),
                  onKeyDown: domEvent(($event: Event) => {
                    if (($event as KeyboardEvent).key !== "Enter") return;
                    $event.preventDefault();
                  }),
                }),
              ),
              element(
                "button",
                {
                  type: "button",
                  disabled: mediaLoading.value || mediaUploading.value,
                  className: classes("secondary"),
                  onClick: domEvent(($event: Event) => {
                    loadMedia(true);
                  }),
                },
                mediaLoading.value ? t("读取中…") : t("刷新仓库"),
              ),
            ),
            props.mode !== "library"
              ? element(
                  "details",
                  {
                    ...browseDisclosureProps(),
                    className: classes("media-filter-disclosure"),
                  },
                  element(
                    "summary",
                    null,
                    props.mode === "document"
                      ? element(
                          "span",
                          null,
                          element("strong", null, t("图片来源"), "："),
                          source.value === "public"
                            ? t("公共图片")
                            : source.value === "content"
                              ? t("内容配图")
                              : t("全部"),
                          " · ",
                        )
                      : null,
                    element(
                      "span",
                      null,
                      element("strong", null, t("文件夹"), "："),
                      folder.value || t("全部文件夹"),
                    ),
                  ),
                  element(
                    "div",
                    { className: classes("media-filters") },
                    props.mode === "document"
                      ? element(
                          "div",
                          { className: classes("media-filter-control") },
                          element("span", { "aria-hidden": "true" }, t("图片来源")),
                          element(SelectionField, {
                            modelValue: source.value,
                            name: "media-source",
                            label: t("图片来源"),
                            compact: true,
                            options: [
                              { value: "all", label: t("全部") },
                              { value: "public", label: t("公共图片") },
                              { value: "content", label: t("内容配图") },
                            ],
                            onUpdateModelValue: (($event) => {
                              source.value = String($event);
                            }) satisfies EventHandler<
                              typeof SelectionField,
                              "onUpdateModelValue"
                            >,
                          }),
                        )
                      : null,
                    element(
                      "div",
                      { className: classes("media-filter-control") },
                      element("span", { "aria-hidden": "true" }, t("文件夹")),
                      element(SelectionField, {
                        modelValue: folder.value,
                        allowCustomValues: false,
                        name: "media-folder",
                        label: t("文件夹"),
                        compact: true,
                        options: folders.value,
                        onUpdateModelValue: (($event) => {
                          folder.value = String($event);
                        }) satisfies EventHandler<
                          typeof SelectionField,
                          "onUpdateModelValue"
                        >,
                      }),
                    ),
                  ),
                )
              : null,
            props.mode === "library"
              ? element(
                  "div",
                  { className: classes("media-location") },
                  element(
                    "span",
                    null,
                    t("文件位置"),
                    "：",
                    folder.value || t("全部图片"),
                  ),
                  element(
                    "small",
                    null,
                    t("共 {count} 张图片", { count: filtered.value.length }),
                  ),
                )
              : null,
            props.mode === "colocated" &&
              !supportsColocatedMedia(props.documentPath)
              ? element(
                  "p",
                  { className: classes("muted small") },
                  t("此文稿不支持同目录封面，请在「公共封面」中选图。"),
                )
              : null,
            mediaError.value
              ? element(
                  ErrorNotice,
                  { source: "MediaBrowser", message: mediaError.value },
                  " ",
                  element(
                    "button",
                    {
                      type: "button",
                      className: classes("text-button"),
                      onClick: domEvent(($event: Event) => {
                        loadMedia(true);
                      }),
                    },
                    t("重试"),
                  ),
                )
              : null,
            mediaListing.value.truncated
              ? element(
                  "p",
                  { className: classes("notice") },
                  t("图片或目录数量超过本次扫描上限，当前仅显示部分结果。"),
                )
              : null,
            mediaLoading.value
              ? element(LoadingState, {
                  label: "正在读取仓库图片…",
                  compact: !!mediaListing.value.items.length,
                })
              : null,
            !mediaLoading.value && !filtered.value.length && !mediaError.value
              ? element(
                  "div",
                  { className: classes("empty-state") },
                  element(Icon, { name: "image", size: 34 }),
                  element("h3", null, t("没有找到图片")),
                  element(
                    "p",
                    { className: classes("muted small") },
                    search.value || folder.value
                      ? t("试试其他关键词或文件夹。")
                      : props.mode === "colocated"
                        ? supportsColocatedMedia(props.documentPath)
                          ? t("上传图片后即可在这里选择。")
                          : t("请改用公共封面选择公共图片。")
                        : t("上传第一张图片，或刷新仓库查看已有图片。"),
                  ),
                )
              : element(
                  "div",
                  { className: classes("media-grid") },
                  renderList(items.value).map((item) => {
                    const card = element(
                      "button",
                      {
                        key: item.path,
                        type: "button",
                        "data-media-path": item.path,
                        "aria-label":
                          (props.current === item.path && props.selected !== item.path
                            ? `${t("当前图片")} · `
                            : "") + t("选择图片：{p0}", { p0: item.path }),
                        "aria-pressed": props.selected === item.path,
                        "aria-haspopup": props.mode === "library" ? "dialog" : undefined,
                        disabled:
                          !!item.unavailable ||
                          mediaLoading.value ||
                          mediaUploading.value ||
                          !!mediaError.value,
                        className: classes("media-card", {
                          selected: props.selected === item.path,
                        }),
                        onClick: domEvent(($event: Event) => {
                          choose(item, $event.currentTarget as HTMLButtonElement);
                        }),
                      },
                      element(
                        "span",
                        { className: classes("media-thumbnail") },
                        !item.unavailable && !failed.value.has(item.path)
                          ? <MediaPreviewImage item={item} version={mediaVersion.value} thumbnail
                              onError={() => { failed.value = new Set([...failed.value, item.path]); }} />
                          : element(
                              "span",
                              { className: classes("muted small") },
                              t(item.unavailable) || t("暂时无法预览"),
                            ),
                      ),
                      element(
                        "span",
                        { className: classes("media-name") },
                        item.name,
                      ),
                      props.current === item.path && props.selected !== item.path
                        ? element(
                            "span",
                            { className: classes("media-path") },
                            t("当前图片"),
                          )
                        : null,
                      element(
                        "span",
                        { className: classes("media-path") },
                        t("文件位置"),
                        "：",
                        item.directory,
                      ),
                      element(
                        "span",
                        { className: classes("media-size") },
                        imageExtension(item.path).toUpperCase(),
                        " · ",
                        formatBytes(item.size),
                      ),
                    );
                    const issue = item.unavailable || (failed.value.has(item.path) && "暂时无法预览");
                    return issue ? <div className="media-error-item" key={item.path}>{card}<ErrorDetails message={issue} source="MediaBrowser" /></div> : card;
                  }),
                ),
            !mediaLoading.value &&
              !mediaError.value &&
              (props.mode !== "library" || pages.value > 1)
              ? element(
                  "div",
                  { className: classes("media-pagination") },
                  element(
                    "small",
                    { className: classes("muted") },
                    t("共 {count} 张图片", { count: filtered.value.length }),
                  ),
                  pages.value > 1
                    ? element(
                        "div",
                        { className: classes("row") },
                        element(
                          "button",
                          {
                            type: "button",
                            disabled: page.value <= 1,
                            className: classes("text-button"),
                            onClick: domEvent(($event: Event) => {
                              page.value--;
                            }),
                          },
                          t("上一页"),
                        ),
                        element("small", null, page.value, " / ", pages.value),
                        element(
                          "button",
                          {
                            type: "button",
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
        ),
      );
  },
  { mode: "library", documentPath: "", selected: "", svgOnly: false },
);
export default MediaBrowser;
