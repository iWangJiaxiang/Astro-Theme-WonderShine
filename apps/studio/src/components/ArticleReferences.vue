<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import type { ArticleSummary, Json } from '../../shared/types';
import { t } from '../i18n';
import Icon from './Icon.vue';
type Reference = { kind: 'internal'; path: string } | { kind: 'external'; url: string; title: string };
const props = defineProps<{ modelValue: Json | undefined; items: ArticleSummary[]; language: string; disabled?: boolean; compact?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: Json] }>();
const id = useId(), dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>();
const opened = ref(false), mode = ref<'internal' | 'external'>('internal'), search = ref(''), selected = ref(''), url = ref(''), title = ref(''), error = ref('');
const references = computed(() => Array.isArray(props.modelValue) ? props.modelValue as Reference[] : []);
const key = (item: ArticleSummary) => (item.translationKey || item.path).replace(/^content\//, '');
const articles = computed(() => {
  const grouped = new Map<string, ArticleSummary>();
  for (const item of props.items.filter(item => (item.kind === 'article' || (item.kind === 'collection' && !item.path.startsWith('content/collections/album/'))) && !/\/_index(?:\.[^.]+)?\.md$/.test(item.path) && !item.error)) {
    const current = grouped.get(key(item));
    if (!current || item.lang === props.language) grouped.set(key(item), item);
  }
  return [...grouped.values()].sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
});
const filtered = computed(() => articles.value.filter(item => [item.title, item.path, ...item.tags].join(' ').toLowerCase().includes(search.value.trim().toLowerCase())));
function label(reference: Reference) { return reference.kind === 'external' ? reference.title || reference.url : articles.value.find(item => key(item) === reference.path)?.title || reference.path; }
async function open() {
  if (props.disabled || references.value.length >= 12) return;
  search.value = ''; selected.value = ''; url.value = ''; title.value = ''; error.value = ''; opened.value = true;
  await nextTick(); dialog.value?.showModal();
}
function close() { dialog.value?.close(); opened.value = false; trigger.value?.focus(); }
function add() {
  if (props.disabled) return;
  let reference: Reference;
  if (mode.value === 'internal') {
    if (!selected.value) return;
    reference = { kind: 'internal', path: selected.value };
  } else {
    try {
      const parsed = new URL(url.value.trim());
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
      reference = { kind: 'external', url: parsed.href, title: title.value.trim() || parsed.hostname };
    } catch { error.value = '请输入有效的 http 或 https 文章地址'; return; }
  }
  if (!references.value.some(item => item.kind === reference.kind && (item.kind === 'internal' && reference.kind === 'internal' ? item.path === reference.path : item.kind === 'external' && reference.kind === 'external' && item.url === reference.url))) emit('update:modelValue', [...references.value, reference]);
  close();
}
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <div class="article-references" :class="{ 'reference-compact': compact }">
    <div class="reference-heading"><button ref="trigger" class="text-button" :disabled="disabled || references.length >= 12" aria-haspopup="dialog" :aria-expanded="opened" @click="open"><Icon v-if="compact" name="link" :size="16" />{{ t('引用文章') }} <span v-if="!compact" aria-hidden="true">＋</span></button><span v-if="references.length" class="muted small">{{ references.length }} / 12</span></div>
    <ul v-if="references.length" class="reference-chips"><li v-for="(reference, index) in references" :key="index"><span class="badge">{{ t(reference.kind === 'internal' ? '本站' : '外部') }}</span><span>{{ label(reference) }}</span><button class="text-button" :disabled="disabled" :aria-label="t('移除引用：{title}', { title: label(reference) })" @click="emit('update:modelValue', references.filter((_, i) => i !== index))">×</button></li></ul>
    <Teleport to="body"><dialog v-if="opened" ref="dialog" class="selection-dialog reference-dialog" :aria-labelledby="`${id}-title`" @cancel.prevent="close" @click="($event.target === dialog) && close()"><form class="selection-panel" @submit.prevent="add">
      <div class="card-heading"><h2 :id="`${id}-title`">{{ t('引用文章') }}</h2><button type="button" class="text-button" @click="close">{{ t('取消') }}</button></div>
      <div class="editor-tabs"><button type="button" :class="{ active: mode === 'internal' }" @click="mode = 'internal'">{{ t('本站文章') }}</button><button type="button" :class="{ active: mode === 'external' }" @click="mode = 'external'">{{ t('外部文章') }}</button></div>
      <template v-if="mode === 'internal'"><label class="field selection-search"><span>{{ t('搜索文章') }}</span><input v-model="search" type="search" autofocus :placeholder="t('搜索标题、标签或文件位置…')" /></label>
        <fieldset class="selection-results reference-results" :aria-label="t('本站文章')"><label v-for="item in filtered" :key="key(item)" class="choice-tile" :class="{ selected: selected === key(item) }"><input v-model="selected" type="radio" name="reference-article" :value="key(item)" /><span><strong>{{ item.title }}</strong><small>{{ item.lang }} · {{ t(item.draft ? '草稿' : '已发布') }}<template v-if="item.lang !== language"> · {{ t('缺少 {language} 译文', { language }) }}</template></small></span></label><p v-if="!filtered.length" class="muted">{{ t('没有找到匹配内容') }}</p></fieldset>
      </template>
      <div v-else class="external-reference-fields"><label class="field field-inline"><span>{{ t('文章地址') }}</span><input v-model="url" type="url" required placeholder="https://example.com/article" /></label><label class="field field-inline"><span>{{ t('标题（可选）') }}</span><input v-model="title" maxlength="300" /></label><p v-if="error" class="notice error" role="alert">{{ t(error) }}</p></div>
      <div class="selection-footer"><small class="muted">{{ t('本站引用自动匹配内容语言；缺少公开译文时显示原文。') }}</small><button class="primary" :disabled="disabled || (mode === 'internal' && !selected)">{{ t('添加引用') }}</button></div>
    </form></dialog></Teleport>
  </div>
</template>
