import SaveButton from "./SaveButton";
import { createDraftBackup } from "../draft-backup";
import { createRichEditorSync } from "../rich-editor-sync";
import { saveContext } from "../save-preferences";
import type { SaveMode } from "../../shared/save";
import { prepareEditorIcons } from "../editor-assets";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type Vditor from "vditor";
import {
  stringValues,
  taxonomyChoices,
  type Choice,
} from "../../shared/choices";
import {
  markdownImage,
  mediaURL,
  storedMediaPath,
  type MediaItem,
} from "../../shared/media";
import { childLayoutChoices, pageProfile } from "../../shared/page-settings";
import { documentFields } from "../../shared/settings";
import { translationLocation } from "../../shared/translation";
import type {
  Article,
  ArticleSummary,
  Json,
  SaveResult,
  Settings,
} from "../../shared/types";
import { api, errorMessage, session } from "../api";
import {
  canAutosave,
  readAutosavePreference,
  writeAutosavePreference,
} from "../autosave";
import {
  contentLabel,
  topicOptions,
  type ContentLanguages,
} from "../content-model";
import { locale, t, translateOptions, type Message } from "../i18n";
import { richEditorBody, unsavedThreadChanged } from "../thread-session";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  modelValue,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "../reactivity";
import { createOrFindTopic } from "../topic-selection";
import AiAssistant from "./AiAssistant";
import ArticleReferences from "./ArticleReferences";
import ChoiceSelect from "./ChoiceSelect";
import DeleteContentDialog from "./DeleteContentDialog";
import FormField from "./FormField";
import Icon from "./Icon";
import LoadingState from "./LoadingState";
import LocalizedContentContext from "./LocalizedContentContext";
import MediaPicker from "./MediaPicker";
import PageSettings from "./PageSettings";
import PublicationDateField from "./PublicationDateField";
import SelectionField from "./SelectionField";

