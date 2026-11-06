import type { Choice } from "../../shared/choices";
import type { Json } from "../../shared/types";
import { errorMessage } from "../api";
import { t, type Message } from "../i18n";
import { createBusinessModal } from "../modal-layer";
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
import {
  computed,
  onBeforeUnmount,
  ref,
  useId,
  watch,
} from "../reactivity";
import ChoicePreview from "./ChoicePreview";
import Icon from "./Icon";

type Props = {
  modelValue: Json | undefined;
  options: Choice[];
  name: string;
  label: string;
  multiple?: boolean;
  disabled?: boolean;
  hint?: string;
  preview?: string;
  compact?: boolean;
  icon?: string;
  createOption?: (title: string) => Promise<Choice>;
  createLabel?: string;
  createHint?: string;
  createdHint?: string;
  searchPlaceholder?: string;
};
type Events = { "update:modelValue": [value: string | string[]] };
const SelectionField: StudioComponent<Props, Events> = component<Props, Events>(
  "SelectionField",
  (props, emit, expose) => {
    const id = useId(),
      dialog = ref<HTMLDialogElement>(),
      trigger = ref<HTMLButtonElement>();
    const opened = ref(false),
      search = ref(""),
      pending = ref<string[]>([]),
      known = ref<string[]>([]);
    const creating = ref(false),
      createError = ref<Message>(""),
      created = ref(false),
      addedOptions = ref<Choice[]>([]);
    let alive = true;
    const normalized = (value: string) =>
      value.trim().replace(/\s+/gu, " ").normalize("NFKC").toLowerCase();
    const query = computed(() => search.value.trim().replace(/\s+/gu, " "));
    const selected = computed(() =>
      props.multiple
        ? Array.isArray(props.modelValue)
          ? props.modelValue.filter(
              (v): v is string => typeof v === "string" && !!v,
            )
          : []
        : [String(props.modelValue ?? "")],
    );
    watch(
      selected,
      (values) => {
        known.value = [...new Set([...known.value, ...values.filter(Boolean)])];
      },
      { immediate: true },
    );
    const options = computed<Choice[]>(() => [
      ...props.options,
      ...addedOptions.value.filter(
        (option) => !props.options.some((item) => item.value === option.value),
      ),
      ...known.value
        .filter(
          (value) =>
            ![...props.options, ...addedOptions.value].some(
              (option) => option.value === value,
            ),
        )
        .map((value) => ({ value, label: t("{value}（自定义）", { value }) })),
    ]);
    const filtered = computed(() =>
      options.value.filter((option) =>
        normalized(
          `${option.label} ${option.value} ${(option.searchTerms || []).join(" ")}`,
        ).includes(normalized(search.value)),
      ),
    );
    const canCreate = computed(
      () =>
        !!props.createOption &&
        !!query.value &&
        !options.value.some((option) =>
          [option.label, ...(option.searchTerms || [])].some(
            (term) => normalized(term) === normalized(query.value),
          ),
        ),
    );
    watch(search, () => {
      createError.value = "";
      created.value = false;
    });
    const labels = computed(
      () =>
        new Map(options.value.map((option) => [option.value, option.label])),
    );
    const compactValues = computed(() =>
      selected.value.filter(
        (value) => !!value || (!props.multiple && labels.value.has(value)),
      ),
    );
    function toggle(values: string[], value: string): string[] {
      return props.multiple
        ? values.includes(value)
          ? values.filter((item) => item !== value)
          : [...values, value]
        : [value];
    }
    function publish(values: string[]) {
      if (!props.disabled)
        emit("update:modelValue", props.multiple ? values : (values[0] ?? ""));
    }
    const modal = createBusinessModal(() => dialog.value, () => opened.value && !props.disabled);
    function open() {
      if (props.disabled) return;
      pending.value = [...selected.value];
      search.value = "";
      createError.value = "";
      created.value = false;
      opened.value = true;
      modal.open();
    }
    function close() {
      if (creating.value) return;
      modal.close();
      opened.value = false;
      trigger.value?.focus();
    }
    function confirm() {
      if (creating.value) return;
      publish(pending.value);
      close();
    }
    async function create() {
      if (
        !props.createOption ||
        !canCreate.value ||
        creating.value ||
        props.disabled
      )
        return;
      creating.value = true;
      createError.value = "";
      created.value = false;
      try {
        const option = await props.createOption(query.value);
        if (!alive) return;
        addedOptions.value = [
          ...addedOptions.value.filter((item) => item.value !== option.value),
          option,
        ];
        pending.value = props.multiple
          ? [...new Set([...pending.value, option.value])]
          : [option.value];
        created.value = true;
      } catch (error) {
        if (alive) createError.value = errorMessage(error);
      } finally {
        creating.value = false;
      }
    }
    watch(
      () => props.disabled,
      (disabled) => {
        if (disabled && opened.value) close();
      },
    );
    onBeforeUnmount(() => {
      alive = false;
      modal.dispose();
    });
    return () =>
      element(
        "div",
        {
          "data-field": props.name,
          className: classes("field field-inline choice-field", {
            "choice-multiple": props.multiple,
            "choice-preview-field": props.preview,
            "choice-compact": props.compact,
          }),
        },
        element(
          "span",
          {
            id: `${id}-label`,
            className: classes({ "sr-only": props.compact }),
          },
          props.label,
        ),
        !props.compact && !props.createOption && options.value.length <= 5
          ? element(
              "fieldset",
              {
                disabled: props.disabled,
                "aria-labelledby": `${id}-label`,
                className: classes("choice-options"),
              },
              renderList(options.value).map((option) =>
                element(
                  "label",
                  {
                    key: option.value,
                    className: classes("choice-tile", {
                      selected: selected.value.includes(option.value),
                    }),
                  },
                  element("input", {
                    type: props.multiple ? "checkbox" : "radio",
                    name: props.name,
                    value: option.value,
                    checked: selected.value.includes(option.value),
                    onChange: domEvent(($event: Event) => {
                      publish(toggle(selected.value, option.value));
                    }),
                  }),
                  element(ChoicePreview, {
                    value: option.value,
                    kind: props.preview,
                  }),
                  element("span", null, option.label),
                ),
              ),
              !options.value.length
                ? element(
                    "small",
                    { className: classes("muted") },
                    t("暂无可选项，请先添加关联内容。"),
                  )
                : null,
            )
          : element(
              "button",
              {
                ref: domRef(trigger),
                type: "button",
                name: props.name,
                disabled: props.disabled,
                "aria-haspopup": "dialog",
                "aria-expanded": opened.value,
                "aria-labelledby":
                  props.compact && !compactValues.value.length
                    ? `${id}-label`
                    : `${id}-label ${id}-value`,
                title:
                  props.compact && compactValues.value.length
                    ? compactValues.value
                        .map((value) => labels.value.get(value) || value)
                        .join(" · ")
                    : undefined,
                className: classes("secondary choice-trigger"),
                onClick: domEvent(($event: Event) => {
                  open();
                }),
              },
              !props.multiple
                ? element(ChoicePreview, {
                    value: selected.value[0] || "",
                    kind: props.preview,
                  })
                : null,
              props.compact
                ? element(
                    Fragment,
                    null,
                    props.icon
                      ? element(Icon, { name: props.icon, size: 16 })
                      : null,
                    element(
                      "span",
                      { id: `${id}-value` },
                      compactValues.value.length
                        ? compactValues.value
                            .map((value) => labels.value.get(value) || value)
                            .join(" · ")
                        : props.label,
                    ),
                    selected.value.filter(Boolean).length
                      ? element(
                          "span",
                          { className: classes("choice-count") },
                          selected.value.filter(Boolean).length,
                        )
                      : null,
                  )
                : element(
                    Fragment,
                    null,
                    element(
                      "span",
                      { id: `${id}-value` },
                      props.multiple
                        ? t("选择{p0}{p1}", {
                            p0: props.label,
                            p1: selected.value.length
                              ? t("（已选 {p0} 项）", {
                                  p0: selected.value.length,
                                })
                              : "",
                          })
                        : labels.value.get(selected.value[0]) || t("请选择…"),
                    ),
                    element("span", { "aria-hidden": "true" }, "⌄"),
                  ),
            ),
        !props.compact && props.multiple && selected.value.length
          ? element(
              "div",
              {
                "aria-label": t("已选{p0}", { p0: props.label }),
                className: classes("selected-choices"),
              },
              renderList(selected.value).map((value, index) =>
                element(
                  "button",
                  {
                    key: `${value}-${index}`,
                    type: "button",
                    disabled: props.disabled,
                    "aria-label": t("移除{p0}：{p1}", {
                      p0: props.label,
                      p1: labels.value.get(value) || value,
                    }),
                    onClick: domEvent(($event: Event) => {
                      publish(selected.value.filter((_, i) => i !== index));
                    }),
                  },
                  labels.value.get(value) || value,
                  " ",
                  element("span", { "aria-hidden": "true" }, "×"),
                ),
              ),
            )
          : null,
        props.hint
          ? element("small", { className: classes("muted") }, props.hint)
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
                    "aria-busy": creating.value,
                    className: classes("selection-dialog", {
                      "selection-visual": props.preview,
                      "selection-creatable": props.createOption,
                    }),
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
                    { className: classes("selection-panel selection-field-panel") },
                    element(
                      "div",
                      { className: classes("card-heading") },
                      element("h2", { id: `${id}-title` }, props.label),
                      element(
                        "button",
                        {
                          type: "button",
                          disabled: creating.value,
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            close();
                          }),
                        },
                        t("取消"),
                      ),
                    ),
                    element(
                      "label",
                      { className: classes("field selection-search") },
                      element("span", null, t("搜索选项")),
                      element("input", {
                        value: search.value ?? "",
                        type: "search",
                        disabled: creating.value,
                        autoFocus: true,
                        placeholder:
                          props.searchPlaceholder || t("输入名称搜索…"),
                        onInput: domEvent(($event: Event) => {
                          search.value = (
                            $event.target as HTMLInputElement
                          ).value;
                        }),
                        onKeyDown: domEvent(($event: Event) => {
                          if (($event as KeyboardEvent).key !== "Enter") return;
                          $event.preventDefault();
                        }),
                      }),
                    ),
                    props.createOption
                      ? element(
                          "div",
                          { className: classes("selection-create") },
                          canCreate.value || creating.value
                            ? element(
                                "button",
                                {
                                  type: "button",
                                  disabled: creating.value || props.disabled,
                                  className: classes("selection-create-action"),
                                  onClick: domEvent(($event: Event) => {
                                    create();
                                  }),
                                },
                                element(Icon, { name: "plus", size: 17 }),
                                element(
                                  "span",
                                  null,
                                  creating.value
                                    ? t("正在创建…")
                                    : t(
                                        props.createLabel || "创建「{title}」",
                                        { title: query.value },
                                      ),
                                ),
                              )
                            : null,
                          createError.value
                            ? element(
                                "p",
                                {
                                  role: "alert",
                                  className: classes("notice error"),
                                },
                                t(createError.value),
                              )
                            : created.value && props.createdHint
                              ? element(
                                  "p",
                                  {
                                    role: "status",
                                    className: classes("muted small"),
                                  },
                                  props.createdHint,
                                )
                              : props.createHint
                                ? element(
                                    "p",
                                    { className: classes("muted small") },
                                    props.createHint,
                                  )
                                : null,
                        )
                      : null,
                    element(
                      "div",
                      { className: classes("selection-results") },
                      element(
                        "fieldset",
                        {
                          disabled: creating.value,
                          "aria-label": props.label,
                          className: classes("selection-result-options"),
                        },
                        renderList(filtered.value).map((option) =>
                          element(
                            "label",
                            {
                              key: option.value,
                              className: classes("choice-tile", {
                                selected: pending.value.includes(option.value),
                              }),
                            },
                            element("input", {
                              type: props.multiple ? "checkbox" : "radio",
                              name: `${props.name}-dialog`,
                              value: option.value,
                              checked: pending.value.includes(option.value),
                              onChange: domEvent(($event: Event) => {
                                pending.value = toggle(
                                  pending.value,
                                  option.value,
                                );
                              }),
                            }),
                            element(ChoicePreview, {
                              value: option.value,
                              kind: props.preview,
                            }),
                            element("span", null, option.label),
                          ),
                        ),
                        !filtered.value.length
                          ? element(
                              "p",
                              { className: classes("muted") },
                              t(
                                props.createOption
                                  ? query.value
                                    ? "没有匹配的话题，可以直接创建。"
                                    : "暂无话题，输入名称即可创建。"
                                  : options.value.length
                                    ? "没有匹配的选项"
                                    : "暂无可选项，请先添加关联内容。",
                              ),
                            )
                          : null,
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("selection-footer") },
                      element(
                        "small",
                        { className: classes("muted") },
                        props.multiple
                          ? t("已选 {p0} 项", { p0: pending.value.length })
                          : t("单选"),
                        " · ",
                        t("共 {count} 项", { count: options.value.length }),
                      ),
                      element(
                        "button",
                        {
                          type: "button",
                          disabled:
                            creating.value ||
                            props.disabled ||
                            (!props.multiple &&
                              !options.value.some(
                                (option) => option.value === pending.value[0],
                              )),
                          className: classes("primary"),
                          onClick: domEvent(($event: Event) => {
                            confirm();
                          }),
                        },
                        t("确认选择"),
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
export default SelectionField;
