<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import type { ContentLanguages, Json } from '../../shared/types';
import { api, errorMessage, session } from '../api';
import { t, type Message } from '../i18n';
import { contentLabel, newNote } from '../content-model';
import { retainNoteDraft, retargetNoteDraft, type NoteDraft as Draft } from '../note-session';
import { translationLocation } from '../../shared/translation';
import DocumentEditor from './DocumentEditor.vue';
import LoadingState from './LoadingState.vue';
import Icon from './Icon.vue';
const emit = defineEmits<{ dirty: [value: boolean]; saved: [path: string] }>();
const languages = ref<ContentLanguages>(), document = ref<Draft>(), editor = ref<InstanceType<typeof DocumentEditor>>();
const working = ref(false);
const dirty = ref(false), firstLanguage = ref(''), error = ref<Message>(''), host = ref<HTMLElement>();
const storageKey = `studio-note-session:${session.value?.identity.method}:${session.value?.identity.id}`;
const draftsKey = `${storageKey}:unsaved`, drafts = ref<Draft[]>([]);
function rememberDrafts() { try { localStorage.setItem(draftsKey, JSON.stringify(drafts.value)); } catch { /* The current editor backup remains available. */ } }
function keepUnsaved() {
  if (!document.value?.initial) return;
  let snapshot = dirty.value ? editor.value?.draft() : undefined;
  if (!snapshot) try {
    const backup = JSON.parse(localStorage.getItem(`studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${document.value.path}`) || 'null');
    if (backup?.values && typeof backup.body === 'string') snapshot = { initial: backup.values, initialBody: backup.body };
  } catch { /* Keep the existing draft pointer when a backup is unreadable. */ }
  if (snapshot) { drafts.value = retainNoteDraft(drafts.value, { path: document.value.path, ...snapshot }); rememberDrafts(); }
}
function remember() { try { localStorage.setItem(storageKey, JSON.stringify(document.value)); } catch { /* Editor still offers draft download. */ } }
function changed(value: boolean) { dirty.value = value; emit('dirty', value); }
function flush() { editor.value?.flush(); }
function canLeave() { if (working.value) return false; flush(); return !dirty.value || confirm(t('还有未保存的更改，确定离开吗？文章本地草稿会保留，配置表单不会自动保存。')); }
async function open(path: string, initial?: Record<string, Json>, initialBody?: string) {
  if (!canLeave()) return;
  keepUnsaved();
  if (languages.value) firstLanguage.value = translationLocation(path, languages.value.defaultLanguage, languages.value).sourceLanguage;
  document.value = { path, initial, initialBody }; remember();
  await nextTick(); host.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function create() {
  if (!languages.value || !canLeave()) return;
  keepUnsaved();
  document.value = newNote(firstLanguage.value || languages.value.defaultLanguage, languages.value.defaultLanguage); remember();
}
function changeFirstLanguage() {
  if (!languages.value || !document.value?.initial) return;
  if (!dirty.value) keepUnsaved();
  const snapshot = editor.value?.draft();
  const path = translationLocation(document.value.path, firstLanguage.value, languages.value).path;
  document.value = snapshot ? retargetNoteDraft(path, snapshot, dirty.value) : { ...document.value, path }; remember();
}
function saved(path: string) {
  drafts.value = drafts.value.filter(item => item.path !== path); rememberDrafts();
  if (document.value?.path === path) { document.value = { path }; remember(); }
  emit('saved', path);
}
function forget(path: string) {
  drafts.value = drafts.value.filter(item => item.path !== path); rememberDrafts();
  try { localStorage.removeItem(`studio-draft:${session.value?.identity.method}:${session.value?.identity.id}:${path}`); } catch { /* Optional storage. */ }
  if (document.value?.path !== path) return;
  // Suppress the old editor's unmount flush before replacing its session pointer.
  editor.value?.forget(); changed(false);
  document.value = languages.value ? newNote(firstLanguage.value || languages.value.defaultLanguage, languages.value.defaultLanguage) : undefined;
  if (document.value) remember();
  else try { localStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
}
function deleted(path: string) { forget(path); emit('saved', ''); }
async function load() {
  error.value = '';
  try {
    languages.value = await api<ContentLanguages>('/content-languages'); firstLanguage.value = languages.value.defaultLanguage;
    try {
      const pending = JSON.parse(localStorage.getItem(draftsKey) || '[]');
      if (Array.isArray(pending)) drafts.value = pending.filter(item => item?.initial && typeof item.path === 'string');
      const stored = JSON.parse(localStorage.getItem(storageKey) || 'null') as Draft | null;
      if (stored && /^content\/notes\/[a-zA-Z0-9][a-zA-Z0-9_-]*\/index(?:\.[A-Za-z0-9-]+)?\.md$/.test(stored.path)) {
        firstLanguage.value = translationLocation(stored.path, languages.value.defaultLanguage, languages.value).sourceLanguage;
        // A previous successful save may have happened before the browser recorded its response.
        const summaries = await api<{ path: string }[]>('/content');
        document.value = summaries.some(item => item.path === stored.path) ? { path: stored.path } : stored.initial ? stored : undefined;
      }
    } catch { /* Start a new session if a stored pointer is unavailable. */ }
    if (!document.value) document.value = newNote(firstLanguage.value, languages.value.defaultLanguage);
    remember();
  } catch (e) { error.value = errorMessage(e); }
}
onMounted(load);
defineExpose({ flush, open, forget, isBusy: () => working.value });
</script>
<template>
  <section ref="host" class="card note-composer" :aria-label="t('写动态')">
    <div class="composer-heading"><div><span class="composer-mark"><Icon name="pen" :size="19" /></span><h2>{{ t('写动态') }}</h2></div><div class="row">
      <label v-if="document?.initial && languages" class="composer-initial-language"><Icon name="globe" :size="15" /><span class="sr-only">{{ t('内容语言') }}</span><select v-model="firstLanguage" :disabled="working" @change="changeFirstLanguage"><option v-for="language in languages.languages" :key="language" :value="language">{{ language }}</option></select></label>
      <button v-if="document && !document.initial" class="text-button" :disabled="working" @click="create">{{ t('＋ 新动态') }}</button>
    </div></div>
    <details v-if="drafts.some(item => item.path !== document?.path)" class="composer-unsaved"><summary>{{ t('未保存的动态') }} · {{ drafts.filter(item => item.path !== document?.path).length }}</summary><div class="row"><button v-for="draft in drafts.filter(item => item.path !== document?.path)" :key="draft.path" class="secondary" @click="open(draft.path, draft.initial, draft.initialBody)">{{ contentLabel(draft.initialBody || '', draft.initial?.title) || t('无标题动态') }}</button></div></details>
    <p v-if="error" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="load">{{ t('重试') }}</button></p>
    <DocumentEditor v-if="document" ref="editor" :key="document.path" :path="document.path" :initial="document.initial" :initial-body="document.initialBody" embedded @working="working = $event" @dirty="changed" @saved="saved" @open="open" @deleted="deleted" />
    <LoadingState v-else-if="!error" label="正在载入文稿…" compact />
  </section>
</template>