type Props = {
  path: string;
  initial?: Record<string, Json>;
  initialBody?: string;
  embedded?: boolean;
  backLabel?: string;
};
type Events = {
  dirty: [value: boolean];
  working: [value: boolean];
  back: [];
  deleted: [path: string];
  saved: [path: string];
  open: [path: string, initial?: Record<string, Json>, initialBody?: string];
};
const DocumentEditor: StudioComponent<Props, Events> = component<Props, Events>(
  "DocumentEditor",
  (props, emit, expose) => {
    const body = ref(""),
      values = ref<Record<string, Json>>({}),
      baseline = ref<Record<string, Json>>({}),
      originalBody = ref("");
    const revision = ref<string | null>(null),
      loading = ref(true),
      busy = ref(false),
      error = ref<Message>(""),
      message = ref<Message>("");
    const mode = ref<"source" | "rich" | "preview">("source"),
      editorElement = ref<HTMLDivElement>(),
      recovery = ref(false),
      ready = ref(false);
    const imagePicker = ref(false),
      sourceElement = ref<HTMLTextAreaElement>();
    const deleteDialog = ref(false);
    const aiDialog = ref<"summary" | "cover">(),
      aiWorking = ref(false),
      aiSource = ref("");
    const autosaving = ref(false);
    const autosaveSeconds = ref(readAutosavePreference()),
      autosavePaused = ref(false),
      autosaveLast = ref("");
    let autosaveTimer: ReturnType<typeof setInterval> | undefined;
    const owner = session.value?.identity.id;
    const saveMode = ref<SaveMode>(saveContext.value.defaultMode);
    const branchPending = ref(false), savedBranch = ref("");
    const saveAction = (publish = false) => element(SaveButton, {
      mode: saveMode.value,
      onModeChange: (value: SaveMode) => { saveMode.value = value; },
      busy: busy.value,
      disabled: !dirty.value && !branchPending.value && saveMode.value !== "branch" && (!publish || values.value.draft === false),
      label: publish ? t(saveMode.value === "branch" ? "分支保存 · 可发布" : saveMode.value === "remote" ? "远端保存 · 可发布" : "本地保存 · 可发布") : undefined,
      onSave: () => { if (publish) void saveLocalized(false); else void save(); },
    });
    function openAi(kind: "summary" | "cover") {
      flush();
      aiSource.value =
        kind === "summary"
          ? body.value
          : String(values.value.description || "");
      aiDialog.value = kind;
    }
    function applyAiCover(field: string, value: string) {
      values.value[field] = value;
      if (field === "extra.global_cover") values.value["extra.cover"] = "";
    }
    async function autosave() {
      flush();
      if (
        !canAutosave({
          ready: ready.value,
          dirty: dirty.value,
          busy:
            busy.value ||
            translating.value ||
            creatingTopic.value ||
            aiWorking.value,
          blocked:
            forgotten ||
            autosavePaused.value ||
            recovery.value ||
            !!aiDialog.value ||
            imagePicker.value ||
            deleteDialog.value ||
            settingsDirty.value ||
            aiEditPrompt.value,
          authenticated: !!session.value && session.value.identity.id === owner,
        })
      )
        return;
      const draft = values.value.draft;
      if (!revision.value) values.value.draft = true;
      autosaving.value = true;
      try {
        if (await save() && !branchPending.value)
          autosaveLast.value = new Date().toLocaleTimeString(locale.value, {
            hour: "2-digit",
            minute: "2-digit",
          });
        else {
          if (!revision.value) values.value.draft = draft;
          autosavePaused.value = true;
        }
      } finally {
        autosaving.value = false;
      }
    }
    function scheduleAutosave() {
      if (autosaveTimer) clearInterval(autosaveTimer);
      autosaveTimer = autosaveSeconds.value
        ? setInterval(() => {
            void autosave();
          }, autosaveSeconds.value * 1000)
        : undefined;
    }
    watch(autosaveSeconds, (value) => {
      writeAutosavePreference(value);
      autosavePaused.value = false;
      scheduleAutosave();
    });
    onMounted(scheduleAutosave);
    onBeforeUnmount(() => {
      if (autosaveTimer) clearInterval(autosaveTimer);
    });
    let forgotten = false;
    let imageCursor = { start: 0, end: 0 };
    function chooseImage() {
      flush();
      imageCursor = {
        start: sourceElement.value?.selectionStart ?? body.value.length,
        end: sourceElement.value?.selectionEnd ?? body.value.length,
      };
      imagePicker.value = true;
    }
    async function insertImage(item: MediaItem, value: string) {
      const snippet = "\n" + markdownImage(item, value) + "\n";
      body.value =
        body.value.slice(0, imageCursor.start) +
        snippet +
        body.value.slice(imageCursor.end);
      imagePicker.value = false;
      await nextTick();
      sourceElement.value?.focus();
      sourceElement.value?.setSelectionRange(
        imageCursor.start + snippet.length,
        imageCursor.start + snippet.length,
      );
    }
    const choices = ref<Record<string, Choice[]>>({}),
      choicesLoading = ref(true),
      choicesError = ref<Message>("");
    const isThread = props.path.startsWith("content/threads/");
    const isTopic = props.path.startsWith("content/topics/");
    const isLocalized = isThread || isTopic;
    const supportsTranslation =
      /^content\/(articles|pages|collections|threads|topics)\//.test(props.path);
    const threadAdvanced = ref(false),
      translating = ref(false),
      creatingTopic = ref(false);
    watch(
      [busy, translating, creatingTopic, aiWorking],
      ([saving, generating, creating, assisting]) =>
        emit("working", saving || generating || creating || assisting),
      { flush: "sync" },
    );
    const isCollection = props.path.startsWith("content/collections/");
    const isSection = /\/_index(?:\.[^.]+)?\.md$/.test(props.path);
    const supportsTopics =
      isThread ||
      props.path.startsWith("content/articles/") ||
      (isCollection && !isSection);
    const topicItems = ref<ArticleSummary[]>([]),
      documentLanguage = ref("");
    function topicChoice(item: ArticleSummary): Choice {
      return {
        value: item.id!,
        label: [
          item.title || item.id,
          item.lang,
          item.lang !== documentLanguage.value
            ? t("缺少 {language} 译文", { language: documentLanguage.value })
            : "",
          item.draft ? t("草稿") : "",
        ]
          .filter(Boolean)
          .join(" · "),
        searchTerms: topicItems.value
          .filter(
            (topic) =>
              topic.kind === "topic" && topic.id === item.id && !topic.error,
          )
          .map((topic) => topic.title),
      };
    }
    const topicChoices = computed(() =>
      topicOptions(topicItems.value, documentLanguage.value).map(topicChoice),
    );
    async function createTopic(title: string): Promise<Choice> {
      creatingTopic.value = true;
      try {
        const result = await createOrFindTopic(title, documentLanguage.value, {
          list: () => api<ArticleSummary[]>("/content?refresh=1"),
          languages: () => api<ContentLanguages>("/content-languages"),
          save: (input) => api<SaveResult>("/document", "PUT", input),
        });
        if (alive) topicItems.value = result.items;
        return topicChoice(result.item);
      } finally {
        creatingTopic.value = false;
      }
    }
    const topicSelection = computed(() => ({
      createOption: createTopic,
      createLabel: "创建并选中「{title}」",
      createHint: t(
        "新话题以 {language} 保存为草稿，确认选择后关联到当前内容。",
        { language: documentLanguage.value },
      ),
      createdHint: t(
        "话题已选中，请确认关联。已保存的话题草稿不会因取消而删除。",
      ),
      searchPlaceholder: t("搜索话题，或输入新话题名称…"),
    }));
    const isPage = props.path.startsWith("content/pages/") && !isSection;
    const pageTab = ref<"content" | "settings">("content"),
      settingsOpened = ref(false),
      settingsDirty = ref(false);
    const savedTemplate = computed(() =>
      String(baseline.value.layout || "empty"),
    );
    const templateChanged = computed(
      () =>
        !!revision.value &&
        String(values.value.layout || "empty") !== savedTemplate.value,
    );
    function showPageSettings() {
      if (busy.value) return;
      flush();
      pageTab.value = "settings";
      settingsOpened.value = true;
    }
    const visibleFields = computed(() =>
      documentFields.filter(
        (field) =>
          !["title", "description", "draft"].includes(field.path) &&
          ![
            "extra.kind",
            "extra.id",
            "extra.topics",
            "extra.ai_translation",
            "extra.translation_reviewed",
            "extra.translation_source",
            "extra.references",
          ].includes(field.path) &&
          (!isTopic || field.path === "extra.cover") &&
          (!isThread ||
            ["date", "taxonomies.tags", "extra.disable_comment"].includes(
              field.path,
            )) &&
          (!isPage ||
            ["path", "layout", "extra.disable_comment"].includes(field.path)) &&
          (isCollection || field.path !== "extra.tags") &&
          (isSection ||
            !["child_layout", "render", "insert_anchor_links"].includes(
              field.path,
            )),
      ),
    );
    const fixedChoices: Record<string, Choice[]> = {
      layout: [
        "post",
        "empty",
        "about",
        "friends",
        "music",
        "equipment",
        "wechat",
        "archives",
        "collection-list",
        "collection-detail",
        "collection-content",
        "collection-category",
      ].map((name, index) => ({
        value: name,
        label: [
          "文章",
          "普通页面",
          "关于",
          "友链",
          "音乐",
          "装备",
          "微信",
          "归档",
          "合集分组",
          "系列 / 专辑详情",
          "章节 / 曲目",
          "合集分类",
        ][index],
      })),
      child_layout: [
        { value: "collection-content", label: "章节 / 曲目" },
        { value: "post", label: "文章" },
        { value: "empty", label: "普通页面" },
      ],
      insert_anchor_links: [
        { value: "none", label: "不显示" },
        { value: "left", label: "标题左侧" },
        { value: "right", label: "标题右侧" },
        { value: "heading", label: "整个标题" },
      ],
    };
    function selectOptions(path: string): Choice[] {
      const options =
          isPage && path === "layout"
            ? childLayoutChoices
            : fixedChoices[path] || [],
        value = String(values.value[path] ?? "");
      return translateOptions(options.filter((option) => option.value !== ""));
    }
    async function loadChoices() {
      choicesLoading.value = true;
      choicesError.value = "";
      try {
        const [items, languages] = await Promise.all([
          api<ArticleSummary[]>("/content"),
          api<ContentLanguages>("/content-languages"),
        ]);
        topicItems.value = items;
        documentLanguage.value = translationLocation(
          props.path,
          languages.defaultLanguage,
          languages,
        ).sourceLanguage;
        const settings = await api<Settings>(
          `/settings/taxonomies?language=${encodeURIComponent(documentLanguage.value)}`,
        );
        const tags = taxonomyChoices(
          settings.values["post.tags"],
          items.flatMap((item) => item.tags),
        );
        choices.value = {
          "taxonomies.tags": tags,
          "taxonomies.categories": taxonomyChoices(
            settings.values["post.categories"],
            items.flatMap((item) => item.categories),
          ),
          // Display tags are literal labels in collection templates, unlike taxonomy IDs.
          "extra.tags": taxonomyChoices(undefined, [
            ...tags.map((tag) => tag.label),
            ...items.flatMap((item) => stringValues(item.displayTags)),
          ]),
        };
      } catch (e) {
        choicesError.value = errorMessage(e);
      } finally {
        choicesLoading.value = false;
      }
    }
    let editor: Vditor | undefined,
      alive = true,
      generation = 0,
      richReady = false;
    const storageKey = `studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${props.path}`;
    const shortcode = computed(() => /\{%|\{\{/.test(body.value));
    const changes = computed(() =>
      Object.fromEntries(
        Object.entries(values.value).filter(
          ([key, value]) =>
            documentFields.some((field) => field.path === key) &&
            !(isTopic && ["date", "updated"].includes(key)) &&
            JSON.stringify(value) !== JSON.stringify(baseline.value[key]),
        ),
      ),
    );
    const pristineValues = ref("");
    const dirty = computed(() =>
      !revision.value && props.embedded
        ? unsavedThreadChanged(
            props.initialBody,
            body.value,
            values.value,
            pristineValues.value,
          )
        : body.value !== originalBody.value ||
          Object.keys(changes.value).length > 0,
    );
    const aiEditPrompt = ref(false),
      aiChoiceMade = ref(false);
    const trackedTranslation = computed(
      () =>
        !!values.value["extra.translation_source"] ||
        values.value["extra.ai_translation"] === true ||
        values.value["extra.translation_reviewed"] === false,
    );
    watch(
      [body, () => values.value.title, () => values.value.description],
      () => {
        if (!ready.value || !trackedTranslation.value) return;
        values.value["extra.translation_reviewed"] = false;
        if (
          values.value["extra.ai_translation"] === true &&
          !aiChoiceMade.value
        )
          aiEditPrompt.value = true;
      },
      { flush: "sync" },
    );
    watch(
      () => values.value["extra.ai_translation"],
      (value, old) => {
        if (ready.value && value === true && old !== true)
          values.value["extra.translation_reviewed"] = false;
      },
      { flush: "sync" },
    );
    function chooseAiLabel(keep: boolean) {
      values.value["extra.ai_translation"] = keep;
      aiEditPrompt.value = false;
      aiChoiceMade.value = true;
    }
    function reviewTranslation() {
      flush();
      values.value["extra.translation_reviewed"] = true;
    }
    const preview = computed(() => {
      const parsed = new DOMParser().parseFromString(
        DOMPurify.sanitize(
          marked.parse(body.value, { async: false }) as string,
        ),
        "text/html",
      );
      for (const image of parsed.querySelectorAll("img")) {
        try {
          const path = storedMediaPath(
            decodeURIComponent(image.getAttribute("src") || ""),
            "document",
            props.path,
          );
          if (path) image.setAttribute("src", mediaURL(path));
        } catch {
          /* Preserve unrecognized URLs. */
        }
      }
      return parsed.body.innerHTML;
    });
    const wordCount = computed(() => body.value.replace(/\s/g, "").length);
    const get = (data: Record<string, Json>, path: string): Json | undefined =>
      path
        .split(".")
        .reduce<any>(
          (value, key) =>
            value && typeof value === "object" ? value[key] : undefined,
          data,
        );
    function snapshot() {
      return JSON.stringify({
        body: body.value,
        values: values.value,
        revision: revision.value,
        baseline: baseline.value,
        originalBody: originalBody.value,
        aiChoiceMade: aiChoiceMade.value,
        aiEditPrompt: aiEditPrompt.value,
      });
    }
    watch(
      [dirty, settingsDirty, branchPending],
      ([documentDirty, configurationDirty, pendingBranch]) =>
        emit("dirty", documentDirty || configurationDirty || pendingBranch),
      { flush: "sync" },
    );
    const backup = createDraftBackup(() => {
      if (forgotten || !ready.value || !dirty.value) return;
      try {
        localStorage.setItem(storageKey, snapshot());
      } catch {
        message.value = "浏览器草稿备份不可用，请及时保存或下载。";
      }
    });
    // Track nested metadata separately: deep watching body serializes the entire
    // document synchronously on every keystroke before scheduling its backup.
    const scheduleBackup = () => {
      if (!forgotten && ready.value && dirty.value) backup.schedule();
    };
    watch(body, scheduleBackup);
    watch(values, scheduleBackup, { deep: true });
    onMounted(() => {
      const hidden = () => {
        if (document.visibilityState === "hidden") flush();
      };
      document.addEventListener("visibilitychange", hidden);
      window.addEventListener("pagehide", flush);
      removeBackupListeners = () => {
        document.removeEventListener("visibilitychange", hidden);
        window.removeEventListener("pagehide", flush);
      };
    });
    let removeBackupListeners = () => {};
    async function loadDocument() {
      loading.value = true;
      error.value = "";
      ready.value = false;
      void loadChoices();
      try {
        if (props.initial) {
          body.value = props.initialBody || "";
          baseline.value = Object.fromEntries(
            documentFields
              .filter((field) => field.path !== "date")
              .map((field) => [field.path, structuredClone(field.default)]),
          );
          values.value = {
            ...JSON.parse(JSON.stringify(baseline.value)),
            ...(!isSection && !isTopic ? { date: new Date().toISOString() } : {}),
            ...props.initial,
          };
        } else {
          const doc = await api<Article>(
            `/document?path=${encodeURIComponent(props.path)}`,
          );
          body.value = doc.body;
          originalBody.value = doc.body;
          revision.value = doc.revision;
          values.value = Object.fromEntries(
            documentFields.map((field) => [
              field.path,
              get(doc.metadata, field.path) ??
                (field.path === "draft" ? false : field.default),
            ]),
          );
          baseline.value = JSON.parse(JSON.stringify(values.value));
        }
        pristineValues.value = JSON.stringify(values.value);
        try {
          recovery.value = !!localStorage.getItem(storageKey);
        } catch {
          /* Storage can be disabled. */
        }
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
        await nextTick();
        ready.value = !error.value;
      }
    }
    onMounted(loadDocument);
    function restore() {
      if (settingsDirty.value) {
        error.value =
          "页面设置还有未保存的更改，请先保存或放弃这些设置，再恢复正文草稿";
        return;
      }
      try {
        const draft = JSON.parse(localStorage.getItem(storageKey) || "null");
        if (!draft || typeof draft.body !== "string" || !draft.values)
          throw new Error("本地草稿格式不正确");
        destroyEditor(false);
        mode.value = "source";
        aiChoiceMade.value = draft.aiChoiceMade === true;
        aiEditPrompt.value = draft.aiEditPrompt === true;
        body.value = draft.body;
        values.value = draft.values;
        // Preserve the saved revision: stale recovered drafts must conflict, never overwrite a newer file.
        revision.value = draft.revision;
        baseline.value = draft.baseline;
        originalBody.value = draft.originalBody;
        recovery.value = false;
        message.value = "已恢复本地草稿；保存时仍会检查仓库版本。";
      } catch (e) {
        error.value = errorMessage(e);
      }
    }
    function discardBackup() {
      backup.cancel();
      try {
        localStorage.removeItem(storageKey);
      } catch {
        /* Optional local storage. */
      }
      recovery.value = false;
    }
    const richSync = createRichEditorSync(
      () =>
        !forgotten && alive && editor && richReady
          ? editor.getValue()
          : undefined,
      (value) => {
        body.value = richEditorBody(body.value, value);
      },
    );
    function flush() {
      richSync.flush();
      backup.flush();
    }
    function destroyEditor(sync = true) {
      if (sync) flush();
      richSync.cancel();
      generation++;
      richReady = false;
      const old = editor;
      editor = undefined;
      old?.destroy();
    }
    function readRichSoon() {
      richSync.schedule();
    }
    function forget() {
      forgotten = true;
      destroyEditor(false);
      discardBackup();
      emit("dirty", false);
    }
    expose({
      flush,
      forget,
      isBusy: () =>
        busy.value ||
        translating.value ||
        creatingTopic.value ||
        aiWorking.value,
      draft: () => {
        flush();
        return {
          initial: JSON.parse(JSON.stringify(values.value)) as Record<
            string,
            Json
          >,
          initialBody: body.value,
        };
      },
    });
    async function changeMode(next: typeof mode.value) {
      destroyEditor();
      mode.value = next;
      const instance = generation;
      if (next !== "rich") return;
      if (shortcode.value) {
        mode.value = "source";
        return;
      }
      try {
        const { default: Vditor } = await import("vditor");
        await prepareEditorIcons();
        await nextTick();
        if (
          !alive ||
          instance !== generation ||
          mode.value !== "rich" ||
          !editorElement.value
        )
          return;
        editor = new Vditor(editorElement.value, {
          cdn: `${location.origin}/vendor/vditor`,
          mode: "ir",
          value: body.value,
          height: props.embedded ? 180 : isThread ? 360 : 560,
          lang: locale.value === "zh-CN" ? "zh_CN" : "en_US",
          cache: { enable: false },
          counter: { enable: false },
          theme:
            window.document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "classic",
          preview: {
            markdown: { toc: false, sanitize: true },
            hljs: { enable: false },
            math: { engine: "KaTeX" },
          },
          toolbar: [
            "headings",
            "bold",
            "italic",
            "strike",
            "|",
            "list",
            "ordered-list",
            "check",
            "|",
            "quote",
            "code",
            "inline-code",
            "link",
            "table",
            "|",
            "undo",
            "redo",
          ],
          input: (value) => {
            if (alive && generation === instance && richReady)
              richSync.accept(value);
          },
          after: () => {
            if (generation === instance) richReady = true;
          },
        });
      } catch (e) {
        error.value = errorMessage(e);
        mode.value = "source";
      }
    }
    async function saveLocalized(draft: boolean) {
      if (busy.value || creatingTopic.value) return;
      const previous = values.value.draft;
      values.value.draft = draft;
      if (!(await save())) values.value.draft = previous;
    }
    async function save(): Promise<boolean> {
      if (
        forgotten ||
        busy.value ||
        translating.value ||
        creatingTopic.value ||
        aiWorking.value
      )
        return false;
      flush();
      if (
        isThread &&
        !body.value.trim() &&
        !String(values.value.title || "").trim() &&
        !(
          Array.isArray(values.value["extra.references"]) &&
          values.value["extra.references"].length
        )
      ) {
        error.value = "请填写动态正文、标题或引用文章";
        return false;
      }
      if (aiEditPrompt.value) {
        error.value = "请先选择是否保留 AI 翻译标识";
        return false;
      }
      if (
        trackedTranslation.value &&
        values.value.draft === false &&
        values.value["extra.translation_reviewed"] !== true
      ) {
        error.value = "请先审核译文，再发布内容";
        return false;
      }
      if (settingsDirty.value) {
        const groups = (layout: string, content: string) =>
          pageProfile(layout, content)
            .groups.map((group) => group.id)
            .join(",");
        if (
          groups(String(values.value.layout || "empty"), body.value) !==
          groups(savedTemplate.value, originalBody.value)
        ) {
          error.value =
            "这次正文修改会改变页面配置入口，请先保存或放弃页面设置，再保存正文";
          return false;
        }
      }
      busy.value = true;
      error.value = "";
      message.value = "";
      const submittedBody = body.value,
        submittedValues = JSON.parse(JSON.stringify(values.value));
      try {
        const result = await api<SaveResult>("/document", "PUT", {
          path: props.path,
          body: submittedBody,
          changes: {
            ...changes.value,
            ...(trackedTranslation.value
              ? {
                  "extra.translation_reviewed":
                    values.value["extra.translation_reviewed"] === true,
                }
              : {}),
          },
          revision: revision.value,
          saveMode: saveMode.value,
        });
        autosavePaused.value = false;
        revision.value = result.revision;
        baseline.value = submittedValues;
        originalBody.value = submittedBody;
        branchPending.value = result.branchPending === true;
        savedBranch.value = result.branch || "";
        message.value = result.branchPending ? "" : result.message;
        if (result.branchPending) { error.value = result.message; autosavePaused.value = true; }
        if (isTopic) {
          try {
            const saved = await api<Article>(
              `/document?path=${encodeURIComponent(props.path)}`,
            );
            for (const key of ["date", "updated"]) {
              values.value[key] = saved.metadata[key] || "";
              baseline.value[key] = values.value[key];
            }
          } catch {
            message.value = "内容已保存，但时间信息刷新失败。重新打开可查看。";
          }
        }
        if (!dirty.value) {
          discardBackup();
          aiChoiceMade.value = false;
        } else backup.flush();
        if (!result.branchPending) emit("saved", props.path);
        return true;
      } catch (e) {
        error.value = errorMessage(e);
        return false;
      } finally {
        busy.value = false;
      }
    }
    function remove() {
      if (
        !revision.value ||
        busy.value ||
        translating.value ||
        settingsDirty.value
      )
        return;
      flush();
      deleteDialog.value = true;
    }
    function deleted(path: string) {
      forget();
      deleteDialog.value = false;
      busy.value = false;
      emit("deleted", path);
      emit("back");
    }
    function download() {
      flush();
      const blob = new Blob(
        [
          JSON.stringify(
            { path: props.path, metadata: values.value, body: body.value },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "studio-draft.json";
      link.click();
      URL.revokeObjectURL(url);
    }
    watch(locale, () => {
      if (mode.value === "rich") void changeMode("rich");
    });
    onBeforeUnmount(() => {
      removeBackupListeners();
      flush();
      backup.cancel();
      alive = false;
      destroyEditor(false);
      emit("dirty", false);
    });
    return () =>
      loading.value
        ? element(LoadingState, { label: "正在载入文稿…" })
        : !ready.value
          ? element(
              "div",
              { role: "alert", className: classes("notice error") },
              t(error.value),
              " ",
              element(
                "button",
                {
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    loadDocument();
                  }),
                },
                t("重试"),
              ),
              " ",
              element(
                "button",
                {
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    emit("back");
                  }),
                },
                t(props.backLabel || "← 返回内容库"),
              ),
            )
          : element(
              "section",
              {
                className: classes("editor-page", {
                  "thread-editor": isThread,
                  "embedded-editor": props.embedded,
                }),
              },
              !props.embedded
                ? element(
                    "div",
                    { className: classes("page-heading") },
                    element(
                      "div",
                      null,
                      element(
                        "button",
                        {
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            emit("back");
                          }),
                        },
                        t(props.backLabel || "← 返回内容库"),
                      ),
                      element(
                        "h1",
                        null,
                        isThread
                          ? contentLabel(body.value, values.value.title) ||
                              t("新动态")
                          : values.value.title || t("未命名内容"),
                      ),
                      element(
                        "details",
                        { className: classes("editor-file-location") },
                        element("summary", null, t("文件位置")),
                        element(
                          "p",
                          { className: classes("muted path-label") },
                          props.path,
                        ),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("row editor-save-actions") },
                      element(
                        "label",
                        { className: classes("autosave-control") },
                        element("span", null, t("自动保存")),
                        element(
                          "select",
                          {
                            value: autosaveSeconds.value ?? "",
                            "aria-label": t("自动保存间隔"),
                            onChange: domEvent(($event: Event) => {
                              autosaveSeconds.value = modelValue(
                                $event.target as HTMLSelectElement,
                                autosaveSeconds.value,
                              );
                            }),
                          },
                          element("option", { value: 0 }, t("已关闭")),
                          element("option", { value: 30 }, t("每 30 秒")),
                          element("option", { value: 300 }, t("每 5 分钟")),
                          element("option", { value: 1800 }, t("每 30 分钟")),
                        ),
                      ),
                      revision.value
                        ? element(
                            "button",
                            {
                              disabled:
                                busy.value ||
                                translating.value ||
                                settingsDirty.value,
                              className: classes("secondary danger"),
                              onClick: domEvent(($event: Event) => {
                                remove();
                              }),
                            },
                            t("删除当前语言版本"),
                          )
                        : null,
                      element(
                        "button",
                        {
                          className: classes("secondary"),
                          onClick: domEvent(($event: Event) => {
                            download();
                          }),
                        },
                        t("下载备份"),
                      ),
                      isLocalized
                        ? element(
                            Fragment,
                            null,
                            element(
                              "button",
                              {
                                disabled:
                                  busy.value ||
                                  (!dirty.value && !branchPending.value && saveMode.value !== "branch" && values.value.draft === true),
                                className: classes("secondary"),
                                onClick: domEvent(($event: Event) => {
                                  saveLocalized(true);
                                }),
                              },
                              t(
                                values.value.draft === false
                                  ? "转为草稿"
                                  : "保存草稿",
                              ),
                            ),
                            saveAction(true),
                          )
                        : saveAction(),
                    ),
                  )
                : null,
              autosaveSeconds.value
                ? element(
                    "p",
                    { role: "status", className: classes("autosave-status") },
                    autosavePaused.value
                      ? t(
                          "自动保存已暂停，请检查错误后手动保存或重新选择间隔。",
                        )
                      : autosaveLast.value
                        ? t("自动保存于 {time}", { time: autosaveLast.value })
                        : t("自动保存已开启；新内容首次保存为草稿。"),
                  )
                : null,
              savedBranch.value ? element("code", { className: "saved-branch" }, savedBranch.value) : null,
              error.value
                ? element(
                    "p",
                    { role: "alert", className: classes("notice error") },
                    t(error.value),
                    " ",
                    t(
                      "编辑内容已保留。如有版本冲突，请先下载备份，再重新打开文件合并。",
                    ),
                  )
                : null,
              message.value
                ? element(
                    "p",
                    { role: "status", className: classes("notice success") },
                    t(message.value),
                  )
                : null,
              recovery.value
                ? element(
                    "div",
                    {
                      role: "status",
                      className: classes("notice row", {
                        "composer-recovery": props.embedded,
                      }),
                    },
                    t("发现本地草稿备份。"),
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          restore();
                        }),
                      },
                      t("恢复草稿"),
                    ),
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          discardBackup();
                        }),
                      },
                      t("丢弃备份"),
                    ),
                  )
                : null,
              supportsTranslation && (!props.embedded || revision.value)
                ? element(LocalizedContentContext, {
                    kind: isTopic
                      ? "topic"
                      : isThread
                        ? "thread"
                        : isCollection
                          ? "collection"
                          : isPage
                            ? "page"
                            : "article",
                    path: props.path,
                    revision: revision.value,
                    dirty: dirty.value,
                    busy: busy.value,
                    onWorking: (($event) => {
                      translating.value = $event;
                    }) satisfies EventHandler<
                      typeof LocalizedContentContext,
                      "onWorking"
                    >,
                    onOpen: ((path, initial, initialBody) =>
                      emit(
                        "open",
                        path,
                        initial,
                        initialBody,
                      )) satisfies EventHandler<
                      typeof LocalizedContentContext,
                      "onOpen"
                    >,
                  })
                : null,
              isPage
                ? element(
                    "div",
                    { className: classes("page-editor-tabs") },
                    element(
                      "button",
                      {
                        className: classes({
                          active: pageTab.value === "content",
                        }),
                        onClick: domEvent(($event: Event) => {
                          pageTab.value = "content";
                        }),
                      },
                      t("正文与属性"),
                    ),
                    element(
                      "button",
                      {
                        disabled: busy.value,
                        className: classes({
                          active: pageTab.value === "settings",
                        }),
                        onClick: domEvent(($event: Event) => {
                          showPageSettings();
                        }),
                      },
                      t("页面设置"),
                      settingsDirty.value
                        ? element("span", { "aria-label": t("未保存") }, " ·")
                        : null,
                    ),
                  )
                : null,
              isPage && settingsOpened.value
                ? element(
                    "div",
                    {
                      inert: busy.value,
                      className: classes("page-settings-pane"),
                      style: Object.assign(
                        {},
                        {
                          display:
                            pageTab.value === "settings" ? undefined : "none",
                        },
                      ),
                    },
                    !revision.value || templateChanged.value
                      ? element(
                          "p",
                          { className: classes("notice") },
                          t("请先保存页面内容与模板，再编辑对应的页面设置。"),
                        )
                      : documentLanguage.value
                        ? element(PageSettings, {
                            key: savedTemplate.value,
                            layout: savedTemplate.value,
                            body: originalBody.value,
                            language: documentLanguage.value,
                            onDirty: (($event) => {
                              settingsDirty.value = $event;
                            }) satisfies EventHandler<
                              typeof PageSettings,
                              "onDirty"
                            >,
                          })
                        : element(
                            "p",
                            { className: classes("notice") },
                            t("正在确认内容语言，确认后可编辑页面设置。"),
                            " ",
                            element(
                              "button",
                              {
                                className: classes("text-button"),
                                onClick: domEvent(($event: Event) => {
                                  loadChoices();
                                }),
                              },
                              t("重试"),
                            ),
                          ),
                  )
                : null,
              isPage && pageTab.value === "content"
                ? element(
                    "p",
                    { className: classes("editor-hint") },
                    t(
                      pageProfile(String(values.value.layout || ""), body.value)
                        .description,
                    ),
                  )
                : null,
              isLocalized && !props.embedded
                ? element(
                    "p",
                    { className: classes("editor-hint") },
                    t("保存写入仓库，完成网站构建与部署后才会上线。"),
                  )
                : null,
              isLocalized && props.initialBody !== undefined && !revision.value
                ? element(
                    "p",
                    { className: classes("notice") },
                    t("这是译文草稿，已复制原文。请完成翻译后再发布。"),
                  )
                : null,
              element(
                "div",
                {
                  inert: busy.value && !autosaving.value,
                  className: classes("editor-layout"),
                  style: Object.assign(
                    {},
                    {
                      display:
                        !isPage || pageTab.value === "content"
                          ? undefined
                          : "none",
                    },
                  ),
                },
                element(
                  "div",
                  { className: classes("card writing-card") },
                  !isThread
                    ? element(
                        "label",
                        {
                          className: classes("field field-inline title-field"),
                        },
                        element("span", null, t("标题")),
                        element("input", {
                          value: values.value.title ?? "",
                          required: isTopic,
                          placeholder: t("为这篇内容写一个标题…"),
                          onInput: domEvent(($event: Event) => {
                            values.value.title = (
                              $event.target as HTMLInputElement
                            ).value;
                          }),
                        }),
                      )
                    : null,
                  !isThread
                    ? element(
                        "div",
                        { className: classes("field summary-field") },
                        element(
                          "div",
                          { className: classes("summary-heading") },
                          element(
                            "label",
                            { htmlFor: "article-description" },
                            t("摘要"),
                          ),
                          element(
                            "button",
                            {
                              type: "button",
                              disabled:
                                busy.value ||
                                !body.value.trim() ||
                                !documentLanguage.value,
                              className: classes("text-button ai-action"),
                              onClick: domEvent(($event: Event) => {
                                openAi("summary");
                              }),
                            },
                            "✦ ",
                            t("AI 摘要"),
                          ),
                        ),
                        element("textarea", {
                          id: "article-description",
                          value: String(values.value.description ?? ""),
                          rows: "3",
                          placeholder: t("用一两句话介绍这篇内容"),
                          onInput: domEvent(($event: Event) => {
                            values.value.description = (
                              $event.target as HTMLTextAreaElement
                            ).value;
                          }),
                        }),
                      )
                    : null,
                  element(
                    "div",
                    {
                      className: classes("editor-tabs", {
                        "composer-mode-tabs": props.embedded,
                      }),
                    },
                    element(
                      "button",
                      {
                        className: classes({ active: mode.value === "source" }),
                        onClick: domEvent(($event: Event) => {
                          changeMode("source");
                        }),
                      },
                      t("Markdown 源码"),
                    ),
                    element(
                      "button",
                      {
                        disabled: shortcode.value,
                        className: classes({ active: mode.value === "rich" }),
                        onClick: domEvent(($event: Event) => {
                          changeMode("rich");
                        }),
                      },
                      t("可视化编辑"),
                    ),
                    element(
                      "button",
                      {
                        className: classes({
                          active: mode.value === "preview",
                        }),
                        onClick: domEvent(($event: Event) => {
                          changeMode("preview");
                        }),
                      },
                      t("正文预览"),
                    ),
                    !props.embedded
                      ? element(
                          "button",
                          {
                            disabled: busy.value || mode.value !== "source",
                            title:
                              mode.value !== "source"
                                ? t("切换到 Markdown 源码后插入图片")
                                : t("从仓库选择图片插入正文"),
                            onClick: domEvent(($event: Event) => {
                              chooseImage();
                            }),
                          },
                          t("插入图片"),
                        )
                      : null,
                    element(
                      "span",
                      { className: classes("muted small") },
                      t("{count} 字符", { count: wordCount.value }),
                    ),
                  ),
                  shortcode.value
                    ? element(
                        "p",
                        { className: classes("editor-hint") },
                        t("包含 shortcode，使用源码编辑以保留原始结构。"),
                      )
                    : null,
                  mode.value === "source"
                    ? element("textarea", {
                        ref: domRef(sourceElement),
                        value: body.value ?? "",
                        "aria-label": t("Markdown 正文"),
                        placeholder: t(
                          props.embedded
                            ? "此刻，有什么想分享？"
                            : "从这里开始书写…",
                        ),
                        spellCheck: "false",
                        className: classes("markdown-source"),
                        onInput: domEvent(($event: Event) => {
                          body.value = (
                            $event.target as HTMLInputElement
                          ).value;
                        }),
                      })
                    : mode.value === "rich"
                      ? element("div", {
                          ref: domRef(editorElement),
                          onInput: domEvent(($event: Event) => {
                            readRichSoon();
                          }),
                          onClick: domEvent(($event: Event) => {
                            readRichSoon();
                          }),
                        })
                      : element(
                          "div",
                          null,
                          element(
                            "p",
                            { className: classes("editor-hint") },
                            t(
                              "这里只预览 Markdown；shortcode 和主题页面请在 Astro 网站预览中查看。",
                            ),
                          ),
                          element("article", {
                            dangerouslySetInnerHTML: { __html: preview.value },
                            className: classes("markdown-preview"),
                          }),
                        ),
                  isThread && !props.embedded
                    ? element(ArticleReferences, {
                        modelValue: values.value["extra.references"],
                        items: topicItems.value,
                        language: documentLanguage.value,
                        disabled: busy.value || choicesLoading.value,
                        onUpdateModelValue: (($event) => {
                          values.value["extra.references"] = $event;
                        }) satisfies EventHandler<
                          typeof ArticleReferences,
                          "onUpdateModelValue"
                        >,
                      })
                    : null,
                  element(
                    "div",
                    { className: classes("list-footer") },
                    dirty.value
                      ? t("有未保存的更改 · 已在此浏览器备份")
                      : t(revision.value ? "已保存" : "尚未保存"),
                  ),
                ),
                element(
                  "aside",
                  {
                    className: classes("editor-aside"),
                    style: Object.assign(
                      {},
                      {
                        display:
                          !props.embedded ||
                          threadAdvanced.value ||
                          trackedTranslation.value
                            ? undefined
                            : "none",
                      },
                    ),
                  },
                  element(
                    "div",
                    {
                      className: classes("card metadata-card", {
                        "thread-properties-panel": props.embedded,
                      }),
                    },
                    !props.embedded ? element("h2", null, t("内容属性")) : null,
                    !isLocalized
                      ? element(
                          "label",
                          {
                            className: classes(
                              "field checkbox-field form-switch",
                            ),
                          },
                          element("input", {
                            checked: !!values.value.draft,
                            type: "checkbox",
                            role: "switch",
                            disabled: busy.value,
                            onChange: domEvent(($event: Event) => {
                              values.value.draft = (
                                $event.target as HTMLInputElement
                              ).checked;
                            }),
                          }),
                          element("span", null, t("保留为草稿")),
                        )
                      : null,
                    isLocalized && !props.embedded
                      ? element(
                          Fragment,
                          null,
                          element(
                            "span",
                            {
                              className: classes("badge", {
                                draft: values.value.draft,
                              }),
                            },
                            t(values.value.draft ? "草稿" : "已发布"),
                          ),
                          isThread && !props.embedded
                            ? element(
                                "button",
                                {
                                  "aria-expanded": threadAdvanced.value,
                                  className: classes(
                                    "text-button thread-advanced",
                                  ),
                                  onClick: domEvent(($event: Event) => {
                                    threadAdvanced.value = !threadAdvanced.value;
                                  }),
                                },
                                t("更多属性"),
                              )
                            : null,
                          isThread && threadAdvanced.value
                            ? element(
                                "label",
                                { className: classes("field field-inline") },
                                element("span", null, t("标题（可选）")),
                                element("input", {
                                  value: values.value.title ?? "",
                                  onInput: domEvent(($event: Event) => {
                                    values.value.title = (
                                      $event.target as HTMLInputElement
                                    ).value;
                                  }),
                                }),
                              )
                            : null,
                        )
                      : null,
                    props.embedded
                      ? element(
                          Fragment,
                          null,
                          element(
                            "div",
                            { className: classes("thread-properties-heading") },
                            element("h3", null, t("发布设置")),
                            element(
                              "span",
                              {
                                className: classes("thread-properties-state", {
                                  draft: values.value.draft,
                                }),
                              },
                              element("i", { "aria-hidden": "true" }),
                              t(values.value.draft ? "草稿" : "已发布"),
                            ),
                            element(
                              "button",
                              {
                                type: "button",
                                "aria-expanded": threadAdvanced.value,
                                className: classes("text-button"),
                                onClick: domEvent(($event: Event) => {
                                  threadAdvanced.value = !threadAdvanced.value;
                                }),
                              },
                              t(threadAdvanced.value ? "收起设置" : "展开设置"),
                              element(
                                "span",
                                { "aria-hidden": "true" },
                                threadAdvanced.value ? "⌃" : "⌄",
                              ),
                            ),
                          ),
                          element(
                            "div",
                            {
                              className: classes("thread-properties-fields"),
                              style: Object.assign(
                                {},
                                {
                                  display: threadAdvanced.value
                                    ? undefined
                                    : "none",
                                },
                              ),
                            },
                            element(
                              "label",
                              {
                                className: classes(
                                  "field field-inline thread-title-field",
                                ),
                              },
                              element("span", null, t("标题")),
                              element("input", {
                                value: values.value.title ?? "",
                                placeholder: t("可选，给这条动态起个标题"),
                                onInput: domEvent(($event: Event) => {
                                  values.value.title = (
                                    $event.target as HTMLInputElement
                                  ).value;
                                }),
                              }),
                            ),
                            element(PublicationDateField, {
                              modelValue: values.value.date,
                              disabled: busy.value,
                              onUpdateModelValue: (($event) => {
                                values.value.date = $event;
                              }) satisfies EventHandler<
                                typeof PublicationDateField,
                                "onUpdateModelValue"
                              >,
                            }),
                          ),
                          element(
                            "div",
                            {
                              className: classes("thread-properties-switches"),
                              style: Object.assign(
                                {},
                                {
                                  display: threadAdvanced.value
                                    ? undefined
                                    : "none",
                                },
                              ),
                            },
                            element(
                              "label",
                              {
                                className: classes(
                                  "field checkbox-field form-switch thread-property-toggle",
                                ),
                              },
                              element("input", {
                                type: "checkbox",
                                role: "switch",
                                "aria-label": t("允许评论"),
                                checked: !values.value["extra.disable_comment"],
                                onChange: domEvent(($event: Event) => {
                                  values.value["extra.disable_comment"] = !(
                                    $event.target as HTMLInputElement
                                  ).checked;
                                }),
                              }),
                              element("span", null, t("允许评论")),
                            ),
                            element(
                              "label",
                              {
                                className: classes(
                                  "field checkbox-field form-switch thread-property-toggle",
                                ),
                              },
                              element("input", {
                                checked: !!values.value["extra.ai_translation"],
                                type: "checkbox",
                                role: "switch",
                                "aria-label": t("AI 翻译"),
                                onChange: domEvent(($event: Event) => {
                                  values.value["extra.ai_translation"] = (
                                    $event.target as HTMLInputElement
                                  ).checked;
                                }),
                              }),
                              element("span", null, t("AI 翻译")),
                            ),
                          ),
                        )
                      : null,
                    supportsTranslation
                      ? element(
                          Fragment,
                          null,
                          !props.embedded
                            ? element(
                                "label",
                                {
                                  className: classes(
                                    "field checkbox-field form-switch",
                                  ),
                                },
                                element("input", {
                                  checked:
                                    !!values.value["extra.ai_translation"],
                                  type: "checkbox",
                                  role: "switch",
                                  onChange: domEvent(($event: Event) => {
                                    values.value["extra.ai_translation"] = (
                                      $event.target as HTMLInputElement
                                    ).checked;
                                  }),
                                }),
                                element("span", null, t("AI 翻译")),
                              )
                            : null,

                          aiEditPrompt.value
                            ? element(
                                "div",
                                {
                                  role: "status",
                                  className: classes("notice ai-review"),
                                },
                                element(
                                  "p",
                                  null,
                                  t("你已修改 AI 译文，是否保留 AI 翻译标识？"),
                                ),
                                element(
                                  "div",
                                  { className: classes("row") },
                                  element(
                                    "button",
                                    {
                                      className: classes("text-button"),
                                      onClick: domEvent(($event: Event) => {
                                        chooseAiLabel(true);
                                      }),
                                    },
                                    t("保留 AI 标识"),
                                  ),
                                  element(
                                    "button",
                                    {
                                      className: classes("text-button"),
                                      onClick: domEvent(($event: Event) => {
                                        chooseAiLabel(false);
                                      }),
                                    },
                                    t("取消 AI 标识"),
                                  ),
                                ),
                              )
                            : null,
                          trackedTranslation.value
                            ? element(
                                "div",
                                { className: classes("ai-review") },
                                element(
                                  "span",
                                  {
                                    className: classes("badge", {
                                      draft:
                                        !values.value[
                                          "extra.translation_reviewed"
                                        ],
                                    }),
                                  },
                                  t(
                                    values.value["extra.translation_reviewed"]
                                      ? "译文已审核"
                                      : "译文待审核",
                                  ),
                                ),
                                !values.value["extra.translation_reviewed"]
                                  ? element(
                                      "button",
                                      {
                                        disabled:
                                          aiEditPrompt.value || busy.value,
                                        className: classes("text-button"),
                                        onClick: domEvent(($event: Event) => {
                                          reviewTranslation();
                                        }),
                                      },
                                      t("确认已审核译文"),
                                    )
                                  : null,
                                element(
                                  "p",
                                  { className: classes("muted small") },
                                  t(
                                    "请检查准确性与格式；修改译文后需要重新审核。",
                                  ),
                                ),
                              )
                            : null,
                        )
                      : null,
                    choicesError.value
                      ? element(
                          "p",
                          { role: "alert", className: classes("notice error") },
                          t("选项载入失败："),
                          t(choicesError.value),
                          " ",
                          element(
                            "button",
                            {
                              className: classes("text-button"),
                              onClick: domEvent(($event: Event) => {
                                loadChoices();
                              }),
                            },
                            t("重试选项"),
                          ),
                        )
                      : null,
                    isTopic
                      ? element(
                          "div",
                          { className: classes("topic-timestamps") },
                          element(
                            "p",
                            null,
                            element("span", null, t("创建时间")),
                            element(
                              "time",
                              null,
                              values.value.date || t("首次保存后生成"),
                            ),
                          ),
                          element(
                            "p",
                            null,
                            element("span", null, t("资料更新时间")),
                            element(
                              "time",
                              null,
                              values.value.updated || t("首次保存后生成"),
                            ),
                          ),
                          element(
                            "p",
                            { className: classes("muted small") },
                            t(
                              "时间由系统维护。修改话题资料不会提高话题的内容活跃时间。",
                            ),
                          ),
                        )
                      : null,
                    supportsTopics && !props.embedded
                      ? element(SelectionField, {
                          ...topicSelection.value,
                          multiple: true,
                          modelValue: values.value["extra.topics"] || [],
                          options: topicChoices.value,
                          disabled:
                            busy.value ||
                            choicesLoading.value ||
                            !!choicesError.value,
                          name: "extra.topics",
                          label: t("关联话题"),

                          onUpdateModelValue: (($event) => {
                            values.value["extra.topics"] = $event;
                          }) satisfies EventHandler<
                            typeof SelectionField,
                            "onUpdateModelValue"
                          >,
                        })
                      : null,
                    renderList(
                      isThread && !threadAdvanced.value
                        ? []
                        : visibleFields.value.filter(
                            (field) =>
                              !props.embedded ||
                              ![
                                "taxonomies.tags",
                                "date",
                                "extra.disable_comment",
                              ].includes(field.path),
                          ),
                    ).map((field) =>
                      element(
                        Fragment,
                        { key: field.path },
                        field.kind === "structured"
                          ? element(ChoiceSelect, {
                              modelValue:
                                values.value[field.path] ?? field.default,
                              options: choices.value[field.path] || [],
                              disabled: choicesLoading.value,
                              name: field.path,
                              label: t(field.label),
                              hint: t("在「标签与分类」中管理选项。"),
                              onUpdateModelValue: (($event) => {
                                values.value[field.path] = $event;
                              }) satisfies EventHandler<
                                typeof ChoiceSelect,
                                "onUpdateModelValue"
                              >,
                            })
                          : fixedChoices[field.path]
                            ? element(SelectionField, {
                                modelValue: values.value[field.path],
                                options: selectOptions(field.path),
                                name: field.path,
                                label: t(field.label),
                                disabled:
                                  field.path === "layout" &&
                                  settingsDirty.value,
                                hint:
                                  field.path === "layout" && settingsDirty.value
                                    ? t("请先保存页面设置，再更换模板。")
                                    : !values.value[field.path]
                                      ? t("留空时使用站点默认设置。")
                                      : undefined,
                                onUpdateModelValue: (($event) => {
                                  values.value[field.path] = $event;
                                }) satisfies EventHandler<
                                  typeof SelectionField,
                                  "onUpdateModelValue"
                                >,
                              })
                            : isThread && field.path === "date"
                              ? element(PublicationDateField, {
                                  modelValue: values.value.date,
                                  disabled: busy.value,
                                  onUpdateModelValue: (($event) => {
                                    values.value.date = $event;
                                  }) satisfies EventHandler<
                                    typeof PublicationDateField,
                                    "onUpdateModelValue"
                                  >,
                                })
                              : element(FormField, {
                                  modelValue: values.value[field.path],
                                  name: field.path,
                                  label:
                                    isTopic && field.path === "extra.cover"
                                      ? t("话题封面")
                                      : t(field.label),
                                  kind: field.kind,
                                  hint: t(field.hint),
                                  documentPath: props.path,
                                  required:
                                    field.path === "date" &&
                                    !isSection &&
                                    !isPage,
                                  onUpdateModelValue: (($event) => {
                                    values.value[field.path] = $event;
                                  }) satisfies EventHandler<
                                    typeof FormField,
                                    "onUpdateModelValue"
                                  >,
                                }),
                        field.path === "extra.cover" && !isTopic
                          ? element(
                              "button",
                              {
                                type: "button",
                                disabled:
                                  busy.value ||
                                  !String(
                                    values.value.description || "",
                                  ).trim() ||
                                  !documentLanguage.value,
                                title: !String(
                                  values.value.description || "",
                                ).trim()
                                  ? t("请先填写或生成摘要")
                                  : undefined,
                                className: classes("secondary ai-cover-action"),
                                onClick: domEvent(($event: Event) => {
                                  openAi("cover");
                                }),
                              },
                              "✦ ",
                              t("AI 生成封面"),
                            )
                          : null,
                      ),
                    ),
                  ),
                ),
              ),
              props.embedded
                ? element(
                    "div",
                    { className: classes("composer-footer") },
                    element(
                      "div",
                      {
                        "aria-label": t("动态设置"),
                        className: classes("composer-tools"),
                      },
                      element(
                        "button",
                        {
                          disabled: busy.value || mode.value !== "source",
                          title:
                            mode.value !== "source"
                              ? t("切换到 Markdown 源码后插入图片")
                              : t("从仓库选择图片插入正文"),
                          className: classes("composer-tool"),
                          onClick: domEvent(($event: Event) => {
                            chooseImage();
                          }),
                        },
                        element(Icon, { name: "image", size: 17 }),
                        t("插入图片"),
                      ),
                      element(ChoiceSelect, {
                        compact: true,
                        icon: "tag",
                        modelValue: values.value["taxonomies.tags"] || [],
                        options: choices.value["taxonomies.tags"] || [],
                        disabled: busy.value || choicesLoading.value,
                        name: "taxonomies.tags",
                        label: t("标签"),
                        onUpdateModelValue: (($event) => {
                          values.value["taxonomies.tags"] = $event;
                        }) satisfies EventHandler<
                          typeof ChoiceSelect,
                          "onUpdateModelValue"
                        >,
                      }),
                      element(SelectionField, {
                        ...topicSelection.value,
                        multiple: true,
                        compact: true,
                        icon: "hash",
                        modelValue: values.value["extra.topics"] || [],
                        options: topicChoices.value,
                        disabled:
                          busy.value ||
                          choicesLoading.value ||
                          !!choicesError.value,
                        name: "extra.topics",
                        label: t("关联话题"),
                        onUpdateModelValue: (($event) => {
                          values.value["extra.topics"] = $event;
                        }) satisfies EventHandler<
                          typeof SelectionField,
                          "onUpdateModelValue"
                        >,
                      }),
                      element(ArticleReferences, {
                        compact: true,
                        modelValue: values.value["extra.references"],
                        items: topicItems.value,
                        language: documentLanguage.value,
                        disabled: busy.value || choicesLoading.value,
                        onUpdateModelValue: (($event) => {
                          values.value["extra.references"] = $event;
                        }) satisfies EventHandler<
                          typeof ArticleReferences,
                          "onUpdateModelValue"
                        >,
                      }),
                      element(
                        "button",
                        {
                          "aria-expanded": threadAdvanced.value,
                          className: classes("composer-tool"),
                          onClick: domEvent(($event: Event) => {
                            threadAdvanced.value = !threadAdvanced.value;
                          }),
                        },
                        element(Icon, { name: "sliders", size: 16 }),
                        t(threadAdvanced.value ? "收起设置" : "发布设置"),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("composer-publish") },
                      element(
                        "label",
                        { className: classes("autosave-control") },
                        element("span", null, t("自动保存")),
                        element(
                          "select",
                          {
                            value: autosaveSeconds.value ?? "",
                            "aria-label": t("自动保存间隔"),
                            onChange: domEvent(($event: Event) => {
                              autosaveSeconds.value = modelValue(
                                $event.target as HTMLSelectElement,
                                autosaveSeconds.value,
                              );
                            }),
                          },
                          element("option", { value: 0 }, t("已关闭")),
                          element("option", { value: 30 }, t("每 30 秒")),
                          element("option", { value: 300 }, t("每 5 分钟")),
                          element("option", { value: 1800 }, t("每 30 分钟")),
                        ),
                      ),
                      element(
                        "button",
                        {
                          disabled:
                            busy.value ||
                            (!dirty.value && !branchPending.value && saveMode.value !== "branch" && values.value.draft === true),
                          className: classes("text-button composer-save"),
                          onClick: domEvent(($event: Event) => {
                            saveLocalized(true);
                          }),
                        },
                        t(
                          values.value.draft === false
                            ? "转为草稿"
                            : "保存草稿",
                        ),
                      ),
                      saveAction(true),
                    ),
                  )
                : null,
              props.embedded && threadAdvanced.value
                ? element(
                    "div",
                    { className: classes("composer-secondary-actions") },
                    element(
                      "span",
                      { className: classes("muted small") },
                      dirty.value
                        ? t("有未保存的更改 · 已在此浏览器备份")
                        : t(revision.value ? "已保存" : "尚未保存"),
                    ),
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          download();
                        }),
                      },
                      t("下载备份"),
                    ),
                    revision.value
                      ? element(
                          "button",
                          {
                            disabled: busy.value || translating.value,
                            className: classes("text-button danger"),
                            onClick: domEvent(($event: Event) => {
                              remove();
                            }),
                          },
                          t("删除当前语言版本"),
                        )
                      : null,
                    element(
                      "details",
                      { className: classes("composer-file") },
                      element("summary", null, t("文件位置")),
                      element(
                        "p",
                        { className: classes("muted path-label") },
                        t("文件位置"),
                        "：",
                        props.path,
                      ),
                    ),
                  )
                : null,
              aiDialog.value
                ? element(AiAssistant, {
                    kind: aiDialog.value,
                    title: String(values.value.title || ""),
                    text: aiSource.value,
                    language: documentLanguage.value,
                    path: props.path,
                    onWorking: (($event) => {
                      aiWorking.value = $event;
                    }) satisfies EventHandler<typeof AiAssistant, "onWorking">,
                    onSummary: (($event) => {
                      values.value.description = $event;
                    }) satisfies EventHandler<typeof AiAssistant, "onSummary">,
                    onCover: applyAiCover satisfies EventHandler<
                      typeof AiAssistant,
                      "onCover"
                    >,
                    onClose: (() => {
                      aiDialog.value = undefined;
                      aiWorking.value = false;
                    }) satisfies EventHandler<typeof AiAssistant, "onClose">,
                  })
                : null,
              deleteDialog.value
                ? element(DeleteContentDialog, {
                    path: props.path,
                    title: contentLabel(body.value, values.value.title),
                    revision: revision.value,
                    unsaved: dirty.value,
                    onWorking: (($event) => {
                      busy.value = $event;
                    }) satisfies EventHandler<
                      typeof DeleteContentDialog,
                      "onWorking"
                    >,
                    onClose: (() => {
                      deleteDialog.value = false;
                    }) satisfies EventHandler<
                      typeof DeleteContentDialog,
                      "onClose"
                    >,
                    onDeleted: deleted satisfies EventHandler<
                      typeof DeleteContentDialog,
                      "onDeleted"
                    >,
                  })
                : null,
              imagePicker.value
                ? element(MediaPicker, {
                    mode: "document",
                    documentPath: props.path,
                    onSelect: insertImage satisfies EventHandler<
                      typeof MediaPicker,
                      "onSelect"
                    >,
                    onClose: (() => {
                      imagePicker.value = false;
                    }) satisfies EventHandler<typeof MediaPicker, "onClose">,
                  })
                : null,
            );
  },
  {},
);
export default DocumentEditor;
