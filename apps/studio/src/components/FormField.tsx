import {
  dateParts,
  fieldChoices,
  fieldControl,
  isLinkField,
  isPostReference,
  updateDate,
} from "../../shared/form-fields";
import { isBackupImageField, isImageField } from "../../shared/media";
import type { Json } from "../../shared/types";
import { formContext } from "../form-context";
import { t } from "../i18n";
import { emojiChoices, glyphs, iconChoices, symbolChoices } from "../icons";
import {
  classes,
  component,
  domEvent,
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, inject } from "../reactivity";
import ChoicePreview from "./ChoicePreview";
import ImageField from "./ImageField";
import SelectionField from "./SelectionField";

type Props = {
  modelValue: Json | undefined;
  name: string;
  label: string;
  hint?: string;
  kind?: string;
  disabled?: boolean;
  required?: boolean;
  documentPath?: string;
  sprite?: string;
};
type Events = { "update:modelValue": [value: Json] };
const FormField: StudioComponent<Props, Events> = component<Props, Events>(
  "FormField",
  (props, emit, expose) => {
    const context = inject(formContext, undefined);
    const backupImage = computed(() => isBackupImageField(props.name));
    const label = computed(() =>
      t(backupImage.value ? "备用图标地址" : props.label),
    );
    const hint = computed(() =>
      backupImage.value
        ? t(
            "仅保留备用地址，后台不会自动加载或预览。展示图片请使用「本地图标」。",
          )
        : t(props.hint),
    );
    const control = computed(() => fieldControl(props.name));
    const imageMode = computed(() =>
      props.name === "extra.cover" &&
      props.documentPath &&
      !props.documentPath.endsWith("/_index.md")
        ? "colocated"
        : "public",
    );
    const text = computed(() => String(props.modelValue ?? ""));
    const choiceOptions = computed(() =>
      isPostReference(props.name)
        ? [
            { value: "", label: t("不指定文章") },
            ...(context?.posts.value || []),
          ]
        : fieldChoices(props.name)?.map((option) => ({
            ...option,
            label: t(option.label),
          })),
    );
    const parts = computed(() => dateParts(text.value));
    const colorValid = computed(
      () => !text.value || CSS.supports("color", text.value),
    );
    const hexColor = computed(() =>
      /^#[\da-f]{6}$/i.test(text.value)
        ? text.value
        : /^#[\da-f]{3}$/i.test(text.value)
          ? "#" + [...text.value.slice(1)].map((c) => c + c).join("")
          : "#425aef",
    );
    const customSprite = computed(
      () => !!props.sprite && props.sprite !== "/img/icons/sprite.svg",
    );
    const emoji = computed(
      () =>
        [
          ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            text.value,
          ),
        ].find((item) => /\p{Extended_Pictographic}/u.test(item.segment))
          ?.segment || "",
    );
    function set(value: Json) {
      if (!props.disabled) emit("update:modelValue", value);
    }
    function chooseEmoji(value: string | string[]) {
      const next = String(value);
      set(
        emoji.value
          ? text.value.replace(emoji.value, next)
          : `${next}${text.value ? " " + text.value : ""}`,
      );
    }
    return () =>
      props.kind === "boolean" || typeof props.modelValue === "boolean"
        ? element(
            "label",
            { className: classes("field checkbox-field form-switch") },
            element("input", {
              name: props.name,
              type: "checkbox",
              role: "switch",
              checked: Boolean(props.modelValue),
              disabled: props.disabled,
              onChange: domEvent(($event: Event) => {
                set(($event.target as HTMLInputElement).checked);
              }),
            }),
            element(
              "span",
              null,
              label.value,
              hint.value
                ? element("small", { className: classes("muted") }, hint.value)
                : null,
            ),
          )
        : choiceOptions.value
          ? element(SelectionField, {
              modelValue: props.modelValue,
              name: props.name,
              label: label.value,
              options: choiceOptions.value,
              disabled:
                props.disabled ||
                (isPostReference(props.name) &&
                  (context?.loading.value || !!context?.error.value)),
              hint: hint.value,
              onUpdateModelValue: set satisfies EventHandler<
                typeof SelectionField,
                "onUpdateModelValue"
              >,
            })
          : control.value === "date"
            ? element(
                "div",
                {
                  "data-field": props.name,
                  className: classes("field field-inline date-field"),
                },
                element("span", null, label.value),
                element(
                  "div",
                  { className: classes("date-inputs") },
                  element(
                    "label",
                    { className: classes("field") },
                    element("small", null, t("日期")),
                    element("input", {
                      name: props.name,
                      "aria-label": t("{p0}日期", { p0: label.value }),
                      type: "date",
                      required: props.required,
                      value: parts.value?.date || "",
                      disabled: props.disabled,
                      onInput: domEvent(($event: Event) => {
                        set(
                          updateDate(
                            text.value,
                            "date",
                            ($event.target as HTMLInputElement).value,
                          ),
                        );
                      }),
                    }),
                  ),
                  element(
                    "label",
                    { className: classes("field") },
                    element("small", null, t("时间（可选）")),
                    element("input", {
                      name: `${props.name}-time`,
                      "aria-label": t("{p0}时间", { p0: label.value }),
                      type: "time",
                      step: "0.001",
                      value: parts.value?.time.slice(0, 12) || "",
                      disabled: props.disabled || !parts.value?.date,
                      onInput: domEvent(($event: Event) => {
                        set(
                          updateDate(
                            text.value,
                            "time",
                            ($event.target as HTMLInputElement).value,
                          ),
                        );
                      }),
                    }),
                  ),
                ),
                parts.value?.time && parts.value.time.length > 12
                  ? element(
                      "small",
                      { className: classes("muted") },
                      t("时间显示到毫秒；未修改时间时保留原有完整精度。"),
                    )
                  : null,
                parts.value?.time
                  ? element(
                      "small",
                      { className: classes("muted") },
                      parts.value.zone
                        ? t("时区：{p0}", {
                            p0:
                              parts.value.zone === "Z"
                                ? "UTC"
                                : parts.value.zone,
                          })
                        : t("未指定时区，按站点原有规则处理"),
                    )
                  : null,
                text.value && !parts.value
                  ? element(
                      "small",
                      { className: classes("notice error") },
                      t("无法识别日期“{value}”，请用日期选择器修改。", {
                        value: text.value,
                      }),
                    )
                  : null,
                props.required && !text.value
                  ? element(
                      "small",
                      { className: classes(text.value ? "muted" : "danger") },
                      t("此类内容需要填写发布时间。"),
                    )
                  : null,
                hint.value
                  ? element(
                      "small",
                      { className: classes("muted") },
                      hint.value,
                    )
                  : null,
              )
            : control.value === "color"
              ? element(
                  "div",
                  {
                    "data-field": props.name,
                    className: classes("field field-inline"),
                  },
                  element(
                    "label",
                    { htmlFor: `color-${props.name}` },
                    label.value,
                  ),
                  element(
                    "div",
                    { className: classes("color-inputs") },
                    element("span", {
                      "aria-label": t("颜色预览：{p0}", {
                        p0: text.value || t("未设置"),
                      }),
                      className: classes("color-swatch"),
                      style: Object.assign(
                        {},
                        {
                          backgroundColor: colorValid.value
                            ? text.value
                            : "transparent",
                        },
                      ),
                    }),
                    element("input", {
                      type: "color",
                      "aria-label": t("选择{p0}", { p0: label.value }),
                      value: hexColor.value,
                      disabled: props.disabled,
                      onInput: domEvent(($event: Event) => {
                        set(($event.target as HTMLInputElement).value);
                      }),
                    }),
                    element("input", {
                      id: `color-${props.name}`,
                      name: props.name,
                      value: text.value,
                      disabled: props.disabled,
                      placeholder: "#425AEF",
                      spellCheck: "false",
                      onInput: domEvent(($event: Event) => {
                        set(($event.target as HTMLInputElement).value);
                      }),
                    }),
                  ),
                  !colorValid.value ||
                    (props.name.endsWith("_skin") &&
                      !/^#[\da-f]{6}$/i.test(text.value))
                    ? element(
                        "small",
                        { className: classes("danger") },
                        props.name.endsWith("_skin")
                          ? t("主题色需要六位十六进制值，例如 #425AEF。")
                          : t("颜色格式暂时无法预览。"),
                      )
                    : text.value &&
                        !/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(text.value)
                      ? element(
                          "small",
                          { className: classes("muted") },
                          t("保留原颜色表达式；使用选择器后改为十六进制颜色。"),
                        )
                      : null,
                  hint.value
                    ? element(
                        "small",
                        { className: classes("muted") },
                        hint.value,
                      )
                    : null,
                )
              : isImageField(props.name)
                ? element(ImageField, {
                    modelValue: text.value,
                    name: props.name,
                    label: label.value,
                    hint: hint.value,
                    preview:
                      !backupImage.value && !props.name.endsWith("svg_sprite"),
                    mode: imageMode.value,
                    documentPath: props.documentPath,
                    disabled: props.disabled,
                    onUpdateModelValue: set satisfies EventHandler<
                      typeof ImageField,
                      "onUpdateModelValue"
                    >,
                  })
                : control.value === "icon" || control.value === "symbol"
                  ? element(
                      "div",
                      {
                        "data-field": `${props.name}-preview`,
                        className: classes("field"),
                      },
                      !customSprite.value || control.value === "icon"
                        ? element(SelectionField, {
                            modelValue: text.value,
                            options: [
                              { value: "", label: t("不显示图标") },
                              ...(control.value === "icon"
                                ? iconChoices
                                : symbolChoices),
                            ],
                            preview: control.value,
                            name: props.name,
                            label: label.value,
                            disabled: props.disabled,
                            onUpdateModelValue: set satisfies EventHandler<
                              typeof SelectionField,
                              "onUpdateModelValue"
                            >,
                          })
                        : element(
                            "label",
                            { className: classes("field") },
                            label.value,
                            element("input", {
                              name: props.name,
                              value: text.value,
                              disabled: props.disabled,
                              onInput: domEvent(($event: Event) => {
                                set(($event.target as HTMLInputElement).value);
                              }),
                            }),
                            element(
                              "small",
                              { className: classes("muted") },
                              t("自定义图标集：{sprite}。请输入图标标识。", {
                                sprite: props.sprite || "",
                              }),
                            ),
                          ),
                      control.value === "icon" &&
                        text.value &&
                        !glyphs.has(text.value)
                        ? element(
                            "small",
                            { className: classes("muted") },
                            t("自定义图标值已保留，内置图标库暂无预览。"),
                          )
                        : null,
                      control.value === "symbol" &&
                        text.value &&
                        !customSprite.value &&
                        !symbolChoices.some(
                          (option) => option.value === text.value,
                        )
                        ? element(
                            "small",
                            { className: classes("muted") },
                            t("已有图标标识已保留，内置图标库暂无预览。"),
                          )
                        : null,
                      hint.value
                        ? element(
                            "small",
                            { className: classes("muted") },
                            hint.value,
                          )
                        : null,
                    )
                  : control.value === "emoji"
                    ? element(
                        "div",
                        { className: classes("field") },
                        element(
                          "label",
                          { className: classes("field field-inline") },
                          element("span", null, label.value),
                          element("input", {
                            name: props.name,
                            value: text.value,
                            disabled: props.disabled,
                            onInput: domEvent(($event: Event) => {
                              set(($event.target as HTMLInputElement).value);
                            }),
                          }),
                        ),
                        element(
                          "div",
                          { className: classes("emoji-line") },
                          element(ChoicePreview, {
                            value: emoji.value,
                            kind: "emoji",
                          }),
                          element(
                            "span",
                            null,
                            text.value || t("添加一句个人介绍"),
                          ),
                        ),
                        element(SelectionField, {
                          modelValue: emoji.value,
                          options: emojiChoices,
                          name: `${props.name}-emoji`,
                          label: t("表情"),
                          preview: "emoji",
                          disabled: props.disabled,
                          onUpdateModelValue:
                            chooseEmoji satisfies EventHandler<
                              typeof SelectionField,
                              "onUpdateModelValue"
                            >,
                        }),
                      )
                    : element(
                        "div",
                        {
                          className: classes(
                            "field form-input",
                            props.kind === "textarea"
                              ? "field-stacked"
                              : "field-inline",
                          ),
                        },
                        element(
                          "label",
                          { htmlFor: `field-${props.name}` },
                          label.value,
                        ),
                        props.kind === "textarea"
                          ? element("textarea", {
                              id: `field-${props.name}`,
                              name: props.name,
                              value: text.value,
                              disabled: props.disabled,
                              rows: "3",
                              onInput: domEvent(($event: Event) => {
                                set(
                                  ($event.target as HTMLTextAreaElement).value,
                                );
                              }),
                            })
                          : element("input", {
                              id: `field-${props.name}`,
                              name: props.name,
                              type:
                                props.kind === "number" ||
                                typeof props.modelValue === "number"
                                  ? "number"
                                  : props.name.endsWith("email")
                                    ? "email"
                                    : "text",
                              value: text.value,
                              disabled: props.disabled,
                              step:
                                props.kind === "number" ||
                                typeof props.modelValue === "number"
                                  ? "any"
                                  : undefined,
                              onInput: domEvent(($event: Event) => {
                                set(
                                  props.kind === "number" ||
                                    typeof props.modelValue === "number"
                                    ? Number(
                                        ($event.target as HTMLInputElement)
                                          .value,
                                      )
                                    : ($event.target as HTMLInputElement).value,
                                );
                              }),
                            }),
                        isLinkField(props.name) && context
                          ? element(SelectionField, {
                              modelValue: text.value,
                              options: context.links.value,
                              name: `${props.name}-site-link`,
                              label: t("选择站内页面"),
                              disabled: props.disabled || context.loading.value,
                              hint: t("可选择站内页面，也可直接填写外部链接。"),
                              onUpdateModelValue: set satisfies EventHandler<
                                typeof SelectionField,
                                "onUpdateModelValue"
                              >,
                            })
                          : null,
                        isLinkField(props.name) &&
                          context?.unresolved.value.length
                          ? element(
                              "details",
                              { className: classes("advanced-field") },
                              element(
                                "summary",
                                null,
                                t("部分内容需要手动填写地址"),
                              ),
                              renderList(context.unresolved.value).map((item) =>
                                element("p", { key: item }, item),
                              ),
                            )
                          : null,
                        hint.value
                          ? element(
                              "small",
                              { className: classes("muted") },
                              hint.value,
                            )
                          : null,
                      );
  },
  {},
);
export default FormField;
