import {
  translationLocation,
  type TranslationCapabilities,
  type TranslationResult,
} from "../../shared/translation";
import type { ArticleSummary, Json } from "../../shared/types";
import { api, errorMessage } from "../api";
import { type ContentLanguages } from "../content-model";
import { t, type Message } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  modelValue,
  renderList,
  type StudioComponent,
} from "../react-component";
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "../reactivity";
import LoadingState from "./LoadingState";

type Props = {
  path: string;
  kind: ArticleSummary["kind"];
  revision: string | null;
  dirty: boolean;
  busy: boolean;
};
type Events = {
  working: [value: boolean];
  open: [path: string, initial?: Record<string, Json>, initialBody?: string];
};
const LocalizedContentContext: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "LocalizedContentContext",
  (props, emit, expose) => {
    const items = ref<ArticleSummary[]>([]),
      languages = ref<ContentLanguages>(),
      loading = ref(true),
      error = ref<Message>(""),
      preparing = ref(false);
    const adding = ref(false),
      targetLanguage = ref("");
    const capabilities = ref<TranslationCapabilities>({ enabled: false });
    let alive = true;
    onBeforeUnmount(() => {
      alive = false;
    });
    const language = computed(() =>
      languages.value
        ? translationLocation(
            props.path,
            languages.value.defaultLanguage,
            languages.value,
          ).sourceLanguage
        : "",
    );
    function targetPath(language: string) {
      return languages.value
        ? translationLocation(props.path, language, languages.value).path
        : "";
    }
    function exists(language: string) {
      return items.value.some((item) => item.path === targetPath(language));
    }
    const hasMissingVersion = computed(() =>
      languages.value?.languages.some(
        (target) => target !== language.value && !exists(target),
      ),
    );
    const missingLanguages = computed(
      () =>
        languages.value?.languages.filter(
          (target) => target !== language.value && !exists(target),
        ) || [],
    );
    const blocked = computed(
      () =>
        props.dirty ||
        props.busy ||
        !props.revision ||
        loading.value ||
        preparing.value ||
        !!error.value,
    );
    async function load() {
      loading.value = true;
      error.value = "";
      try {
        const [content, config, ai] = await Promise.all([
          api<ArticleSummary[]>("/content"),
          api<ContentLanguages>("/content-languages"),
          api<TranslationCapabilities>("/translation/config"),
        ]);
        items.value = content.filter((item) => item.kind === props.kind);
        languages.value = config;
        capabilities.value = ai;
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
      }
    }
    async function translate(language: string, ai = false) {
      if (blocked.value || !languages.value) return;
      const path = targetPath(language);
      if (items.value.some((item) => item.path === path)) {
        emit("open", path);
        return;
      }
      preparing.value = true;
      error.value = "";
      try {
        const result = await api<TranslationResult>(
          ai ? "/translation" : "/translation/manual",
          "POST",
          { path: props.path, revision: props.revision, language },
        );
        if (alive) {
          preparing.value = false;
          emit("open", result.path);
        }
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        preparing.value = false;
      }
    }
    watch(missingLanguages, (values) => {
      if (!values.includes(targetLanguage.value))
        targetLanguage.value = values[0] || "";
    });
    watch(preparing, (value) => emit("working", value), { flush: "sync" });
    onMounted(load);
    watch(() => props.revision, load);
    return () =>
      element(
        "section",
        {
          "aria-label": t("语言版本"),
          className: classes("language-versions"),
        },
        loading.value
          ? element(LoadingState, { label: "正在读取内容…", compact: true })
          : element(
              "div",
              { className: classes("language-version-bar") },
              element("span", { className: classes("sr-only") }, t("语言版本")),
              element(
                "div",
                {
                  role: "tablist",
                  "aria-label": t("语言版本"),
                  className: classes("language-version-tabs"),
                },
                renderList(
                  languages.value?.languages.filter(
                    (value) => value === language.value || exists(value),
                  ),
                ).map((target) =>
                  element(
                    "button",
                    {
                      key: target,
                      role: "tab",
                      "aria-selected": target === language.value,
                      disabled: target !== language.value && blocked.value,
                      className: classes({ active: target === language.value }),
                      onClick: domEvent(($event: Event) => {
                        target !== language.value && translate(target);
                      }),
                    },
                    target,
                    target === language.value && props.dirty
                      ? element("span", { "aria-hidden": "true" }, " ·")
                      : null,
                  ),
                ),
              ),
              hasMissingVersion.value
                ? element(
                    "button",
                    {
                      disabled: blocked.value,
                      "aria-expanded": adding.value,
                      className: classes("text-button"),
                      onClick: domEvent(($event: Event) => {
                        adding.value = !adding.value;
                      }),
                    },
                    t("＋ 添加语言"),
                  )
                : null,
              props.dirty || !props.revision
                ? element(
                    "span",
                    { className: classes("muted small") },
                    t("保存后可添加或切换语言。"),
                  )
                : null,
            ),
        error.value
          ? element(
              "p",
              { role: "alert", className: classes("notice error") },
              t(error.value),
              " ",
              element(
                "button",
                {
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    load();
                  }),
                },
                t("重试"),
              ),
            )
          : null,
        adding.value && hasMissingVersion.value
          ? element(
              "div",
              { className: classes("language-version-create") },
              element(
                "div",
                { className: classes("row") },
                element(
                  "label",
                  { className: classes("field field-inline") },
                  element("span", null, t("目标语言")),
                  element(
                    "select",
                    {
                      value: targetLanguage.value ?? "",
                      disabled: blocked.value,
                      onChange: domEvent(($event: Event) => {
                        targetLanguage.value = modelValue(
                          $event.target as HTMLSelectElement,
                          targetLanguage.value,
                        );
                      }),
                    },
                    renderList(missingLanguages.value).map((target) =>
                      element("option", { key: target, value: target }, target),
                    ),
                  ),
                ),
                element(
                  "button",
                  {
                    disabled: blocked.value || !targetLanguage.value,
                    className: classes("secondary"),
                    onClick: domEvent(($event: Event) => {
                      translate(targetLanguage.value);
                    }),
                  },
                  t("创建译文草稿"),
                ),
                element(
                  "button",
                  {
                    disabled:
                      blocked.value ||
                      !capabilities.value.enabled ||
                      !targetLanguage.value,
                    className: classes("primary"),
                    onClick: domEvent(($event: Event) => {
                      translate(targetLanguage.value, true);
                    }),
                  },
                  t("AI 翻译为草稿"),
                ),
              ),
              preparing.value
                ? element(
                    "p",
                    { role: "status", className: classes("notice") },
                    t("正在生成译文，请稍候…"),
                  )
                : element(
                    "p",
                    { className: classes("muted small") },
                    t("手动译文会复制原文为草稿，请翻译后发布。"),
                  ),
              !capabilities.value.enabled
                ? element(
                    "details",
                    { className: classes("translation-setup") },
                    element("summary", null, t("AI 翻译未配置")),
                    element(
                      "p",
                      { className: classes("muted small") },
                      t(
                        "AI 翻译未配置。请在服务端设置 STUDIO_AI_BASE_URL、STUDIO_AI_MODEL 和 STUDIO_AI_API_KEY，然后重启。",
                      ),
                    ),
                  )
                : element(
                    "p",
                    { className: classes("muted small") },
                    t(
                      "生成时会将已保存的标题、摘要和正文发送给配置的 AI 服务。译文存为草稿，审核后才可发布。",
                    ),
                  ),
            )
          : null,
        languages.value?.languages.length === 1
          ? element(
              "p",
              { className: classes("muted small") },
              t("在站点配置中添加语言后，可在这里创建译文。"),
            )
          : null,
      );
  },
  {},
);
export default LocalizedContentContext;
