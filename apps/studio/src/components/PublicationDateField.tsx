import { dateParts } from "../../shared/form-fields";
import type { Json } from "../../shared/types";
import { t } from "../i18n";
import {
  publicationDateDraft,
  publicationDateValue,
} from "../publication-date";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  portal,
  type StudioComponent,
} from "../react-component";
import { computed, nextTick, onBeforeUnmount, ref, useId } from "../reactivity";
import Icon from "./Icon";

type Props = { modelValue: Json | undefined; disabled?: boolean };
type Events = { "update:modelValue": [value: string] };
const PublicationDateField: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "PublicationDateField",
  (props, emit, expose) => {
    const id = useId(),
      dialog = ref<HTMLDialogElement>(),
      trigger = ref<HTMLButtonElement>();
    const opened = ref(false),
      pending = ref(publicationDateDraft(""));
    const parts = computed(() => dateParts(String(props.modelValue || "")));
    const pendingValue = computed(() => publicationDateValue(pending.value));
    const zone = (value?: string) =>
      value && /^[zZ]$/.test(value) ? "UTC" : value || "";
    async function open() {
      if (props.disabled) return;
      pending.value = publicationDateDraft(String(props.modelValue || ""));
      opened.value = true;
      await nextTick();
      dialog.value?.showModal();
    }
    function close() {
      dialog.value?.close();
      opened.value = false;
      trigger.value?.focus();
    }
    function apply() {
      if (props.disabled || !pendingValue.value) return;
      emit("update:modelValue", pendingValue.value);
      close();
    }
    onBeforeUnmount(() => dialog.value?.close());
    return () =>
      element(
        "div",
        { className: classes("thread-date-field") },
        element("span", { id: `${id}-label` }, t("发布时间")),
        element(
          "button",
          {
            ref: domRef(trigger),
            type: "button",
            disabled: props.disabled,
            "aria-label": t("修改发布时间"),
            "aria-describedby": `${id}-value`,
            "aria-haspopup": "dialog",
            "aria-expanded": opened.value,
            className: classes("thread-date-trigger", {
              "date-missing": !parts.value,
            }),
            onClick: domEvent(($event: Event) => {
              open();
            }),
          },
          parts.value
            ? element(
                "span",
                { id: `${id}-value`, className: classes("thread-date-value") },
                parts.value.date.replaceAll("-", "/"),
                parts.value.time
                  ? element(
                      "small",
                      null,
                      parts.value.time.slice(0, 5),
                      " ",
                      element("span", null, zone(parts.value.zone)),
                    )
                  : null,
              )
            : element("span", { id: `${id}-value` }, t("设置发布时间")),
          element(
            "span",
            { className: classes("thread-date-edit") },
            element(Icon, { name: "pen", size: 13 }),
            t("修改"),
          ),
        ),
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
                    className: classes("publication-date-dialog"),
                    onCancel: domEvent(($event: Event) => {
                      $event.preventDefault();
                      close();
                    }),
                    onClick: domEvent(($event: Event) => {
                      $event.target === dialog.value && close();
                    }),
                  },
                  element(
                    "form",
                    {
                      onSubmit: domEvent(($event: Event) => {
                        $event.preventDefault();
                        apply();
                      }),
                    },
                    element(
                      "div",
                      { className: classes("card-heading") },
                      element("h2", { id: `${id}-title` }, t("发布时间")),
                      element(
                        "button",
                        {
                          type: "button",
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
                      { className: classes("publication-date-fields") },
                      element(
                        "label",
                        { className: classes("field field-inline") },
                        element("span", null, t("日期")),
                        element("input", {
                          value: pending.value.date ?? "",
                          type: "date",
                          required: true,
                          autoFocus: true,
                          "aria-label": t("发布日期"),
                          onInput: domEvent(($event: Event) => {
                            pending.value.date = (
                              $event.target as HTMLInputElement
                            ).value;
                          }),
                        }),
                      ),
                      element(
                        "label",
                        { className: classes("field field-inline") },
                        element("span", null, t("时间")),
                        element("input", {
                          type: "time",
                          required: true,
                          step: "0.001",
                          "aria-label": t("发布时间"),
                          value: pending.value.time.slice(0, 12),
                          onInput: domEvent(($event: Event) => {
                            pending.value.time = (
                              $event.target as HTMLInputElement
                            ).value;
                          }),
                        }),
                      ),
                      !pendingValue.value
                        ? element(
                            "p",
                            {
                              role: "alert",
                              className: classes("danger small"),
                            },
                            t("请填写有效的日期和时间"),
                          )
                        : null,
                      element(
                        "details",
                        { className: classes("publication-date-help") },
                        element(
                          "summary",
                          null,
                          t("时间与时区说明"),
                          element("span", null, zone(pending.value.zone)),
                        ),
                        element(
                          "p",
                          null,
                          t(
                            "修改日期时保留原时区与时间精度，修改时间时保留原时区。此设置不会自动定时发布。",
                          ),
                        ),
                        !parts.value?.zone
                          ? element(
                              "p",
                              null,
                              t("旧内容未指定时区，应用后使用 UTC。"),
                            )
                          : null,
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("selection-footer") },
                      element(
                        "button",
                        {
                          type: "submit",
                          disabled: props.disabled || !pendingValue.value,
                          className: classes("primary"),
                        },
                        t("应用时间"),
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
export default PublicationDateField;
