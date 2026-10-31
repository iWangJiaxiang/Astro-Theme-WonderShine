<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { Article, ArticleSummary, ContentLanguages, Settings } from '../../shared/types';
import { taxonomyChoices, stringValues } from '../../shared/choices';
import { mediaURL, storedMediaPath } from '../../shared/media';
import { translationLocation } from '../../shared/translation';
import { api, errorMessage } from '../api';
import { t, locale, type Message } from '../i18n';
import { metadataValue, noteReferences, publicContentUrl, isPublishedContent, previewLink } from '../note-detail';
import { topicOptions } from '../content-model';
import DeleteContentDialog from './DeleteContentDialog.vue';
import LoadingState from './LoadingState.vue';
import Icon from './Icon.vue';
import '../note-detail.css';

const props = defineProps<{ path: string; siteUrl?: string }>();
const emit = defineEmits<{ back: []; edit: [path: string]; open: [path: string]; deleted: [path: string] }>();
const document = ref<Article>(), items = ref<ArticleSummary[]>([]), languages = ref<ContentLanguages>();
const loading = ref(true), error = ref<Message>(''), deleting = ref(false), busy = ref(false);
const tagLabels = ref(new Map<string, string>());
let alive = true;
onBeforeUnmount(() => { alive = false; });
const summary = computed(() => items.value.find(item => item.path === props.path));
const language = computed(() => summary.value?.lang || (languages.value ? translationLocation(props.path, languages.value.defaultLanguage, languages.value).sourceLanguage : ''));
const versions = computed(() => items.value.filter(item => item.kind === 'note' && item.translationKey === summary.value?.translationKey && !item.error));
const meta = (path: string) => document.value ? metadataValue(document.value.metadata, path) : undefined;
const topics = computed(() => topicOptions(items.value, language.value).filter(item => stringValues(meta('extra.topics')).includes(item.id || '')));
const tags = computed(() => stringValues(meta('taxonomies.tags')).map(tag => tagLabels.value.get(tag) || tag));
const references = computed(() => noteReferences(meta('extra.references'), items.value, language.value, languages.value?.defaultLanguage || language.value));
const publicUrl = computed(() => isPublishedContent(summary.value) ? publicContentUrl(summary.value?.publicPath, props.siteUrl) : undefined);
const hasShortcode = computed(() => /\{%|\{\{/.test(document.value?.body || ''));
const preview = computed(() => {
  const html = DOMPurify.sanitize(marked.parse(document.value?.body || '', { async: false }) as string);
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  for (const image of parsed.querySelectorAll('img')) {
    try { const path = storedMediaPath(decodeURIComponent(image.getAttribute('src') || ''), 'document', props.path); if (path) image.setAttribute('src', mediaURL(path)); } catch { /* Keep unrecognized images unchanged. */ }
  }
  for (const link of parsed.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) continue;
    const target = previewLink(href, items.value, summary.value?.publicPath, props.siteUrl);
    if (!target) { link.removeAttribute('href'); continue; }
    link.setAttribute('href', target); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noopener noreferrer');
  }
  return parsed.body.innerHTML;
});
function date(value: string | undefined) {
  if (!value) return '—';
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}
async function load() {
  loading.value = true; error.value = '';
  try {
    const [doc, content, config] = await Promise.all([api<Article>(`/document?path=${encodeURIComponent(props.path)}`), api<ArticleSummary[]>('/content'), api<ContentLanguages>('/content-languages')]);
    if (!alive) return;
    document.value = doc; items.value = content; languages.value = config;
    try {
      const settings = await api<Settings>(`/settings/taxonomies?language=${encodeURIComponent(language.value)}`);
      if (alive) tagLabels.value = new Map(taxonomyChoices(settings.values['post.tags'], []).map(tag => [tag.value, tag.label]));
    } catch { /* Stored IDs remain useful when the label dictionary is unavailable. */ }
  } catch (e) { if (alive) error.value = errorMessage(e); }
  finally { if (alive) loading.value = false; }
}
onMounted(load);
defineExpose({ flush: () => {}, isBusy: () => busy.value });
</script>

<template>
  <section class="note-detail-page">
    <div class="page-heading"><div><button class="text-button detail-back" :disabled="busy" @click="emit('back')">{{ t('← 返回动态列表') }}</button><p class="eyebrow">{{ t('内容管理') }}</p><h1>{{ t('动态详情') }}</h1></div><div v-if="document && !loading && !error" class="row"><button class="text-button danger" :disabled="busy" @click="deleting = true">{{ t('删除') }}</button><a v-if="publicUrl" class="secondary" :href="publicUrl" target="_blank" rel="noopener noreferrer">{{ t('查看网站 ↗') }}</a><button class="primary" :disabled="busy" @click="emit('edit', path)"><Icon name="pen" :size="16" />{{ t('编辑动态') }}</button></div></div>
    <LoadingState v-if="loading" label="正在载入文稿…" />
    <div v-else-if="error" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="load">{{ t('重试') }}</button></div>
    <template v-else-if="document">
      <nav class="detail-language-tabs" :aria-label="t('语言版本')"><span class="muted small">{{ t('语言版本') }}</span><button v-for="version in versions" :key="version.path" :aria-current="version.path === path ? 'page' : undefined" :class="{ active: version.path === path }" :disabled="busy" @click="version.path !== path && emit('open', version.path)">{{ version.lang }}<span v-if="version.draft" class="detail-draft-dot" :title="t('草稿')" /></button><button v-if="languages && versions.length < languages.languages.length" class="text-button" :disabled="busy" @click="emit('edit', path)">{{ t('管理语言版本') }}<Icon name="plus" :size="14" /></button></nav>
      <div class="note-detail-layout">
        <article class="card note-reading-card">
          <header class="note-reading-header"><span class="detail-note-icon"><Icon name="pen" /></span><div><strong>{{ t('动态') }}</strong><time>{{ date(summary?.date) }}</time></div><span class="badge" :class="{ draft: summary?.draft }">{{ t(summary?.draft ? '草稿' : '已发布') }}</span></header>
          <h2 v-if="meta('title')" class="note-reading-title">{{ meta('title') }}</h2>
          <p v-if="hasShortcode" class="notice small">{{ t('这里只预览 Markdown；shortcode 和主题页面请在 Astro 网站预览中查看。') }}</p>
          <div v-if="document.body.trim()" class="markdown-preview note-reading-body" v-html="preview" />
          <p v-else class="muted note-reading-body">{{ t('这条动态没有正文。') }}</p>
          <section v-if="references.length" class="note-detail-references" :aria-label="t('引用文章')"><h3>{{ t('引用文章') }} <span>{{ references.length }}</span></h3><div v-for="(reference, index) in references" :key="index" class="detail-reference"><span class="detail-reference-icon"><Icon :name="reference.kind === 'internal' ? 'file' : 'link'" :size="18" /></span><div><small>{{ t(reference.kind === 'internal' ? '本站文章' : '外部文章') }}<template v-if="reference.language"> · {{ reference.language }}</template><template v-if="reference.draft"> · {{ t('草稿') }}</template></small><button v-if="reference.path" class="text-button" :disabled="busy" @click="emit('edit', reference.path)">{{ reference.title }} ↗</button><a v-else-if="reference.href" :href="reference.href" target="_blank" rel="noopener noreferrer">{{ reference.title }} ↗</a><strong v-else>{{ reference.title }}</strong><small v-if="reference.missing">{{ t('引用内容暂不可用，请在编辑器中检查。') }}</small></div></div></section>
          <footer v-if="tags.length || topics.length" class="note-reading-footer"><div v-if="tags.length" class="detail-tags" :aria-label="t('标签')"><span v-for="tag in tags" :key="tag"># {{ tag }}</span></div><div v-if="topics.length" class="detail-topics"><span class="muted small">{{ t('关联话题') }}</span><button v-for="topic in topics" :key="topic.path" class="text-button" :disabled="busy" @click="emit('edit', topic.path)">{{ topic.title }}<span v-if="topic.lang !== language"> · {{ topic.lang }}</span></button></div></footer>
        </article>
        <aside class="note-detail-aside"><section class="card detail-properties"><h2>{{ t('发布信息') }}</h2><dl><div><dt>{{ t('内容语言') }}</dt><dd>{{ language }}</dd></div><div><dt>{{ t('发布时间') }}</dt><dd>{{ date(summary?.date) }}</dd></div><div v-if="summary?.updated"><dt>{{ t('更新时间') }}</dt><dd>{{ date(summary.updated) }}</dd></div><div><dt>{{ t('评论') }}</dt><dd>{{ t(meta('extra.disable_comment') ? '已关闭' : '已开启') }}</dd></div><div v-if="meta('extra.ai_translation')"><dt>{{ t('AI 翻译') }}</dt><dd>{{ t(meta('extra.translation_reviewed') ? '译文已审核' : '译文待审核') }}</dd></div></dl><p class="muted small">{{ t('网站内容将在下次部署后更新') }}</p></section><details class="detail-file"><summary>{{ t('文件位置') }}</summary><p>{{ path }}</p></details></aside>
      </div>
    </template>
    <DeleteContentDialog v-if="deleting && document" :path="path" :title="summary?.title || t('无标题动态')" :revision="document.revision" @close="deleting = false" @working="busy = $event" @deleted="emit('deleted', $event)" />
  </section>
</template>
