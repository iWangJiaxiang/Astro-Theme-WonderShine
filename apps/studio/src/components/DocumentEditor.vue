<script setup lang="ts">
import { richEditorBody, unsavedNoteChanged } from '../note-session';
import { createOrFindTopic } from '../topic-selection';
import { readAutosave, writeAutosave, canAutosave } from '../autosave';
import AiAssistant from './AiAssistant.vue';
import LoadingState from './LoadingState.vue';
import Icon from './Icon.vue';
import LocalizedContentContext from './LocalizedContentContext.vue';
import ArticleReferences from './ArticleReferences.vue';
import { translationLocation } from '../../shared/translation';
import { contentLabel, contentLanguage, topicOptions, type ContentLanguages } from '../content-model';
import { t, locale, translateOptions, type Message } from '../i18n';
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type Vditor from 'vditor';
import type { Article, ArticleSummary, Json, SaveResult, Settings } from '../../shared/types';
import { documentFields } from '../../shared/settings';
import { taxonomyChoices, stringValues, type Choice } from '../../shared/choices';
import { api, session, errorMessage } from '../api';
import ChoiceSelect from './ChoiceSelect.vue';
import SelectionField from './SelectionField.vue';
import FormField from './FormField.vue';
import PublicationDateField from './PublicationDateField.vue';
import { localDate } from '../../shared/form-fields';
import PageSettings from './PageSettings.vue';
import MediaPicker from './MediaPicker.vue';
import DeleteContentDialog from './DeleteContentDialog.vue';
import { markdownImage, mediaURL, storedMediaPath, type MediaItem } from '../../shared/media';
import { childLayoutChoices, pageProfile } from '../../shared/page-settings';
const props = defineProps<{ path: string; initial?: Record<string, Json>; initialBody?: string; embedded?: boolean; backLabel?: string }>();
const emit = defineEmits<{ dirty: [value: boolean]; working: [value: boolean]; back: []; deleted: [path: string]; saved: [path: string]; open: [path: string, initial?: Record<string, Json>, initialBody?: string] }>();
const body = ref(''), values = ref<Record<string, Json>>({}), baseline = ref<Record<string, Json>>({}), originalBody = ref('');
const revision = ref<string | null>(null), loading = ref(true), busy = ref(false), error = ref<Message>(''), message = ref<Message>('');
const mode = ref<'source' | 'rich' | 'preview'>('source'), editorElement = ref<HTMLDivElement>(), recovery = ref(false), ready = ref(false);
const imagePicker = ref(false), sourceElement = ref<HTMLTextAreaElement>();
const deleteDialog = ref(false);
const aiDialog = ref<'summary' | 'cover'>(), aiWorking = ref(false), aiSource = ref('');
const autosaving = ref(false);
const autosaveSeconds = ref(readAutosave(document.cookie)), autosavePaused = ref(false), autosaveLast = ref('');
let autosaveTimer: ReturnType<typeof setInterval> | undefined;
const owner = session.value?.identity.id;
function openAi(kind: 'summary' | 'cover') { flush(); aiSource.value = kind === 'summary' ? body.value : String(values.value.description || ''); aiDialog.value = kind; }
function applyAiCover(field: string, value: string) { values.value[field] = value; if (field === 'extra.global_cover') values.value['extra.cover'] = ''; }
async function autosave() {
  flush();
  if (!canAutosave({ ready: ready.value, dirty: dirty.value, busy: busy.value || translating.value || creatingTopic.value || aiWorking.value,
    blocked: forgotten || autosavePaused.value || recovery.value || !!aiDialog.value || imagePicker.value || deleteDialog.value || settingsDirty.value || aiEditPrompt.value,
    authenticated: !!session.value && session.value.identity.id === owner })) return;
  const draft = values.value.draft;
  if (!revision.value) values.value.draft = true;
  autosaving.value = true;
  try {
    if (await save()) autosaveLast.value = new Date().toLocaleTimeString(locale.value, { hour: '2-digit', minute: '2-digit' });
    else { if (!revision.value) values.value.draft = draft; autosavePaused.value = true; }
  } finally { autosaving.value = false; }
}
function scheduleAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = autosaveSeconds.value ? setInterval(() => { void autosave(); }, autosaveSeconds.value * 1000) : undefined;
}
watch(autosaveSeconds, value => { document.cookie = writeAutosave(value, location.protocol === 'https:'); autosavePaused.value = false; scheduleAutosave(); });
onMounted(scheduleAutosave);
onBeforeUnmount(() => { if (autosaveTimer) clearInterval(autosaveTimer); });
let forgotten = false;
let imageCursor = { start: 0, end: 0 };
function chooseImage() {
  flush(); imageCursor = { start: sourceElement.value?.selectionStart ?? body.value.length, end: sourceElement.value?.selectionEnd ?? body.value.length }; imagePicker.value = true;
}
async function insertImage(item: MediaItem, value: string) {
  const snippet = '\n' + markdownImage(item, value) + '\n';
  body.value = body.value.slice(0, imageCursor.start) + snippet + body.value.slice(imageCursor.end);
  imagePicker.value = false; await nextTick();
  sourceElement.value?.focus(); sourceElement.value?.setSelectionRange(imageCursor.start + snippet.length, imageCursor.start + snippet.length);
}
const choices = ref<Record<string, Choice[]>>({}), choicesLoading = ref(true), choicesError = ref<Message>('');
const isNote = props.path.startsWith('content/notes/');
const isTopic = props.path.startsWith('content/topics/');
const isLocalized = isNote || isTopic;
const supportsTranslation = /^content\/(articles|pages|collections|notes|topics)\//.test(props.path);
const noteAdvanced = ref(false), translating = ref(false), creatingTopic = ref(false);
watch([busy, translating, creatingTopic, aiWorking], ([saving, generating, creating, assisting]) => emit('working', saving || generating || creating || assisting), { flush: 'sync' });
const isCollection = props.path.startsWith('content/collections/');
const isSection = /\/_index(?:\.[^.]+)?\.md$/.test(props.path);
const supportsTopics = isNote || props.path.startsWith('content/articles/') || (isCollection && !isSection);
const topicItems = ref<ArticleSummary[]>([]), documentLanguage = ref('');
function topicChoice(item: ArticleSummary): Choice {
  return { value: item.id!, label: [item.title || item.id, item.lang, item.lang !== documentLanguage.value ? t('缺少 {language} 译文', { language: documentLanguage.value }) : '', item.draft ? t('草稿') : ''].filter(Boolean).join(' · '),
    searchTerms: topicItems.value.filter(topic => topic.kind === 'topic' && topic.id === item.id && !topic.error).map(topic => topic.title) };
}
const topicChoices = computed(() => topicOptions(topicItems.value, documentLanguage.value).map(topicChoice));
async function createTopic(title: string): Promise<Choice> {
  creatingTopic.value = true;
  try {
    const result = await createOrFindTopic(title, documentLanguage.value, {
      list: () => api<ArticleSummary[]>('/content?refresh=1'), languages: () => api<ContentLanguages>('/content-languages'),
      save: input => api<SaveResult>('/document', 'PUT', input),
    });
    if (alive) topicItems.value = result.items;
    return topicChoice(result.item);
  } finally { creatingTopic.value = false; }
}
const topicSelection = computed(() => ({ createOption: createTopic, createLabel: '创建并选中「{title}」',
  createHint: t('新话题以 {language} 保存为草稿，确认选择后关联到当前内容。', { language: documentLanguage.value }),
  createdHint: t('话题已选中，请确认关联。已保存的话题草稿不会因取消而删除。'),
  searchPlaceholder: t('搜索话题，或输入新话题名称…') }));
