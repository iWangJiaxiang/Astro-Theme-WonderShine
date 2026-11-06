import type { MediaItem, MediaMode } from "../../shared/media";
import { createBusinessModal } from "../modal-layer";
import { t } from "../i18n";
import {
  mediaError,
  mediaListing,
  mediaLoading,
  mediaUploading,
  mediaVersion,
} from "../media-store";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  portal,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { onBeforeUnmount, onMounted, ref, useId, watch } from "../reactivity";
import MediaBrowser from "./MediaBrowser";

type Props = {
  mode: MediaMode;
  documentPath: string;
  selected: string;
  svgOnly: boolean;
};
type Events = { select: [item: MediaItem, value: string]; close: [] };
const MediaPicker: StudioComponent<Props, Events> = component<Props, Events>(
  "MediaPicker",
  (props, emit, expose) => {
    const dialog = ref<HTMLDialogElement>(),
      pending = ref<{
        item: MediaItem;
        value: string;
      }>();
    const id = useId();
    let previousFocus: HTMLElement | null = null;
    let wantsOpen = true;
    const modal = createBusinessModal(() => dialog.value, () => wantsOpen);
    onMounted(() => {
      previousFocus = document.activeElement as HTMLElement;
      modal.open();
    });
    function close() {
      if (mediaUploading.value) return;
      wantsOpen = false;
      modal.close();
      emit("close");
    }
    function confirm() {
      if (
        pending.value &&
        !mediaLoading.value &&
        !mediaUploading.value &&
        !mediaError.value
      ) {
        emit("select", pending.value.item, pending.value.value);
        close();
      }
    }
    watch(mediaVersion, () => {
      if (
        pending.value &&
        !mediaListing.value.items.some(
          (item) => item.path === pending.value?.item.path && !item.unavailable,
        )
      )
        pending.value = undefined;
    });
    onBeforeUnmount(() => {
      wantsOpen = false;
      modal.dispose();
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    return () =>
      portal(
        element(
          Fragment,
          null,
          element(
            "dialog",
            {
              ref: domRef(dialog),
              "aria-labelledby": id,
              className: classes("media-dialog"),
              onCancel: domEvent(($event: Event) => {
                $event.preventDefault();
                close();
              }),
              onClick: domEvent(($event: Event) => {
                $event.target === dialog.value && close();
              }),
            },
            element(
              "div",
              { className: classes("media-dialog-panel") },
              element(
                "div",
                { className: classes("card-heading") },
                element("h2", { id: id }, t("选择或上传图片")),
                element(
                  "button",
                  {
                    type: "button",
                    disabled: mediaUploading.value,
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
                { className: classes("media-dialog-body") },
                element(MediaBrowser, {
                  mode: props.mode,
                  documentPath: props.documentPath,
                  selected: pending.value?.item.path || "",
                  current: props.selected,
                  svgOnly: props.svgOnly,
                  onSelect: ((item, value) =>
                    (pending.value = { item, value })) satisfies EventHandler<
                    typeof MediaBrowser,
                    "onSelect"
                  >,
                }),
              ),
              element(
                "div",
                { className: classes("selection-footer") },
                element(
                  "small",
                  { className: classes("muted media-pending") },
                  pending.value
                    ? t("将填写：{p0}", { p0: pending.value.value })
                    : props.selected
                      ? t("尚未更改；选择图片后确认")
                      : t("选中图片后确认，取消不会修改表单"),
                ),
                element(
                  "button",
                  {
                    type: "button",
                    disabled:
                      !pending.value ||
                      mediaLoading.value ||
                      mediaUploading.value ||
                      !!mediaError.value,
                    className: classes("primary"),
                    onClick: domEvent(($event: Event) => {
                      confirm();
                    }),
                  },
                  t("使用这张图片"),
                ),
              ),
            ),
          ),
        ),
      );
  },
  { selected: "", documentPath: "", svgOnly: false },
);
export default MediaPicker;
