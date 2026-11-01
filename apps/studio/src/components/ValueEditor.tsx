import {
  fieldChoices,
  fieldControl,
  isLinkField,
  isPostReference,
  localDate,
  newItem,
} from "../../shared/form-fields";
import { isImageField } from "../../shared/media";
import { fieldLabels } from "../../shared/settings";
import type { Json } from "../../shared/types";
import { t } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, ref, useId } from "../reactivity";
import FormField from "./FormField";

type Props = {
  modelValue: Json;
  name: string;
  label?: string;
  depth?: number;
  sprite?: string;
};
type Events = { "update:modelValue": [value: Json] };
const ValueEditor: StudioComponent<Props, Events> = component<Props, Events>(
  "ValueEditor",
  (props, emit, expose) => {
    const newKey = ref("");
    const expanded = ref(new Set<number>()),
      id = useId();
    function toggle(index: number) {
      const next = new Set(expanded.value);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      expanded.value = next;
    }
    function itemTitle(item: Json, index: number): string {
      if (typeof item === "string" && item) return item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const key of [
          "name",
          "display_name",
          "title",
          "tittle",
          "label",
          "text",
          "content",
          "authorInfoTitle",
          "occupation",
          "widget",
          "id",
          "url",
        ]) {
          if (typeof item[key] === "string" && item[key]) {
            const choice = fieldChoices(`${props.name}.${index}.${key}`)?.find(
              (option) => option.value === item[key],
            );
            return choice ? t(choice.label) : (item[key] as string);
          }
        }
      }
      return `${label.value} ${index + 1}`;
    }
    function itemDescription(item: Json): string {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "";
      return Object.entries(item)
        .filter(([, value]) => Array.isArray(value))
        .map(
          ([key, value]) =>
            `${t(fieldLabels[key] || key)} · ${(value as Json[]).length}`,
        )
        .join(" / ");
    }
    const label = computed(() =>
      t(
        props.label ||
          fieldLabels[props.name.split(".").at(-1)!] ||
          props.name.split(".").at(-1),
      ),
    );
    const depth = computed(() => props.depth || 0);
    const object = computed(() =>
      props.modelValue &&
      !Array.isArray(props.modelValue) &&
      typeof props.modelValue === "object"
        ? props.modelValue
        : {},
    );
    function compactObject(value: Json, path: string): boolean {
      if (!value || Array.isArray(value) || typeof value !== "object")
        return false;
      const entries = Object.entries(value);
      return (
        entries.length > 0 &&
        entries.length <= 4 &&
        entries.every(([key, item]) => {
          const field = `${path}.${key}`;
          return (
            (item === null || typeof item !== "object") &&
            fieldControl(field) === "text" &&
            !fieldChoices(field) &&
            !isImageField(field) &&
            !isLinkField(field) &&
            !isPostReference(field) &&
            !(
              typeof item === "string" &&
              (item.includes("\n") || item.length > 160)
            )
          );
        })
      );
    }
    function compactItem(value: Json, index: number): boolean {
      const path = `${props.name}.${index}`;
      return value !== null && typeof value === "object"
        ? compactObject(value, path)
        : !isImageField(path) && fieldControl(path) !== "emoji";
    }
    function changeItem(index: number, value?: Json) {
      const items = [...(props.modelValue as Json[])];
      if (value === undefined) {
        items.splice(index, 1);
        expanded.value = new Set(
          [...expanded.value]
            .filter((i) => i !== index)
            .map((i) => (i > index ? i - 1 : i)),
        );
      } else items[index] = value;
      emit("update:modelValue", items);
    }
    function move(index: number, direction: number) {
      const items = [...(props.modelValue as Json[])];
      [items[index], items[index + direction]] = [
        items[index + direction],
        items[index],
      ];
      expanded.value = new Set(
        [...expanded.value].map((i) =>
          i === index ? i + direction : i === index + direction ? index : i,
        ),
      );
      emit("update:modelValue", items);
    }
    function addItem() {
      expanded.value = new Set([
        ...expanded.value,
        (props.modelValue as Json[]).length,
      ]);
      emit("update:modelValue", [
        ...(props.modelValue as Json[]),
        newItem(props.name, localDate(), (props.modelValue as Json[])[0]),
      ]);
    }
    function addKey() {
      const key = newKey.value.trim();
      if (
        !/^[A-Za-z_][\w-]*$/.test(key) ||
        ["__proto__", "constructor", "prototype"].includes(key)
      )
        return;
      if (Object.hasOwn(object.value, key)) return;
      emit("update:modelValue", { ...object.value, [key]: "" });
      newKey.value = "";
    }
    return () =>
      Array.isArray(props.modelValue)
        ? element(
            "div",
            {
              "data-structured": props.name,
              className: classes("structured", { nested: depth.value > 0 }),
            },
            element(
              "div",
              { className: classes("structured-heading") },
              element("span", null, label.value),
              element(
                "span",
                { className: classes("count") },
                props.modelValue.length,
              ),
            ),
            !props.modelValue.length
              ? element(
                  "p",
                  { className: classes("muted small") },
                  t("暂未添加内容"),
                )
              : null,
            renderList(props.modelValue).map((item, index) =>
              element(
                "div",
                {
                  key: index,
                  className: classes("structured-item", {
                    "compact-item": compactItem(item, index),
                    "collapsible-item": !compactItem(item, index),
                    "item-expanded": expanded.value.has(index),
                  }),
                },
                !compactItem(item, index)
                  ? element(
                      "button",
                      {
                        type: "button",
                        "aria-expanded": expanded.value.has(index),
                        "aria-controls": `${id}-${index}`,
                        "aria-label": t(
                          expanded.value.has(index)
                            ? "收起{title}"
                            : "展开{title}",
                          { title: itemTitle(item, index) },
                        ),
                        className: classes("structured-toggle"),
                        onClick: domEvent(($event: Event) => {
                          toggle(index);
                        }),
                      },
                      element(
                        "span",
                        {
                          "aria-hidden": "true",
                          className: classes("structured-chevron"),
                        },
                        "›",
                      ),
                      element(
                        "span",
                        { className: classes("structured-summary") },
                        element("strong", null, itemTitle(item, index)),
                        itemDescription(item)
                          ? element("small", null, itemDescription(item))
                          : null,
                      ),
                    )
                  : null,
                element(
                  "div",
                  { className: classes("item-actions") },
                  element(
                    "span",
                    { className: classes("item-number") },
                    String(index + 1).padStart(2, "0"),
                  ),
                  element(
                    "button",
                    {
                      type: "button",
                      disabled: index === 0,
                      "aria-label": t("上移{p0}第{p1}项", {
                        p0: label.value,
                        p1: index + 1,
                      }),
                      className: classes("icon-button"),
                      onClick: domEvent(($event: Event) => {
                        move(index, -1);
                      }),
                    },
                    "↑",
                  ),
                  element(
                    "button",
                    {
                      type: "button",
                      disabled:
                        index === (props.modelValue as Json[]).length - 1,
                      "aria-label": t("下移{p0}第{p1}项", {
                        p0: label.value,
                        p1: index + 1,
                      }),
                      className: classes("icon-button"),
                      onClick: domEvent(($event: Event) => {
                        move(index, 1);
                      }),
                    },
                    "↓",
                  ),
                  element(
                    "button",
                    {
                      type: "button",
                      "aria-label": t("删除{p0}第{p1}项", {
                        p0: label.value,
                        p1: index + 1,
                      }),
                      className: classes("text-button danger"),
                      onClick: domEvent(($event: Event) => {
                        changeItem(index);
                      }),
                    },
                    t("移除"),
                  ),
                ),
                element(
                  "div",
                  {
                    id: `${id}-${index}`,
                    className: classes("structured-body"),
                    style: Object.assign(
                      {},
                      {
                        display:
                          compactItem(item, index) || expanded.value.has(index)
                            ? undefined
                            : "none",
                      },
                    ),
                  },
                  element(ValueEditor, {
                    modelValue: item,
                    name: `${props.name}.${index}`,
                    label: `${label.value} ${index + 1}`,
                    depth: depth.value + 1,
                    sprite: props.sprite,
                    onUpdateModelValue: (($event) => {
                      changeItem(index, $event);
                    }) satisfies EventHandler<
                      typeof ValueEditor,
                      "onUpdateModelValue"
                    >,
                  }),
                ),
              ),
            ),
            element(
              "button",
              {
                type: "button",
                className: classes("add-button"),
                onClick: domEvent(($event: Event) => {
                  addItem();
                }),
              },
              t("＋ 添加{label}", { label: label.value }),
            ),
          )
        : props.modelValue !== null && typeof props.modelValue === "object"
          ? element(
              "div",
              {
                className: classes("object-fields", {
                  "compact-object": compactObject(props.modelValue, props.name),
                }),
              },
              renderList(object.value).map(([value, key]) =>
                element(ValueEditor, {
                  key: key,
                  modelValue: value,
                  name: `${props.name}.${key}`,
                  label: fieldLabels[key] || key,
                  depth: depth.value + 1,
                  sprite:
                    typeof object.value.svg_sprite === "string" &&
                    object.value.svg_sprite
                      ? object.value.svg_sprite
                      : props.sprite,
                  className: classes({
                    "value-number": typeof value === "number",
                  }),
                  onUpdateModelValue: (($event) => {
                    emit("update:modelValue", {
                      ...object.value,
                      [key]: $event,
                    });
                  }) satisfies EventHandler<
                    typeof ValueEditor,
                    "onUpdateModelValue"
                  >,
                }),
              ),
              element(
                "details",
                { className: classes("advanced-field") },
                element("summary", null, t("添加扩展字段")),
                element(
                  "div",
                  { className: classes("row") },
                  element("input", {
                    value: newKey.value ?? "",
                    "aria-label": t("扩展字段名称"),
                    placeholder: t("字段名称"),
                    onInput: domEvent(($event: Event) => {
                      newKey.value = ($event.target as HTMLInputElement).value;
                    }),
                  }),
                  element(
                    "button",
                    {
                      type: "button",
                      className: classes("secondary"),
                      onClick: domEvent(($event: Event) => {
                        addKey();
                      }),
                    },
                    t("添加"),
                  ),
                ),
              ),
            )
          : element(FormField, {
              modelValue: props.modelValue,
              name: props.name,
              label: String(label.value),
              sprite: props.sprite,
              onUpdateModelValue: (($event) => {
                emit("update:modelValue", $event);
              }) satisfies EventHandler<typeof FormField, "onUpdateModelValue">,
            });
  },
  {},
);
export default ValueEditor;
