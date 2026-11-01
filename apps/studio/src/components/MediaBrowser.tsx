import {
  formatBytes,
  imageExtension,
  mediaURL,
  mediaValue,
  supportsColocatedMedia,
  type MediaItem,
  type MediaMode,
} from "../../shared/media";
import { t } from "../i18n";
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
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, onMounted, ref, watch } from "../reactivity";
import Icon from "./Icon";
import LoadingState from "./LoadingState";
import MediaDirectoryNode from "./MediaDirectoryNode";
import MediaUpload from "./MediaUpload";
import SelectionField from "./SelectionField";

type Props = {
  mode: MediaMode;
  documentPath: string;
  selected: string;
  svgOnly: boolean;
};
type Events = { select: [item: MediaItem, value: string] };
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
    const folders = computed(() => [
      { value: "", label: t("全部文件夹") },
      ...[...new Set(eligible.value.map((item) => item.directory))]
        .sort()
        .map((value) => ({ value, label: `${t("文件位置")}：${value}` })),
    ]);
    const filtered = computed(() =>
      eligible.value.filter(
        (item) =>
          (props.mode === "library"
            ? inMediaDirectory(item, folder.value)
            : !folder.value || item.directory === folder.value) &&
          (source.value === "all" ||
            item.path.startsWith(source.value + "/")) &&
          item.path
            .toLocaleLowerCase()
            .includes(search.value.trim().toLocaleLowerCase()),
      ),
    );
    const pages = computed(() =>
      Math.max(1, Math.ceil(filtered.value.length / 24)),
    );
    const items = computed(() =>
      filtered.value.slice((page.value - 1) * 24, page.value * 24),
    );
    watch([search, source, folder], () => {
      page.value = 1;
    });
    watch(mediaVersion, () => {
      failed.value = new Set();
      if (
        folder.value &&
        !eligible.value.some((item) => inMediaDirectory(item, folder.value))
      )
        folder.value = "";
      page.value = 1;
    });
    onMounted(() => {
      void loadMedia();
    });
    function uploaded(item: MediaItem) {
      search.value = "";
      source.value = "all";
      folder.value = props.mode === "library" ? item.directory : "";
      page.value = 1;
      const value = mediaValue(item, props.mode, props.documentPath);
      if (value !== null) emit("select", item, value);
    }
    function choose(item: MediaItem) {
      const value = mediaValue(item, props.mode, props.documentPath);
      if (value !== null && !mediaLoading.value && !mediaError.value)
        emit("select", item, value);
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
                "nav",
                {
                  "aria-label": t("图片目录"),
                  className: classes("media-directory-tree"),
                },
                element(
                  "div",
                  { className: classes("media-tree-heading") },
                  element("strong", null, t("图片目录")),
                ),
                element(
                  "button",
                  {
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
                preferredDirectory: folder.value,
                onUploaded: uploaded satisfies EventHandler<
                  typeof MediaUpload,
                  "onUploaded"
                >,
              }),
            ),
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
                  "div",
                  { className: classes("media-filters") },
                  props.mode === "document"
                    ? element(SelectionField, {
                        modelValue: source.value,
                        name: "media-source",
                        label: t("图片来源"),
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
                      })
                    : null,
                  element(SelectionField, {
                    modelValue: folder.value,
                    name: "media-folder",
                    label: t("文件夹"),
                    options: folders.value,
                    onUpdateModelValue: (($event) => {
                      folder.value = String($event);
                    }) satisfies EventHandler<
                      typeof SelectionField,
                      "onUpdateModelValue"
                    >,
                  }),
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
                  "p",
                  { role: "alert", className: classes("notice error") },
                  t(mediaError.value),
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
                  renderList(items.value).map((item) =>
                    element(
                      "button",
                      {
                        key: item.path,
                        type: "button",
                        "data-media-path": item.path,
                        "aria-label": t("选择图片：{p0}", { p0: item.path }),
                        "aria-pressed": props.selected === item.path,
                        disabled:
                          !!item.unavailable ||
                          mediaLoading.value ||
                          mediaUploading.value ||
                          !!mediaError.value,
                        className: classes("media-card", {
                          selected: props.selected === item.path,
                        }),
                        onClick: domEvent(($event: Event) => {
                          choose(item);
                        }),
                      },
                      element(
                        "span",
                        { className: classes("media-thumbnail") },
                        !item.unavailable && !failed.value.has(item.path)
                          ? element("img", {
                              src: mediaURL(item.path, mediaVersion.value),
                              alt: "",
                              loading: "lazy",
                              decoding: "async",
                              onError: domEvent(($event: Event) => {
                                failed.value.add(item.path);
                              }),
                            })
                          : element(
                              "span",
                              { className: classes("muted small") },
                              t(item.unavailable) || t("暂时无法预览"),
                            ),
                        props.selected === item.path
                          ? element(
                              "span",
                              { className: classes("media-selected-mark") },
                              element(Icon, { name: "check", size: 16 }),
                            )
                          : null,
                      ),
                      element(
                        "span",
                        { className: classes("media-name") },
                        item.name,
                      ),
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
                    ),
                  ),
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
