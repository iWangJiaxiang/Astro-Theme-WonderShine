import {
  documentDirectory,
  imageExtension,
  imageMime,
  MAX_UPLOAD_SIZE,
  mediaTypes,
  supportsColocatedMedia,
  type MediaItem,
  type MediaMode,
  type MediaUploadResult,
} from "../../shared/media";
import { api, ApiError, errorMessage, session } from "../api";
import { t, type Message } from "../i18n";
import {
  addUploadedMedia,
  mediaListing,
  mediaLoading,
  mediaUploading,
} from "../media-store";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, onBeforeUnmount, ref, watch } from "../reactivity";
import SelectionField from "./SelectionField";

type Props = {
  mode: MediaMode;
  documentPath: string;
  svgOnly: boolean;
  preferredDirectory?: string;
};
type Events = { uploaded: [item: MediaItem] };
const MediaUpload: StudioComponent<Props, Events> = component<Props, Events>(
  "MediaUpload",
  (props, emit, expose) => {
    const input = ref<HTMLInputElement>(),
      directory = ref("public/uploads"),
      dragging = ref(false),
      error = ref<Message>("");
    const results = ref<
        {
          name: string;
          item?: MediaItem;
          error?: Message;
        }[]
      >([]),
      total = ref(0),
      completed = ref(0);
    let disposed = false;
    onBeforeUnmount(() => {
      disposed = true;
    });
    const bundle = computed(() =>
      supportsColocatedMedia(props.documentPath)
        ? documentDirectory(props.documentPath).replace(/\/$/, "")
        : "",
    );
    const destinations = computed(() => {
      const choices =
        props.mode === "colocated"
          ? []
          : [
              { value: "public/uploads", label: t("公共图片（默认）") },
              ...[
                ...new Set(
                  mediaListing.value.items
                    .filter(
                      (item) =>
                        item.path.startsWith("public/") &&
                        !item.directory
                          .split("/")
                          .some((part) =>
                            [
                              "node_modules",
                              "processed_images",
                              "dist",
                            ].includes(part),
                          ),
                    )
                    .map((item) => item.directory),
                ),
              ]
                .filter((path) => path !== "public/uploads")
                .sort()
                .map((value) => ({
                  value,
                  label: `${t("文件位置")}：${value}`,
                })),
            ];
      if (bundle.value && ["document", "colocated"].includes(props.mode))
        choices.unshift({ value: bundle.value, label: t("当前文稿目录") });
      return choices;
    });
    watch(
      () => [props.mode, props.documentPath],
      () => {
        directory.value =
          bundle.value && ["document", "colocated"].includes(props.mode)
            ? bundle.value
            : "public/uploads";
      },
      { immediate: true },
    );
    watch(
      () => props.preferredDirectory,
      (value) => {
        if (
          value &&
          destinations.value.some((choice) => choice.value === value) &&
          !mediaUploading.value
        )
          directory.value = value;
      },
    );
    const allowed = computed(() =>
      destinations.value.some((choice) => choice.value === directory.value),
    );
    const maxFileSize = computed(
      () => mediaListing.value.maxFileSize || MAX_UPLOAD_SIZE,
    );
    const disabled = computed(
      () => mediaUploading.value || mediaLoading.value || !allowed.value,
    );
    const accept = computed(() =>
      props.svgOnly
        ? ".svg"
        : Object.keys(mediaTypes)
            .map((type) => "." + type)
            .join(","),
    );
    async function upload(files: File[]) {
      if (disabled.value || !files.length) return;
      error.value = "";
      if (files.length > 20) {
        error.value = "每次最多选择 20 张图片";
        return;
      }
      const target = directory.value,
        identity = session.value?.identity.id;
      results.value = [];
      total.value = files.length;
      completed.value = 0;
      mediaUploading.value = true;
      try {
        for (const file of files) {
          if (disposed || identity !== session.value?.identity.id) break;
          try {
            if (
              !imageMime(file.name) ||
              (props.svgOnly && imageExtension(file.name) !== "svg")
            )
              throw new Error(
                props.svgOnly ? "请选择 SVG 图片" : "请选择支持的图片格式",
              );
            if (!file.size) throw new Error("不能上传空文件");
            if (file.size > maxFileSize.value)
              throw new ApiError("每张图片不能超过 {limit} MB", 413, {
                limit: maxFileSize.value / 1024 / 1024,
              });
            const saved = await api<MediaUploadResult>(
              "/media/upload?" +
                new URLSearchParams({ directory: target, filename: file.name }),
              "POST",
              file,
            );
            if (identity !== session.value?.identity.id) break;
            addUploadedMedia(saved.item);
            results.value.push({ name: file.name, item: saved.item });
            if (!disposed) emit("uploaded", saved.item);
          } catch (reason) {
            results.value.push({
              name: file.name,
              error: errorMessage(reason),
            });
            if (
              reason instanceof ApiError &&
              [401, 403, 409].includes(reason.status)
            ) {
              for (const skipped of files.slice(completed.value + 1))
                results.value.push({
                  name: skipped.name,
                  error: "上传已暂停，请检查提示后重新选择未上传的图片",
                });
              break;
            }
          } finally {
            completed.value++;
          }
        }
      } finally {
        mediaUploading.value = false;
      }
    }
    function select(event: Event) {
      const element = event.target as HTMLInputElement;
      const files = Array.from(element.files || []);
      element.value = "";
      void upload(files);
    }
    function drop(event: DragEvent) {
      dragging.value = false;
      void upload(Array.from(event.dataTransfer?.files || []));
    }
    return () =>
      element(
        "section",
        {
          "aria-label": t("上传图片"),
          className: classes("media-upload", { dragging: dragging.value }),
          onDragOver: domEvent(($event: Event) => {
            $event.preventDefault();
            dragging.value = !disabled.value;
          }),
          onDragLeave: domEvent(($event: Event) => {
            if ($event.target !== $event.currentTarget) return;
            dragging.value = false;
          }),
          onDrop: domEvent(($event: Event) => {
            $event.preventDefault();
            $event.stopPropagation();
            drop($event as never);
          }),
        },
        allowed.value
          ? element(
              Fragment,
              null,
              element(
                "div",
                { className: classes("upload-actions") },
                element(
                  "div",
                  null,
                  element("strong", null, t("上传图片")),
                  element(
                    "p",
                    { className: classes("muted small") },
                    t("拖拽上传 · 每张最多 {limit} MB", {
                      limit: maxFileSize.value / 1024 / 1024,
                    }),
                  ),
                ),
                element(
                  "button",
                  {
                    type: "button",
                    disabled: disabled.value,
                    className: classes("secondary"),
                    onClick: domEvent(($event: Event) => {
                      input.value?.click();
                    }),
                  },
                  mediaUploading.value ? t("上传中…") : t("选择文件"),
                ),
                element("input", {
                  ref: domRef(input),
                  type: "file",
                  accept: accept.value,
                  multiple: true,
                  disabled: disabled.value,
                  "aria-label": t("选择上传图片"),
                  className: classes("upload-file-input"),
                  onChange: domEvent(($event: Event) => {
                    select($event as never);
                  }),
                }),
              ),
              element(SelectionField, {
                modelValue: directory.value,
                name: "upload-directory",
                label: t("保存位置"),
                options: destinations.value,
                disabled: mediaUploading.value || mediaLoading.value,
                onUpdateModelValue: (($event) => {
                  directory.value = String($event);
                }) satisfies EventHandler<
                  typeof SelectionField,
                  "onUpdateModelValue"
                >,
              }),
              element(
                "small",
                { className: classes("muted upload-destination") },
                t("文件位置"),
                "：",
                directory.value,
              ),
              mediaUploading.value
                ? element(
                    "div",
                    { role: "status", className: classes("upload-progress") },
                    element("progress", {
                      max: total.value,
                      value: completed.value,
                    }),
                    t("正在上传 {current}/{total}", {
                      current: Math.min(completed.value + 1, total.value),
                      total: total.value,
                    }),
                  )
                : null,
              error.value
                ? element(
                    "p",
                    { role: "alert", className: classes("notice error") },
                    t(error.value),
                  )
                : null,
              results.value.length
                ? element(
                    "ul",
                    {
                      "aria-live": "polite",
                      className: classes("upload-results"),
                    },
                    renderList(results.value).map((result, index) =>
                      element(
                        "li",
                        { key: index },
                        result.item
                          ? element(
                              "button",
                              {
                                type: "button",
                                disabled: mediaUploading.value,
                                className: classes("text-button"),
                                onClick: domEvent(($event: Event) => {
                                  result.item && emit("uploaded", result.item);
                                }),
                              },
                              t("已上传：{name}", { name: result.item.name }),
                            )
                          : element(
                              "span",
                              { className: classes("upload-error") },
                              result.name,
                              " — ",
                              t(result.error),
                            ),
                      ),
                    ),
                  )
                : null,
              element(
                "p",
                { className: classes("muted small upload-note") },
                t("上传即保存到仓库，选用后请保存表单。"),
              ),
            )
          : element(
              "p",
              { className: classes("muted small") },
              t("此文稿不支持同目录图片，请使用公共图片。"),
            ),
      );
  },
  {},
);
export default MediaUpload;
