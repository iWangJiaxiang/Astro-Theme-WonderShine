import { translationLocation } from "../../shared/translation";
import type { ContentLanguages, Json } from "../../shared/types";
import { api, errorMessage, session } from "../api";
import { contentLabel, newThread } from "../content-model";
import { t, type Message } from "../i18n";
import {
  retainThreadDraft,
  retargetThreadDraft,
  type ThreadDraft as Draft,
} from "../thread-session";
import {
  classes,
  combineEvents,
  component,
  domEvent,
  domRef,
  element,
  modelValue,
  renderList,
  type EditorHandle,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { nextTick, onMounted, ref } from "../reactivity";
import DocumentEditor from "./DocumentEditor";
import Icon from "./Icon";
import LoadingState from "./LoadingState";

type Props = {};
type Events = { dirty: [value: boolean]; saved: [path: string] };
const ThreadComposer: StudioComponent<Props, Events> = component<Props, Events>(
  "ThreadComposer",
  (props, emit, expose) => {
    const languages = ref<ContentLanguages>(),
      document = ref<Draft>(),
      editor = ref<EditorHandle>();
    const working = ref(false);
    const dirty = ref(false),
      firstLanguage = ref(""),
      error = ref<Message>(""),
      host = ref<HTMLElement>();
    const storageKey = `studio-thread-session:${session.value?.identity.method}:${session.value?.identity.id}`;
    const draftsKey = `${storageKey}:unsaved`,
      drafts = ref<Draft[]>([]);
    function rememberDrafts() {
      try {
        localStorage.setItem(draftsKey, JSON.stringify(drafts.value));
      } catch {
        /* The current editor backup remains available. */
      }
    }
    function keepUnsaved() {
      if (!document.value?.initial) return;
      let snapshot = dirty.value ? editor.value?.draft() : undefined;
      if (!snapshot)
        try {
          const backup = JSON.parse(
            localStorage.getItem(
              `studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${document.value.path}`,
            ) || "null",
          );
          if (backup?.values && typeof backup.body === "string")
            snapshot = { initial: backup.values, initialBody: backup.body };
        } catch {
          /* Keep the existing draft pointer when a backup is unreadable. */
        }
      if (snapshot) {
        drafts.value = retainThreadDraft(drafts.value, {
          path: document.value.path,
          ...snapshot,
        });
        rememberDrafts();
      }
    }
    function remember() {
      try {
        localStorage.setItem(storageKey, JSON.stringify(document.value));
      } catch {
        /* Editor still offers draft download. */
      }
    }
    function changed(value: boolean) {
      dirty.value = value;
      emit("dirty", value);
    }
    function flush() {
      editor.value?.flush();
    }
    function canLeave() {
      if (working.value) return false;
      flush();
      return (
        !dirty.value ||
        confirm(
          t(
            "还有未保存的更改，确定离开吗？文章本地草稿会保留，配置表单不会自动保存。",
          ),
        )
      );
    }
    async function open(
      path: string,
      initial?: Record<string, Json>,
      initialBody?: string,
    ) {
      if (!canLeave()) return;
      keepUnsaved();
      if (languages.value)
        firstLanguage.value = translationLocation(
          path,
          languages.value.defaultLanguage,
          languages.value,
        ).sourceLanguage;
      document.value = { path, initial, initialBody };
      remember();
      await nextTick();
      host.value?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    function create() {
      if (!languages.value || !canLeave()) return;
      keepUnsaved();
      document.value = newThread(
        firstLanguage.value || languages.value.defaultLanguage,
        languages.value.defaultLanguage,
      );
      remember();
    }
    function changeFirstLanguage() {
      if (!languages.value || !document.value?.initial) return;
      if (!dirty.value) keepUnsaved();
      const snapshot = editor.value?.draft();
      const path = translationLocation(
        document.value.path,
        firstLanguage.value,
        languages.value,
      ).path;
      document.value = snapshot
        ? retargetThreadDraft(path, snapshot, dirty.value)
        : { ...document.value, path };
      remember();
    }
    function saved(path: string) {
      drafts.value = drafts.value.filter((item) => item.path !== path);
      rememberDrafts();
      if (document.value?.path === path) {
        document.value = { path };
        remember();
      }
      emit("saved", path);
    }
    function forget(path: string) {
      drafts.value = drafts.value.filter((item) => item.path !== path);
      rememberDrafts();
      try {
        localStorage.removeItem(
          `studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${path}`,
        );
      } catch {
        /* Optional storage. */
      }
      if (document.value?.path !== path) return;
      // Suppress the old editor's unmount flush before replacing its session pointer.
      editor.value?.forget();
      changed(false);
      document.value = languages.value
        ? newThread(
            firstLanguage.value || languages.value.defaultLanguage,
            languages.value.defaultLanguage,
          )
        : undefined;
      if (document.value) remember();
      else
        try {
          localStorage.removeItem(storageKey);
        } catch {
          /* Optional storage. */
        }
    }
    function deleted(path: string) {
      forget(path);
      emit("saved", "");
    }
    async function load() {
      error.value = "";
      try {
        languages.value = await api<ContentLanguages>("/content-languages");
        firstLanguage.value = languages.value.defaultLanguage;
        try {
          const pending = JSON.parse(localStorage.getItem(draftsKey) || "[]");
          if (Array.isArray(pending))
            drafts.value = pending.filter(
              (item) => item?.initial && typeof item.path === "string",
            );
          const stored = JSON.parse(
            localStorage.getItem(storageKey) || "null",
          ) as Draft | null;
          if (
            stored &&
            /^content\/threads\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/index(?:\.[A-Za-z0-9-]+)?\.md$/.test(
              stored.path,
            )
          ) {
            firstLanguage.value = translationLocation(
              stored.path,
              languages.value.defaultLanguage,
              languages.value,
            ).sourceLanguage;
            // A previous successful save may have happened before the browser recorded its response.
            const summaries = await api<{ path: string }[]>("/content");
            document.value = summaries.some((item) => item.path === stored.path)
              ? { path: stored.path }
              : stored.initial
                ? stored
                : undefined;
          }
        } catch {
          /* Start a new session if a stored pointer is unavailable. */
        }
        if (!document.value)
          document.value = newThread(
            firstLanguage.value,
            languages.value.defaultLanguage,
          );
        remember();
      } catch (e) {
        error.value = errorMessage(e);
      }
    }
    onMounted(load);
    expose({ flush, open, forget, isBusy: () => working.value });
    return () =>
      element(
        "section",
        {
          ref: domRef(host),
          "aria-label": t("写动态"),
          className: classes("card thread-composer"),
        },
        element(
          "div",
          { className: classes("composer-heading") },
          element(
            "div",
            null,
            element(
              "span",
              { className: classes("composer-mark") },
              element(Icon, { name: "pen", size: 19 }),
            ),
            element("h2", null, t("写动态")),
          ),
          element(
            "div",
            { className: classes("row") },
            document.value?.initial && languages.value
              ? element(
                  "label",
                  { className: classes("composer-initial-language") },
                  element(Icon, { name: "globe", size: 15 }),
                  element(
                    "span",
                    { className: classes("sr-only") },
                    t("内容语言"),
                  ),
                  element(
                    "select",
                    {
                      value: firstLanguage.value ?? "",
                      disabled: working.value,
                      onChange: combineEvents(
                        domEvent(($event: Event) => {
                          firstLanguage.value = modelValue(
                            $event.target as HTMLSelectElement,
                            firstLanguage.value,
                          );
                        }),
                        domEvent(($event: Event) => {
                          changeFirstLanguage();
                        }),
                      ),
                    },
                    renderList(languages.value.languages).map((language) =>
                      element(
                        "option",
                        { key: language, value: language },
                        language,
                      ),
                    ),
                  ),
                )
              : null,
            document.value && !document.value.initial
              ? element(
                  "button",
                  {
                    disabled: working.value,
                    className: classes("text-button"),
                    onClick: domEvent(($event: Event) => {
                      create();
                    }),
                  },
                  t("＋ 新动态"),
                )
              : null,
          ),
        ),
        drafts.value.some((item) => item.path !== document.value?.path)
          ? element(
              "details",
              { className: classes("composer-unsaved") },
              element(
                "summary",
                null,
                t("未保存的动态"),
                " · ",
                drafts.value.filter(
                  (item) => item.path !== document.value?.path,
                ).length,
              ),
              element(
                "div",
                { className: classes("row") },
                renderList(
                  drafts.value.filter(
                    (item) => item.path !== document.value?.path,
                  ),
                ).map((draft) =>
                  element(
                    "button",
                    {
                      key: draft.path,
                      className: classes("secondary"),
                      onClick: domEvent(($event: Event) => {
                        open(draft.path, draft.initial, draft.initialBody);
                      }),
                    },
                    contentLabel(
                      draft.initialBody || "",
                      draft.initial?.title,
                    ) || t("无标题动态"),
                  ),
                ),
              ),
            )
          : null,
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
        document.value
          ? element(DocumentEditor, {
              ref: domRef(editor),
              key: document.value.path,
              path: document.value.path,
              initial: document.value.initial,
              initialBody: document.value.initialBody,
              embedded: true,
              onWorking: (($event) => {
                working.value = $event;
              }) satisfies EventHandler<typeof DocumentEditor, "onWorking">,
              onDirty: changed satisfies EventHandler<
                typeof DocumentEditor,
                "onDirty"
              >,
              onSaved: saved satisfies EventHandler<
                typeof DocumentEditor,
                "onSaved"
              >,
              onOpen: open satisfies EventHandler<
                typeof DocumentEditor,
                "onOpen"
              >,
              onDeleted: deleted satisfies EventHandler<
                typeof DocumentEditor,
                "onDeleted"
              >,
            })
          : !error.value
            ? element(LoadingState, { label: "正在载入文稿…", compact: true })
            : null,
      );
  },
  {},
);
export default ThreadComposer;
