import {
  translationLocation,
  type TranslationCapabilities,
  type TranslationResult,
} from "../../shared/translation";
import type { ArticleSummary, Json } from "../../shared/types";
import { api, errorMessage, session } from "../api";
import { type ContentLanguages } from "../content-model";
import { locale, t, type Message } from "../i18n";
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
      loadError = ref<Message>(""),
      translationError = ref<Message>(""),
      preparing = ref(false);
    const error = computed(() => translationError.value || loadError.value);
    const adding = ref(false),
      targetLanguage = ref("");
    const capabilities = ref<TranslationCapabilities>({ enabled: false });
    const contextActive = ref(true);
    const initialSession = session.value;
    const initialIdentity = initialSession?.identity.id;
    const initialMethod = initialSession?.identity.method;
    const initialCsrf = initialSession?.csrf;
    const initialExpires = initialSession?.expires;
    let alive = true,
      documentGeneration = 0,
      loadGeneration = 0,
      loadStarted = false,
      loadPending = false,
      pendingRefresh = false,
      mutationGeneration = 0,
      workingReported = false;
    type DocumentOwner = {
      generation: number;
      path: string;
      kind: Props["kind"];
    };
    type MutationOwner = DocumentOwner & { mutation: number };
    let mutationOwner: MutationOwner | undefined;
    let documentPath = props.path,
      documentKind = props.kind;
    function sessionCurrent() {
      return (
        contextActive.value &&
        session.value === initialSession &&
        session.value?.identity.id === initialIdentity &&
        session.value?.identity.method === initialMethod &&
        session.value?.csrf === initialCsrf &&
        session.value?.expires === initialExpires
      );
    }
    function documentOwner(): DocumentOwner {
      return {
        generation: documentGeneration,
        path: props.path,
        kind: props.kind,
      };
    }
    function documentCurrent(owner: DocumentOwner) {
      return (
        alive &&
        sessionCurrent() &&
        owner.generation === documentGeneration &&
        owner.path === props.path &&
        owner.kind === props.kind
      );
    }
    function mutationCurrent(owner: MutationOwner) {
      return mutationOwner === owner && documentCurrent(owner);
    }
    function releaseMutation(owner: MutationOwner) {
      if (!mutationCurrent(owner)) return;
      mutationOwner = undefined;
      const notify = workingReported;
      workingReported = false;
      preparing.value = false;
      // Clear ownership before notifying a synchronously updating parent.
      if (notify) emit("working", false);
    }
    function resetDocument() {
      items.value = [];
      languages.value = undefined;
      capabilities.value = { enabled: false };
      adding.value = false;
      targetLanguage.value = "";
      loadError.value = "";
      translationError.value = "";
    }
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
        !contextActive.value ||
        props.dirty ||
        props.busy ||
        !props.revision ||
        loading.value ||
        preparing.value ||
        !!error.value,
    );
    async function load(refresh = false) {
      if (!alive || !sessionCurrent()) return;
      const owner = documentOwner();
      const request = ++loadGeneration;
      const requestLocale = locale.value;
      const requestRevision = props.revision;
      const isCurrent = () =>
        request === loadGeneration &&
        documentCurrent(owner) &&
        requestLocale === locale.value &&
        requestRevision === props.revision;
      loadStarted = true;
      loadPending = true;
      // A replacement inherits the forced read until its entire group settles.
      pendingRefresh = pendingRefresh || refresh;
      loading.value = true;
      loadError.value = "";
      try {
        const [content, config, ai] = await Promise.all([
          api<ArticleSummary[]>("/content" + (pendingRefresh ? "?refresh=1" : "")),
          api<ContentLanguages>("/content-languages"),
          api<TranslationCapabilities>("/translation/config"),
        ]);
        if (!isCurrent()) return;
        items.value = content.filter((item) => item.kind === owner.kind);
        languages.value = config;
        capabilities.value = ai;
      } catch (e) {
        if (isCurrent()) loadError.value = errorMessage(e);
      } finally {
        if (isCurrent()) {
          loadPending = false;
          pendingRefresh = false;
          loading.value = false;
        }
      }
    }
    function retryLoad() {
      if (!alive || !sessionCurrent()) return;
      // Retry acknowledges a settled POST error, but never retries the POST.
      if (!mutationOwner) translationError.value = "";
      void load(true);
    }
    async function translate(language: string, ai = false) {
      if (!alive || !sessionCurrent() || blocked.value || !languages.value) return;
      const path = targetPath(language);
      if (items.value.some((item) => item.path === path)) {
        emit("open", path);
        return;
      }
      const owner: MutationOwner = {
        ...documentOwner(),
        mutation: ++mutationGeneration,
      };
      const revision = props.revision;
      mutationOwner = owner;
      preparing.value = true;
      translationError.value = "";
      workingReported = true;
      try {
        emit("working", true);
        // Parent notifications can synchronously replace the editing context.
        if (!mutationCurrent(owner)) return;
        const result = await api<TranslationResult>(
          ai ? "/translation" : "/translation/manual",
          "POST",
          { path: owner.path, revision, language },
        );
        if (!mutationCurrent(owner)) return;
        releaseMutation(owner);
        if (
          documentCurrent(owner) &&
          owner.mutation === mutationGeneration &&
          !mutationOwner
        )
          emit("open", result.path);
      } catch (e) {
        if (mutationCurrent(owner)) translationError.value = errorMessage(e);
      } finally {
        releaseMutation(owner);
      }
    }
    function invalidateDocument() {
      documentGeneration++;
      loadGeneration++;
      mutationGeneration++;
      loadPending = false;
      pendingRefresh = false;
      mutationOwner = undefined;
      const notify = workingReported;
      workingReported = false;
      preparing.value = false;
      resetDocument();
      loading.value = false;
      // Retire the old owner before the parent can install a new one.
      if (notify) emit("working", false);
    }
    watch(missingLanguages, (values) => {
      if (!values.includes(targetLanguage.value))
        targetLanguage.value = values[0] || "";
    });
    watch(
      [
        session,
        () => session.value?.identity.id,
        () => session.value?.identity.method,
        () => session.value?.csrf,
        () => session.value?.expires,
      ] as const,
      () => {
        if (!alive || !contextActive.value) return;
        // Never migrate an old editor to another session, even on A -> B -> A.
        // App normally unmounts it; otherwise it stays inert until remounted.
        contextActive.value = false;
        invalidateDocument();
      },
      { flush: "sync" },
    );
    watch(
      [
        () => props.path,
        () => props.kind,
        () => props.revision,
        locale,
      ] as const,
      (next, previous) => {
        if (!alive || !sessionCurrent()) return;
        if (next[0] !== documentPath || next[1] !== documentKind) {
          documentPath = next[0];
          documentKind = next[1];
          invalidateDocument();
          if (alive && sessionCurrent()) void load();
          return;
        }
        // Revision supersedes reads only; locale replaces only a pending group.
        if (next[2] !== previous[2] || (next[3] !== previous[3] && loadPending))
          void load();
      },
      { flush: "sync" },
    );
    onMounted(() => {
      if (!loadStarted) void load();
    });
    // Cleanup runs in reverse registration order. Notify directly, once, while
    // emit is still open; no watcher or late POST finally owns this release.
    onBeforeUnmount(() => {
      alive = false;
      documentGeneration++;
      loadGeneration++;
      mutationGeneration++;
      mutationOwner = undefined;
      const notify = workingReported;
      workingReported = false;
      if (notify) emit("working", false);
    });
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
                    retryLoad();
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
