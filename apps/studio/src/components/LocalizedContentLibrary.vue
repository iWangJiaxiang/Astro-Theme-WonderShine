<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { ArticleSummary, Json } from '../../shared/types';
import { api, errorMessage } from '../api';
import { t, locale, type Message } from '../i18n';
import { newNote, newTopic, unclassifiedContentErrors, type ContentLanguages, type LocalizedKind } from '../content-model';
import { isLibraryItem } from '../../shared/library';
import NoteComposer from './NoteComposer.vue';
import LoadingState from './LoadingState.vue';
import SelectionField from './SelectionField.vue';
import Icon from './Icon.vue';
import DeleteContentDialog from './DeleteContentDialog.vue';
import '../note-detail.css';
const props = defineProps<{ kind: LocalizedKind }>();
const emit = defineEmits<{ open: [path: string]; create: [path: string, initial: Record<string, Json>]; dirty: [value: boolean]; deleted: [path: string] }>();
const composer = ref<InstanceType<typeof NoteComposer>>();
const pendingDelete = ref<ArticleSummary>(), deleting = ref(false), composerDirty = ref(false);
function openItem(path: string) { emit('open', path); }
function changed(value: boolean) { composerDirty.value = value; emit('dirty', value); }
async function deleted(path: string) { pendingDelete.value = undefined; await composer.value?.forget(path); emit('deleted', path); await load(); }
defineExpose({ flush: () => composer.value?.flush(), isBusy: () => deleting.value || composer.value?.isBusy() || false });
const items = ref<ArticleSummary[]>([]), languages = ref<ContentLanguages>(), language = ref(''), search = ref(''), status = ref('all');
const loading = ref(true), error = ref<Message>(''), page = ref(1);
const unclassified = computed(() => unclassifiedContentErrors(items.value, props.kind));
const filtered = computed(() => items.value.filter(item => item.lang === language.value &&
  [item.title, item.description, ...item.tags].join(' ').toLowerCase().includes(search.value.trim().toLowerCase()) &&
  (status.value === 'all' || (status.value === 'draft' ? item.draft : !item.draft && !item.error)))
  .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || a.path.localeCompare(b.path)));
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)));
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20));
watch([language, status, search], () => { page.value = 1; });
async function load(refresh = false) {
  loading.value = true; error.value = '';
  try {
    const [content, config] = await Promise.all([api<ArticleSummary[]>(`/content${refresh ? '?refresh=1' : ''}`), api<ContentLanguages>('/content-languages')]);
    items.value = content.filter(item => item.kind === props.kind && isLibraryItem(item)); languages.value = config;
    if (!config.languages.includes(language.value)) language.value = config.defaultLanguage;
    page.value = Math.min(page.value, pages.value);
  } catch (e) { error.value = errorMessage(e); } finally { loading.value = false; }
}
function displayDate(value: string) {
  const date = new Date(value);
  return !value ? '—' : Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', ...(value.includes('T') ? { timeStyle: 'short' as const } : {}) }).format(date);
}
function create() {
  if (!languages.value) return;
  const draft = (props.kind === 'topic' ? newTopic : newNote)(language.value, languages.value.defaultLanguage);
  emit('create', draft.path, draft.initial);
}
onMounted(() => load());
</script>
<template>
  <section class="content-library localized-library" :class="`${kind}-library`">
    <div class="page-heading"><div><p class="eyebrow">{{ t('内容管理') }}</p><h1>{{ t(kind === 'topic' ? '话题管理' : '动态') }}</h1><p class="muted">{{ t(kind === 'topic' ? '用话题连接文章与动态，独立维护介绍与语言版本。' : '记录当下的想法，每条动态都是独立内容。') }}</p></div><div class="row"><button class="secondary" :disabled="loading" @click="load(true)">{{ t('刷新内容') }}</button><button v-if="kind === 'topic'" class="primary" :disabled="loading || !!error" @click="create"><Icon name="plus" />{{ t(kind === 'topic' ? '新建话题' : '发动态') }}</button></div></div>
    <NoteComposer v-if="kind === 'note'" ref="composer" @dirty="changed" @saved="load()" />
    <p v-if="error" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="load(true)">{{ t('重试') }}</button></p>
    <section v-if="!loading && unclassified.length" class="card note-repair-list" :aria-label="t('需要检查')">
      <div class="card-heading"><div><h2>{{ t('需要检查') }}</h2><p class="muted small">{{ t('以下内容无法识别语言，请检查文件名和内容。') }}</p></div></div>
      <button v-for="item in unclassified" :key="item.path" class="content-row" @click="openItem(item.path)"><span class="content-icon"><Icon name="file" /></span><span class="content-info"><strong>{{ item.title || t('无标题动态') }}</strong><small>{{ t("文件位置") }}：{{ item.path }}</small><span class="content-description">{{ t(item.error) }}</span></span><span class="badge invalid">{{ t('需要检查') }}</span><Icon name="arrow" /></button>
    </section>
    <div class="card"><div class="library-toolbar note-toolbar"><div class="search-box"><Icon name="search" /><input v-model="search" :aria-label="t('搜索内容')" :placeholder="t(kind === 'topic' ? '搜索话题标题、介绍…' : '搜索动态、标签…')" /></div><SelectionField v-if="languages" v-model="language" name="note-language" :label="t('内容语言')" :options="languages.languages.map(value => ({ value, label: value }))" /><SelectionField v-model="status" name="note-status" :label="t('筛选状态')" :options="[{ value: 'all', label: t('全部状态') }, { value: 'draft', label: t('草稿') }, { value: 'published', label: t('已发布') }]" /></div>
      <LoadingState v-if="loading" label="正在读取内容…" />
      <div v-else-if="!rows.length && !error" class="empty-state"><h2>{{ t('没有找到匹配内容') }}</h2><p class="muted">{{ t(kind === 'topic' ? '创建话题后，可在文章和动态中选择关联。话题默认保存为草稿。' : '直接写正文，不必先想标题。新动态默认保存为草稿。') }}</p></div>
      <div v-for="item in rows" :key="item.path" class="library-row"><button class="content-row" :data-path="item.path" @click="openItem(item.path)"><span class="content-icon"><Icon name="pen" /></span><span class="content-info"><strong>{{ item.title || item.description || t('无标题动态') }}</strong><small v-if="kind === 'topic'">{{ t('创建于') }} {{ displayDate(item.date) }} · {{ t('资料更新于') }} {{ displayDate(item.updated || item.date) }} · {{ item.lang }}</small><small v-else>{{ displayDate(item.date) }} · {{ item.lang }}</small><span v-if="item.description && item.description !== item.title" class="content-description">{{ item.description }}</span></span><span class="badge" :class="{ draft: item.draft, invalid: item.error }">{{ item.error ? t('需要检查') : item.draft ? t('草稿') : t('已发布') }}</span><Icon name="arrow" /></button><div v-if="kind === 'note'" class="library-item-actions"><button class="text-button" :disabled="deleting" @click="openItem(item.path)">{{ t('详情') }}</button><button class="text-button danger" :disabled="deleting || composerDirty || composer?.isBusy()" :title="composerDirty ? t('请先保存当前编辑，再删除列表中的内容。') : undefined" :aria-label="t('删除{title}的当前语言版本', { title: item.title || t('无标题动态') })" @click="pendingDelete = item">{{ t('删除') }}</button></div></div>
      <div v-if="!loading && !error" class="list-footer library-footer"><span>{{ t('共 {count} 项', { count: filtered.length }) }} · {{ t('网站内容将在下次部署后更新') }}</span><div v-if="pages > 1" class="row"><button class="text-button" :disabled="page <= 1" @click="page--">{{ t('上一页') }}</button><span>{{ page }} / {{ pages }}</span><button class="text-button" :disabled="page >= pages" @click="page++">{{ t('下一页') }}</button></div></div>
    </div><p class="muted small workspace-note">{{ t('内容语言与创作中心界面语言独立。') }}</p>
    <DeleteContentDialog v-if="pendingDelete" :path="pendingDelete.path" :title="pendingDelete.title" @close="pendingDelete = undefined" @working="deleting = $event" @deleted="deleted" />
  </section>
</template>
