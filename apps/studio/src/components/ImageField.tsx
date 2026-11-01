import { mediaURL, storedMediaPath, type MediaMode } from "../../shared/media";
import { t } from "../i18n";
import { mediaVersion } from "../media-store";
import {
  classes,
  component,
  domEvent,
  element,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, ref, watch } from "../reactivity";
import Icon from "./Icon";
import MediaPicker from "./MediaPicker";

type Props = {
  modelValue: string;
  name: string;
  label: string;
  hint?: string;
  mode: MediaMode;
  documentPath: string;
  disabled?: boolean;
  preview: boolean;
};
type Events = { "update:modelValue": [value: string] };
const ImageField: StudioComponent<Props, Events> = component<Props, Events>(
  "ImageField",
  (props, emit, expose) => {
    const opened = ref(false),
      failed = ref(false);
    const path = computed(() =>
      storedMediaPath(props.modelValue, props.mode, props.documentPath),
    );
    const src = computed(() =>
      !props.preview
        ? ""
        : path.value
          ? mediaURL(path.value, mediaVersion.value)
          : /^https?:\/\//i.test(props.modelValue)
            ? props.modelValue
            : "",
    );
    watch(src, () => {
      failed.value = false;
    });
    watch(
      () => props.disabled,
      (value) => {
        if (value) opened.value = false;
      },
    );
    return () =>
      element(
        "div",
        {
          "data-image-field": props.name,
          className: classes("field image-field", {
            "has-preview": props.preview && !!props.modelValue,
          }),
        },
        element("label", { htmlFor: `image-${props.name}` }, props.label),
        props.preview && props.modelValue
          ? element(
              "div",
              { className: classes("image-field-preview") },
              src.value && !failed.value
                ? element("img", {
                    src: src.value,
                    alt: t("{p0}预览", { p0: props.label }),
                    loading: "lazy",
                    decoding: "async",
                    referrerPolicy: "no-referrer",
                    onError: domEvent(($event: Event) => {
                      failed.value = true;
                    }),
                  })
                : element(
                    "span",
                    {
                      role: "img",
                      "aria-label": src.value
                        ? t("暂时无法预览，已保留原地址")
                        : t("已保留原值，可从仓库选择图片"),
                      title: src.value
                        ? t("暂时无法预览，已保留原地址")
                        : t("已保留原值，可从仓库选择图片"),
                      className: classes("image-preview-fallback"),
                    },
                    element(Icon, { name: "image", size: 18 }),
                  ),
            )
          : null,
        element("input", {
          id: `image-${props.name}`,
          name: props.name,
          value: props.modelValue,
          disabled: props.disabled,
          placeholder: t("选择、上传图片，或填写图片地址"),
          onInput: domEvent(($event: Event) => {
            emit(
              "update:modelValue",
              ($event.target as HTMLInputElement).value,
            );
          }),
        }),
        element(
          "div",
          { className: classes("row") },
          element(
            "button",
            {
              type: "button",
              disabled: props.disabled,
              "aria-label": t("选择或上传{p0}", { p0: props.label }),
              className: classes("secondary"),
              onClick: domEvent(($event: Event) => {
                opened.value = true;
              }),
            },
            t("选择或上传"),
          ),
          props.modelValue
            ? element(
                "button",
                {
                  type: "button",
                  disabled: props.disabled,
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    emit("update:modelValue", "");
                  }),
                },
                t("清空"),
              )
            : null,
        ),
        props.hint
          ? element("small", { className: classes("muted") }, props.hint)
          : null,
        opened.value
          ? element(MediaPicker, {
              mode: props.mode,
              documentPath: props.documentPath,
              selected: path.value || "",
              svgOnly: props.name.endsWith("svg_sprite"),
              onSelect: ((_item, value) =>
                emit("update:modelValue", value)) satisfies EventHandler<
                typeof MediaPicker,
                "onSelect"
              >,
              onClose: (() => {
                opened.value = false;
              }) satisfies EventHandler<typeof MediaPicker, "onClose">,
            })
          : null,
      );
  },
  { mode: "public", documentPath: "", preview: true },
);
export default ImageField;