const isPage = props.path.startsWith('content/pages/') && !isSection;
const pageTab = ref<'content' | 'settings'>('content'), settingsOpened = ref(false), settingsDirty = ref(false);
const savedTemplate = computed(() => String(baseline.value.layout || 'empty'));
const templateChanged = computed(() => !!revision.value && String(values.value.layout || 'empty') !== savedTemplate.value);
function showPageSettings() { if (busy.value) return; flush(); pageTab.value = 'settings'; settingsOpened.value = true; }
const visibleFields = computed(() => documentFields.filter(field => !['title', 'description', 'draft'].includes(field.path)
  && !['extra.kind', 'extra.id', 'extra.topics', 'extra.ai_translation', 'extra.translation_reviewed', 'extra.translation_source', 'extra.references'].includes(field.path)
  && (!isTopic || field.path === 'extra.cover')
  && (!isNote || ['date', 'taxonomies.tags', 'extra.disable_comment'].includes(field.path))
  && (!isPage || ['path', 'layout', 'extra.disable_comment'].includes(field.path))
  && (isCollection || field.path !== 'extra.tags') && (isSection || !['child_layout', 'render', 'insert_anchor_links'].includes(field.path))));
const fixedChoices: Record<string, Choice[]> = {
  layout: ['post', 'empty', 'about', 'friends', 'music', 'equipment', 'wechat', 'archives', 'collection-list', 'collection-detail', 'collection-content', 'collection-category'].map((name, index) => ({ value: name, label: ['文章', '普通页面', '关于', '友链', '音乐', '装备', '微信', '归档', '合集分组', '系列 / 专辑详情', '章节 / 曲目', '合集分类'][index] })),
  child_layout: [{ value: 'collection-content', label: '章节 / 曲目' }, { value: 'post', label: '文章' }, { value: 'empty', label: '普通页面' }],
  insert_anchor_links: [{ value: 'none', label: '不显示' }, { value: 'left', label: '标题左侧' }, { value: 'right', label: '标题右侧' }, { value: 'heading', label: '整个标题' }],
};
function selectOptions(path: string): Choice[] {
  const options = isPage && path === 'layout' ? childLayoutChoices : fixedChoices[path] || [], value = String(values.value[path] ?? '');
  return translateOptions(options.filter(option => option.value !== ''));
}
async function loadChoices() {
  choicesLoading.value = true; choicesError.value = '';
  try {
    const [items, languages] = await Promise.all([api<ArticleSummary[]>('/content'), api<ContentLanguages>('/content-languages')]);
    topicItems.value = items; documentLanguage.value = translationLocation(props.path, languages.defaultLanguage, languages).sourceLanguage;
    const settings = await api<Settings>(`/settings/taxonomies?language=${encodeURIComponent(documentLanguage.value)}`);
    const tags = taxonomyChoices(settings.values['post.tags'], items.flatMap(item => item.tags));
    choices.value = {
      'taxonomies.tags': tags,
      'taxonomies.categories': taxonomyChoices(settings.values['post.categories'], items.flatMap(item => item.categories)),
      // Display tags are literal labels in collection templates, unlike taxonomy IDs.
      'extra.tags': taxonomyChoices(undefined, [...tags.map(tag => tag.label), ...items.flatMap(item => stringValues(item.displayTags))]),
    };
  } catch (e) { choicesError.value = errorMessage(e); }
  finally { choicesLoading.value = false; }
}
let editor: Vditor | undefined, alive = true, generation = 0, richReady = false;
const storageKey = `studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${props.path}`;
const shortcode = computed(() => /\{%|\{\{/.test(body.value));
const changes = computed(() => Object.fromEntries(Object.entries(values.value).filter(([key, value]) => documentFields.some(field => field.path === key) && !(isTopic && ['date', 'updated'].includes(key)) && JSON.stringify(value) !== JSON.stringify(baseline.value[key]))));
const pristineValues = ref('');
const dirty = computed(() => !revision.value && props.embedded
  ? unsavedNoteChanged(props.initialBody, body.value, values.value, pristineValues.value)
  : body.value !== originalBody.value || Object.keys(changes.value).length > 0);
const aiEditPrompt = ref(false), aiChoiceMade = ref(false);
const trackedTranslation = computed(() => !!values.value['extra.translation_source'] || values.value['extra.ai_translation'] === true || values.value['extra.translation_reviewed'] === false);
watch([body, () => values.value.title, () => values.value.description], () => {
  if (!ready.value || !trackedTranslation.value) return;
  values.value['extra.translation_reviewed'] = false;
  if (values.value['extra.ai_translation'] === true && !aiChoiceMade.value) aiEditPrompt.value = true;
}, { flush: 'sync' });
watch(() => values.value['extra.ai_translation'], (value, old) => {
  if (ready.value && value === true && old !== true) values.value['extra.translation_reviewed'] = false;
}, { flush: 'sync' });
function chooseAiLabel(keep: boolean) { values.value['extra.ai_translation'] = keep; aiEditPrompt.value = false; aiChoiceMade.value = true; }
function reviewTranslation() { flush(); values.value['extra.translation_reviewed'] = true; }
const preview = computed(() => {
  const parsed = new DOMParser().parseFromString(DOMPurify.sanitize(marked.parse(body.value, { async: false }) as string), 'text/html');
  for (const image of parsed.querySelectorAll('img')) {
    try { const path = storedMediaPath(decodeURIComponent(image.getAttribute('src') || ''), 'document', props.path); if (path) image.setAttribute('src', mediaURL(path)); } catch { /* Preserve unrecognized URLs. */ }
  }
  return parsed.body.innerHTML;
});
const wordCount = computed(() => body.value.replace(/\s/g, '').length);
const get = (data: Record<string, Json>, path: string): Json | undefined => path.split('.').reduce<any>((value, key) => value && typeof value === 'object' ? value[key] : undefined, data);
function snapshot() { return JSON.stringify({ body: body.value, values: values.value, revision: revision.value, baseline: baseline.value, originalBody: originalBody.value, aiChoiceMade: aiChoiceMade.value, aiEditPrompt: aiEditPrompt.value }); }
watch([dirty, settingsDirty], ([documentDirty, configurationDirty]) => emit('dirty', documentDirty || configurationDirty), { flush: 'sync' });
watch([body, values], () => { if (forgotten || !ready.value || !dirty.value) return; try { localStorage.setItem(storageKey, snapshot()); } catch { message.value = '浏览器草稿备份不可用，请及时保存或下载。'; } }, { deep: true });
async function loadDocument() {
  loading.value = true; error.value = ''; ready.value = false;
  void loadChoices();
  try {
    if (props.initial) {
      body.value = props.initialBody || '';
      baseline.value = Object.fromEntries(documentFields.filter(field => field.path !== 'date').map(field => [field.path, structuredClone(field.default)]));
      values.value = { ...JSON.parse(JSON.stringify(baseline.value)), ...(!isSection && !isTopic ? { date: localDate() } : {}), ...props.initial };
    }
    else {
      const doc = await api<Article>(`/document?path=${encodeURIComponent(props.path)}`);
      body.value = doc.body; originalBody.value = doc.body; revision.value = doc.revision;
      values.value = Object.fromEntries(documentFields.map(field => [field.path, get(doc.metadata, field.path) ?? (field.path === 'draft' ? false : field.default)]));
      baseline.value = JSON.parse(JSON.stringify(values.value));
    }
    pristineValues.value = JSON.stringify(values.value);
    try { recovery.value = !!localStorage.getItem(storageKey); } catch { /* Storage can be disabled. */ }
  } catch (e) { error.value = errorMessage(e); }
  finally { loading.value = false; await nextTick(); ready.value = !error.value; }
}
onMounted(loadDocument);
function restore() {
  if (settingsDirty.value) { error.value = '页面设置还有未保存的更改，请先保存或放弃这些设置，再恢复正文草稿'; return; }
  try {
    const draft = JSON.parse(localStorage.getItem(storageKey) || 'null');
    if (!draft || typeof draft.body !== 'string' || !draft.values) throw new Error('本地草稿格式不正确');
    destroyEditor(false); mode.value = 'source';
    aiChoiceMade.value = draft.aiChoiceMade === true;
    aiEditPrompt.value = draft.aiEditPrompt === true;
    body.value = draft.body; values.value = draft.values;
    // Preserve the saved revision: stale recovered drafts must conflict, never overwrite a newer file.
    revision.value = draft.revision; baseline.value = draft.baseline; originalBody.value = draft.originalBody;
    recovery.value = false; message.value = '已恢复本地草稿；保存时仍会检查仓库版本。';
  } catch (e) { error.value = errorMessage(e); }
}
function discardBackup() { try { localStorage.removeItem(storageKey); } catch { /* Optional local storage. */ } recovery.value = false; }
function flush() {
  if (forgotten) return;
  if (editor && richReady) body.value = richEditorBody(body.value, editor.getValue());
  if (ready.value && dirty.value) try { localStorage.setItem(storageKey, snapshot()); } catch { /* Optional local backup. */ }
}
function destroyEditor(sync = true) {
  if (sync) flush();
  generation++; richReady = false;
  const old = editor; editor = undefined; old?.destroy();
}
function readRichSoon() { queueMicrotask(flush); }
function forget() { forgotten = true; destroyEditor(false); discardBackup(); emit('dirty', false); }
defineExpose({ flush, forget, isBusy: () => busy.value || translating.value || creatingTopic.value || aiWorking.value, draft: () => { flush(); return { initial: JSON.parse(JSON.stringify(values.value)) as Record<string, Json>, initialBody: body.value }; } });
async function changeMode(next: typeof mode.value) {
  destroyEditor(); mode.value = next;
  const instance = generation;
  if (next !== 'rich') return;
  if (shortcode.value) { mode.value = 'source'; return; }
  try {
    const { default: Vditor } = await import('vditor'); await nextTick();
    if (!alive || instance !== generation || mode.value !== 'rich' || !editorElement.value) return;
    editor = new Vditor(editorElement.value, { cdn: `${location.origin}/vendor/vditor`, mode: 'ir', value: body.value, height: props.embedded ? 180 : isNote ? 360 : 560, lang: locale.value === 'zh-CN' ? 'zh_CN' : 'en_US',
      cache: { enable: false }, counter: { enable: false }, theme: window.document.documentElement.dataset.theme === 'dark' ? 'dark' : 'classic',
      preview: { markdown: { toc: false, sanitize: true }, hljs: { enable: false }, math: { engine: 'KaTeX' } },
      toolbar: ['headings', 'bold', 'italic', 'strike', '|', 'list', 'ordered-list', 'check', '|', 'quote', 'code', 'inline-code', 'link', 'table', '|', 'undo', 'redo'],
      input: value => { if (alive && generation === instance && richReady) body.value = richEditorBody(body.value, value); }, after: () => { if (generation === instance) richReady = true; } });
  } catch (e) { error.value = errorMessage(e); mode.value = 'source'; }
}
async function saveLocalized(draft: boolean) {
  if (busy.value || creatingTopic.value) return;
  const previous = values.value.draft; values.value.draft = draft;
  if (!await save()) values.value.draft = previous;
}
async function save(): Promise<boolean> {
  if (forgotten || busy.value || translating.value || creatingTopic.value || aiWorking.value) return false;
  flush();
  if (isNote && !body.value.trim() && !String(values.value.title || '').trim() && !(Array.isArray(values.value['extra.references']) && values.value['extra.references'].length)) { error.value = '请填写动态正文、标题或引用文章'; return false; }
  if (aiEditPrompt.value) { error.value = '请先选择是否保留 AI 翻译标识'; return false; }
  if (trackedTranslation.value && values.value.draft === false && values.value['extra.translation_reviewed'] !== true) { error.value = '请先审核译文，再发布内容'; return false; }
  if (settingsDirty.value) {
    const groups = (layout: string, content: string) => pageProfile(layout, content).groups.map(group => group.id).join(',');
    if (groups(String(values.value.layout || 'empty'), body.value) !== groups(savedTemplate.value, originalBody.value)) {
      error.value = '这次正文修改会改变页面配置入口，请先保存或放弃页面设置，再保存正文'; return false;
    }
  }
  busy.value = true; error.value = ''; message.value = '';
  const submittedBody = body.value, submittedValues = JSON.parse(JSON.stringify(values.value));
  try {
    const result = await api<SaveResult>('/document', 'PUT', { path: props.path, body: submittedBody, changes: { ...changes.value, ...(trackedTranslation.value ? { 'extra.translation_reviewed': values.value['extra.translation_reviewed'] === true } : {}) }, revision: revision.value });
    autosavePaused.value = false; revision.value = result.revision; baseline.value = submittedValues; originalBody.value = submittedBody; message.value = result.message;
    if (isTopic) {
      try {
        const saved = await api<Article>(`/document?path=${encodeURIComponent(props.path)}`);
        for (const key of ['date', 'updated']) { values.value[key] = saved.metadata[key] || ''; baseline.value[key] = values.value[key]; }
      } catch { message.value = '内容已保存，但时间信息刷新失败。重新打开可查看。'; }
    }
    if (!dirty.value) { discardBackup(); aiChoiceMade.value = false; } else try { localStorage.setItem(storageKey, snapshot()); } catch { /* Optional local storage. */ }
    emit('saved', props.path);
    return true;
  } catch (e) { error.value = errorMessage(e); return false; }
  finally { busy.value = false; }
}
function remove() { if (!revision.value || busy.value || translating.value || settingsDirty.value) return; flush(); deleteDialog.value = true; }
function deleted(path: string) { forget(); deleteDialog.value = false; busy.value = false; emit('deleted', path); emit('back'); }
function download() {
  flush();
  const blob = new Blob([JSON.stringify({ path: props.path, metadata: values.value, body: body.value }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = 'studio-draft.json'; link.click(); URL.revokeObjectURL(url);
}
watch(locale, () => { if (mode.value === 'rich') void changeMode('rich'); });
onBeforeUnmount(() => { flush(); alive = false; destroyEditor(false); emit('dirty', false); });
</script>
<template>
  <LoadingState v-if="loading" label="正在载入文稿…" />
  <div v-else-if="!ready" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="loadDocument">{{ t("重试") }}</button> <button class="text-button" @click="emit('back')">{{ t(backLabel || "← 返回内容库") }}</button></div>
  <section v-else class="editor-page" :class="{ 'note-editor': isNote, 'embedded-editor': embedded }"><div v-if="!embedded" class="page-heading"><div><button class="text-button" @click="emit('back')">{{ t(backLabel || "← 返回内容库") }}</button><h1>{{ isNote ? contentLabel(body, values.title) || t("新动态") : values.title || t("未命名内容") }}</h1><p class="muted path-label">{{ t("文件位置") }}：{{ path }}</p></div><div class="row editor-save-actions"><label class="autosave-control"><span>{{ t('自动保存') }}</span><select v-model="autosaveSeconds" :aria-label="t('自动保存间隔')"><option :value="0">{{ t('关闭') }}</option><option :value="30">{{ t('每 30 秒') }}</option><option :value="300">{{ t('每 5 分钟') }}</option><option :value="1800">{{ t('每 30 分钟') }}</option></select></label><button v-if="revision" class="secondary danger" :disabled="busy || translating || settingsDirty" @click="remove">{{ t("删除当前语言版本") }}</button><button class="secondary" @click="download">{{ t("下载备份") }}</button><template v-if="isLocalized"><button class="secondary" :disabled="busy || (!dirty && values.draft === true)" @click="saveLocalized(true)">{{ t(values.draft === false ? "转为草稿" : "保存草稿") }}</button><button class="primary" :disabled="busy || (!dirty && values.draft === false)" @click="saveLocalized(false)">{{ busy ? t("正在保存…") : t(values.draft === false ? "保存已发布内容" : isTopic ? "发布话题" : "发布动态") }}</button></template><button v-else class="primary" :disabled="busy || !dirty" @click="save">{{ busy ? t("正在保存…") : t("保存内容") }}</button></div></div>
    <p v-if="autosaveSeconds" class="autosave-status" role="status">{{ autosavePaused ? t("自动保存已暂停，请检查错误后手动保存或重新选择间隔。") : autosaveLast ? t("自动保存于 {time}", { time: autosaveLast }) : t("自动保存已开启；新内容首次保存为草稿。") }}</p><p v-if="error" class="notice error" role="alert">{{ t(error) }} {{ t("编辑内容已保留。如有版本冲突，请先下载备份，再重新打开文件合并。") }}</p><p v-if="message" class="notice success" role="status">{{ t(message) }}</p>
    <div v-if="recovery" class="notice row" :class="{ 'composer-recovery': embedded }" role="status">{{ t("发现本地草稿备份。") }}<button class="text-button" @click="restore">{{ t("恢复草稿") }}</button><button class="text-button" @click="discardBackup">{{ t("丢弃备份") }}</button></div>
    <LocalizedContentContext @working="translating = $event" v-if="supportsTranslation && (!embedded || revision)" :kind="isTopic ? 'topic' : isNote ? 'note' : isCollection ? 'collection' : isPage ? 'page' : 'article'" :path="path" :revision="revision" :dirty="dirty" :busy="busy" @open="(path, initial, initialBody) => emit('open', path, initial, initialBody)" />
    <div v-if="isPage" class="page-editor-tabs"><button :class="{ active: pageTab === 'content' }" @click="pageTab = 'content'">{{ t("正文与属性") }}</button><button :class="{ active: pageTab === 'settings' }" :disabled="busy" @click="showPageSettings">{{ t("页面设置") }}<span v-if="settingsDirty" :aria-label="t('未保存')"> ·</span></button></div>
    <div v-if="isPage && settingsOpened" v-show="pageTab === 'settings'" class="page-settings-pane" :inert="busy"><p v-if="!revision || templateChanged" class="notice">{{ t("请先保存页面内容与模板，再编辑对应的页面设置。") }}</p><PageSettings v-else-if="documentLanguage" :key="savedTemplate" :layout="savedTemplate" :body="originalBody" :language="documentLanguage" @dirty="settingsDirty = $event" /><p v-else class="notice">{{ t("正在确认内容语言，确认后可编辑页面设置。") }} <button class="text-button" @click="loadChoices">{{ t("重试") }}</button></p></div>
    <p v-if="isPage && pageTab === 'content'" class="editor-hint">{{ t(pageProfile(String(values.layout || ''), body).description) }}</p>
    <p v-if="isLocalized && !embedded" class="editor-hint">{{ t("保存写入仓库，完成网站构建与部署后才会上线。") }}</p>
    <p v-if="isLocalized && initialBody !== undefined && !revision" class="notice">{{ t("这是译文草稿，已复制原文。请完成翻译后再发布。") }}</p>
    <div v-show="!isPage || pageTab === 'content'" class="editor-layout" :inert="busy && !autosaving"><div class="card writing-card"><label v-if="!isNote" class="field field-inline title-field"><span>{{ t("标题") }}</span><input v-model="values.title" :required="isTopic" :placeholder="t('为这篇内容写一个标题…')" /></label><div v-if="!isNote" class="field summary-field"><div class="summary-heading"><label for="article-description">{{ t("摘要") }}</label><button type="button" class="text-button ai-action" :disabled="busy || !body.trim() || !documentLanguage" @click="openAi('summary')">✦ {{ t("AI 摘要") }}</button></div><textarea id="article-description" :value="String(values.description ?? '')" @input="values.description = ($event.target as HTMLTextAreaElement).value" rows="3" :placeholder="t('用一两句话介绍这篇内容')" /></div>
      <div class="editor-tabs" :class="{ 'composer-mode-tabs': embedded }"><button :class="{ active: mode === 'source' }" @click="changeMode('source')">{{ t("Markdown 源码") }}</button><button :disabled="shortcode" :class="{ active: mode === 'rich' }" @click="changeMode('rich')">{{ t("可视化编辑") }}</button><button :class="{ active: mode === 'preview' }" @click="changeMode('preview')">{{ t("正文预览") }}</button><button v-if="!embedded" :disabled="busy || mode !== 'source'" :title="mode !== 'source' ? t('切换到 Markdown 源码后插入图片') : t('从仓库选择图片插入正文')" @click="chooseImage">{{ t("插入图片") }}</button><span class="muted small">{{ t("{count} 字符", { count: wordCount }) }}</span></div>
      <p v-if="shortcode" class="editor-hint">{{ t("包含 shortcode，使用源码编辑以保留原始结构。") }}</p>
      <textarea v-if="mode === 'source'" ref="sourceElement" v-model="body" class="markdown-source" :aria-label="t('Markdown 正文')" :placeholder="t(embedded ? '此刻，有什么想分享？' : '从这里开始书写…')" spellcheck="false" />
      <div v-else-if="mode === 'rich'" ref="editorElement" @input="readRichSoon" @click="readRichSoon" />
      <div v-else><p class="editor-hint">{{ t("这里只预览 Markdown；shortcode 和主题页面请在 Astro 网站预览中查看。") }}</p><article class="markdown-preview" v-html="preview" /></div>
      <ArticleReferences v-if="isNote && !embedded" v-model="values['extra.references']" :items="topicItems" :language="documentLanguage" :disabled="busy || choicesLoading" />
      <div class="list-footer">{{ dirty ? t("有未保存的更改 · 已在此浏览器备份") : t(revision ? "已保存" : "尚未保存") }}</div>
    </div><aside v-show="!embedded || noteAdvanced || trackedTranslation" class="editor-aside"><div class="card metadata-card" :class="{ 'note-properties-panel': embedded }"><h2 v-if="!embedded">{{ t("内容属性") }}</h2><label v-if="!isLocalized" class="field checkbox-field"><input v-model="values.draft" type="checkbox" :disabled="busy" />{{ t("保留为草稿") }}</label><p v-if="!isLocalized" class="muted small">{{ t("取消草稿并保存后，由网站构建流程决定何时上线。") }}</p><template v-else-if="!embedded"><span class="badge" :class="{ draft: values.draft }">{{ t(values.draft ? "草稿" : "已发布") }}</span><button v-if="isNote && !embedded" class="text-button note-advanced" :aria-expanded="noteAdvanced" @click="noteAdvanced = !noteAdvanced">{{ t("更多属性") }}</button><label v-if="isNote && noteAdvanced" class="field field-inline"><span>{{ t("标题（可选）") }}</span><input v-model="values.title" /></label></template>
      <template v-if="embedded">
        <div class="note-properties-heading"><h3>{{ t('发布设置') }}</h3><span class="note-properties-state" :class="{ draft: values.draft }"><i aria-hidden="true"></i>{{ t(values.draft ? '草稿' : '已发布') }}</span><button type="button" class="text-button" :aria-expanded="noteAdvanced" @click="noteAdvanced = !noteAdvanced">{{ t(noteAdvanced ? '收起设置' : '展开设置') }}<span aria-hidden="true">{{ noteAdvanced ? '⌃' : '⌄' }}</span></button></div>
        <div v-show="noteAdvanced" class="note-properties-fields">
          <label class="field field-inline note-title-field"><span>{{ t('标题') }}</span><input v-model="values.title" :placeholder="t('可选，给这条动态起个标题')" /></label>
          <PublicationDateField v-model="values.date" :disabled="busy" />
        </div>
        <div v-show="noteAdvanced" class="note-properties-switches">
          <label class="field checkbox-field form-switch note-property-toggle"><input type="checkbox" role="switch" :aria-label="t('允许评论')" :checked="!values['extra.disable_comment']" @change="values['extra.disable_comment'] = !($event.target as HTMLInputElement).checked" /><span>{{ t('允许评论') }}<em :class="{ enabled: !values['extra.disable_comment'] }" aria-hidden="true">{{ t(values['extra.disable_comment'] ? '已关闭' : '已开启') }}</em></span></label>
          <label class="field checkbox-field form-switch note-property-toggle"><input v-model="values['extra.ai_translation']" type="checkbox" role="switch" :aria-label="t('AI 翻译')" /><span>{{ t('AI 翻译') }}<em :class="{ enabled: values['extra.ai_translation'] }" aria-hidden="true">{{ t(values['extra.ai_translation'] ? '已标注' : '未标注') }}</em></span></label>
        </div>
      </template>
      <template v-if="supportsTranslation"><label v-if="!embedded" class="field checkbox-field form-switch"><input v-model="values['extra.ai_translation']" type="checkbox" role="switch" /><span>{{ t('AI 翻译') }}</span></label>
        <p v-if="values['extra.ai_translation'] && !embedded" class="muted small">{{ t('公开页面会标注 AI 翻译，帮助读者识别。') }}</p>
        <div v-if="aiEditPrompt" class="notice ai-review" role="status"><p>{{ t('你已修改 AI 译文，是否保留 AI 翻译标识？') }}</p><div class="row"><button class="text-button" @click="chooseAiLabel(true)">{{ t('保留 AI 标识') }}</button><button class="text-button" @click="chooseAiLabel(false)">{{ t('取消 AI 标识') }}</button></div></div>
        <div v-if="trackedTranslation" class="ai-review"><span class="badge" :class="{ draft: !values['extra.translation_reviewed'] }">{{ t(values['extra.translation_reviewed'] ? '译文已审核' : '译文待审核') }}</span><button v-if="!values['extra.translation_reviewed']" class="text-button" :disabled="aiEditPrompt || busy" @click="reviewTranslation">{{ t('确认已审核译文') }}</button><p class="muted small">{{ t('请检查准确性与格式；修改译文后需要重新审核。') }}</p></div>
      </template>
      <p v-if="choicesError" class="notice error" role="alert">{{ t("选项载入失败：") }}{{ t(choicesError) }} <button class="text-button" @click="loadChoices">{{ t("重试选项") }}</button></p>
      <div v-if="isTopic" class="topic-timestamps"><p><span>{{ t('创建时间') }}</span><time>{{ values.date || t('首次保存后生成') }}</time></p><p><span>{{ t('资料更新时间') }}</span><time>{{ values.updated || t('首次保存后生成') }}</time></p><p class="muted small">{{ t('时间由系统维护。修改话题资料不会提高话题的内容活跃时间。') }}</p></div>
      <SelectionField v-if="supportsTopics && !embedded" v-bind="topicSelection" multiple :model-value="values['extra.topics'] || []" :options="topicChoices" :disabled="busy || choicesLoading || !!choicesError" name="extra.topics" :label="t('关联话题')" :hint="t('话题独立于标签和分类。可关联草稿或未翻译的话题；公开页面只显示已发布的当前语言版本。')" @update:model-value="values['extra.topics'] = $event" />
      <template v-for="field in (isNote && !noteAdvanced ? [] : visibleFields.filter(field => !embedded || !['taxonomies.tags', 'date', 'extra.disable_comment'].includes(field.path)))" :key="field.path">
        <ChoiceSelect v-if="field.kind === 'structured'" :model-value="values[field.path] ?? field.default" :options="choices[field.path] || []" :disabled="choicesLoading" :name="field.path" :label="t(field.label)" :hint="t('可多选；新增名称请前往「标签与分类」。')" @update:model-value="values[field.path] = $event" />
        <SelectionField v-else-if="fixedChoices[field.path]" :model-value="values[field.path]" :options="selectOptions(field.path)" :name="field.path" :label="t(field.label)" :disabled="field.path === 'layout' && settingsDirty" :hint="field.path === 'layout' && settingsDirty ? t('请先保存页面设置，再更换模板。') : !values[field.path] ? t('留空时使用站点默认设置。') : undefined" @update:model-value="values[field.path] = $event" />
        <PublicationDateField v-else-if="isNote && field.path === 'date'" v-model="values.date" :disabled="busy" />
        <FormField v-else v-model="values[field.path]" :name="field.path" :label="isTopic && field.path === 'extra.cover' ? t('话题封面') : t(field.label)" :kind="field.kind" :hint="t(field.hint)" :document-path="path" :required="field.path === 'date' && !isSection && !isPage" />
        <button v-if="field.path === 'extra.cover' && !isTopic" type="button" class="secondary ai-cover-action" :disabled="busy || !String(values.description || '').trim() || !documentLanguage" :title="!String(values.description || '').trim() ? t('请先填写或生成摘要') : undefined" @click="openAi('cover')">✦ {{ t('AI 生成封面') }}</button>
      </template>
    </div></aside></div>
    <div v-if="embedded" class="composer-footer">
      <div class="composer-tools" :aria-label="t('动态设置')">
        <button class="composer-tool" :disabled="busy || mode !== 'source'" :title="mode !== 'source' ? t('切换到 Markdown 源码后插入图片') : t('从仓库选择图片插入正文')" @click="chooseImage"><Icon name="image" :size="17" />{{ t('插入图片') }}</button>
        <ChoiceSelect compact icon="tag" :model-value="values['taxonomies.tags'] || []" :options="choices['taxonomies.tags'] || []" :disabled="busy || choicesLoading" name="taxonomies.tags" :label="t('标签')" @update:model-value="values['taxonomies.tags'] = $event" />
        <SelectionField v-bind="topicSelection" multiple compact icon="hash" :model-value="values['extra.topics'] || []" :options="topicChoices" :disabled="busy || choicesLoading || !!choicesError" name="extra.topics" :label="t('关联话题')" @update:model-value="values['extra.topics'] = $event" />
        <ArticleReferences compact v-model="values['extra.references']" :items="topicItems" :language="documentLanguage" :disabled="busy || choicesLoading" />
        <button class="composer-tool" :aria-expanded="noteAdvanced" @click="noteAdvanced = !noteAdvanced"><Icon name="sliders" :size="16" />{{ t(noteAdvanced ? '收起设置' : '发布设置') }}</button>
      </div>
      <div class="composer-publish"><label class="autosave-control"><span>{{ t('自动保存') }}</span><select v-model="autosaveSeconds" :aria-label="t('自动保存间隔')"><option :value="0">{{ t('关闭') }}</option><option :value="30">{{ t('每 30 秒') }}</option><option :value="300">{{ t('每 5 分钟') }}</option><option :value="1800">{{ t('每 30 分钟') }}</option></select></label><button class="text-button composer-save" :disabled="busy || (!dirty && values.draft === true)" @click="saveLocalized(true)">{{ t(values.draft === false ? '转为草稿' : '保存草稿') }}</button><button class="primary" :disabled="busy || (!dirty && values.draft === false)" @click="saveLocalized(false)">{{ busy ? t('正在保存…') : t(values.draft === false ? '保存已发布内容' : '发布动态') }}<Icon name="arrow" :size="16" /></button></div>
    </div>
    <div v-if="embedded && noteAdvanced" class="composer-secondary-actions"><span class="muted small">{{ dirty ? t('有未保存的更改 · 已在此浏览器备份') : t(revision ? '已保存' : '尚未保存') }}</span><button class="text-button" @click="download">{{ t('下载备份') }}</button><button v-if="revision" class="text-button danger" :disabled="busy || translating" @click="remove">{{ t('删除当前语言版本') }}</button><details class="composer-file"><summary>{{ t('文件位置') }}</summary><p class="muted path-label">{{ t('文件位置') }}：{{ path }}</p></details></div>
    <AiAssistant v-if="aiDialog" :kind="aiDialog" :title="String(values.title || '')" :text="aiSource" :language="documentLanguage" :path="path" @working="aiWorking = $event" @summary="values.description = $event" @cover="applyAiCover" @close="aiDialog = undefined; aiWorking = false" />
    <DeleteContentDialog v-if="deleteDialog" :path="path" :title="contentLabel(body, values.title)" :revision="revision" :unsaved="dirty" @working="busy = $event" @close="deleteDialog = false" @deleted="deleted" />
    <MediaPicker v-if="imagePicker" mode="document" :document-path="path" @select="insertImage" @close="imagePicker = false" />
  </section>
</template>
