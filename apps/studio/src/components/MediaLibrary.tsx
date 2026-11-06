import { formatBytes, mediaURL, type MediaItem } from "../../shared/media";
import { t } from "../i18n";
import { mediaListing, mediaVersion } from "../media-store";
import {
  classes,
  component,
  domEvent,
  element,
  Fragment,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "../reactivity";
import MediaBrowser from "./MediaBrowser";

type Props = {};
type Events = {};
const MediaLibrary: StudioComponent<Props, Events> = component<Props, Events>(
  "MediaLibrary",
  (props, emit, expose) => {
    const selected = ref<MediaItem>(),
      message = ref(""),
      copied = ref(""),
      failed = ref(false);
    const publicPath = computed(() =>
      selected.value?.path.startsWith("public/")
        ? "/" + selected.value.path.slice(7)
        : "",
    );
    watch(mediaVersion, () => {
      if (selected.value)
        selected.value = mediaListing.value.items.find(
          (item) => item.path === selected.value?.path,
        );
      failed.value = false;
      message.value = "";
      copied.value = "";
    });
    const detailsId = useId();
    function selectedTile() {
      return [...document.querySelectorAll<HTMLElement>('.media-library .media-card')]
        .find(tile => tile.dataset.mediaPath === selected.value?.path);
    }
    let selectionGeneration = 0;
    onBeforeUnmount(() => { selectionGeneration++; });
    function choose(item: MediaItem) {
      const generation = ++selectionGeneration;
      selected.value = item;
      message.value = "";
      copied.value = "";
      failed.value = false;
      if (window.matchMedia('(max-width: 1180px)').matches) {
        void nextTick().then(() => {
          if (generation !== selectionGeneration) return;
          const details = document.getElementById(detailsId);
          details?.focus({ preventScroll: true });
          details?.scrollIntoView({ block: 'start', behavior: 'instant' });
        });
      }
    }
    async function copy(value: string) {
      try {
        await navigator.clipboard.writeText(value);
        copied.value = value;
        message.value = "路径已复制";
      } catch {
        copied.value = value;
        message.value = "可选中下方路径手动复制";
      }
    }
    return () =>
      element(
        "section",
        { className: classes("media-library") },
        element(
          "div",
          { className: classes("page-heading") },
          element(
            "div",
            null,

            element("h1", null, t("媒体库")),
          ),
        ),
        element(
          "div",
          { className: classes("media-library-layout") },
          element(
            "section",
            { className: classes("card media-library-browser") },
            element(MediaBrowser, {
              selected: selected.value?.path,
              onSelect: choose satisfies EventHandler<
                typeof MediaBrowser,
                "onSelect"
              >,
            }),
          ),
          element(
            "aside",
            { id: detailsId, tabIndex: -1, 'aria-label': t('图片详情'), className: classes("card media-details") },
            selected.value
              ? element(
                  Fragment,
                  null,
                  element("button", {
                    type: 'button',
                    className: classes('text-button media-details-back'),
                    onClick: () => {
                      // Re-query by path: touch activation need not focus a tile,
                      // and upload/list refresh may have replaced its DOM node.
                      const target = selectedTile() ?? document.querySelector<HTMLElement>('.media-library-browser');
                      if (target) {
                        if (!target.matches('button,[tabindex]')) target.tabIndex = -1;
                        target.focus({ preventScroll: true });
                        target.scrollIntoView({ block: 'center', behavior: 'instant' });
                      }
                    },
                  }, t('返回图片列表')),
                  element("h2", null, selected.value.name),
                  !failed.value
                    ? element("img", {
                        src: mediaURL(selected.value.path, mediaVersion.value),
                        alt: selected.value.name,
                        decoding: "async",
                        onError: domEvent(($event: Event) => {
                          failed.value = true;
                        }),
                      })
                    : element(
                        "p",
                        { className: classes("muted") },
                        t("暂时无法预览"),
                      ),
                  element(
                    "dl",
                    null,
                    element("dt", null, t("类型与大小")),
                    element(
                      "dd",
                      null,
                      selected.value.mime,
                      " · ",
                      formatBytes(selected.value.size),
                    ),
                    element("dt", null, t("文件位置")),
                    element("dd", null, selected.value.path),
                    publicPath.value
                      ? element(
                          Fragment,
                          null,
                          element("dt", null, t("站点路径")),
                          element("dd", null, publicPath.value),
                        )
                      : null,
                  ),
                  element(
                    "div",
                    { className: classes("row") },
                    publicPath.value
                      ? element(
                          "button",
                          {
                            type: "button",
                            className: classes("primary"),
                            onClick: domEvent(($event: Event) => {
                              copy(publicPath.value);
                            }),
                          },
                          t("复制站点路径"),
                        )
                      : null,
                    element(
                      "button",
                      {
                        type: "button",
                        className: classes("secondary"),
                        onClick: domEvent(($event: Event) => {
                          copy(selected.value!.path);
                        }),
                      },
                      t("复制仓库路径"),
                    ),
                    !publicPath.value
                      ? element(
                          "button",
                          {
                            type: "button",
                            className: classes("secondary"),
                            onClick: domEvent(($event: Event) => {
                              copy(selected.value!.name);
                            }),
                          },
                          t("复制文件名"),
                        )
                      : null,
                  ),

                  message.value
                    ? element(
                        "p",
                        { role: "status", className: classes("muted small") },
                        t(message.value),
                      )
                    : null,
                  copied.value
                    ? element("input", {
                        "aria-label": t("已复制的图片路径"),
                        value: copied.value,
                        readOnly: true,
                        onFocus: domEvent(($event: Event) => {
                          ($event.target as HTMLInputElement).select();
                        }),
                      })
                    : null,
                )
              : element(
                  "p",
                  { className: classes("muted") },
                  t("选择图片预览"),
                ),
          ),
        ),
      );
  },
  {},
);
export default MediaLibrary;
