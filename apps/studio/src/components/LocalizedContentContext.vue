<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ArticleSummary, Json } from '../../shared/types';
import { api, errorMessage } from '../api';
import { t, type Message } from '../i18n';
import { type ContentLanguages } from '../content-model';
import { translationLocation, type TranslationCapabilities, type TranslationResult } from '../../shared/translation';
import LoadingState from './LoadingState.vue';
const props = defineProps<{ path: string; kind: ArticleSummary['kind']; revision: string | null; dirty: boolean; busy: boolean }>();
const emit = defineEmits<{ working: [value: boolean]; open: [path: string, initial?: Record<string, Json>, initialBody?: string] }>();
const items = ref<ArticleSummary[]>([]), languages = ref<ContentLanguages>(), loading = ref(true), error = ref<Message>(''), preparing = ref(false);
const adding = ref(false), targetLanguage = ref('');
const capabilities = ref<TranslationCapabilities>({ enabled: false });
let alive = true;
onBeforeUnmount(() => { alive = false; });
const language = computed(() => languages.value ? translationLocation(props.path, languages.value.defaultLanguage, languages.value).sourceLanguage : '');
function targetPath(language: string) { return languages.value ? translationLocation(props.path, language, languages.value).path : ''; }
function exists(language: string) { return items.value.some(item => item.path === targetPath(language)); }
const hasMissingVersion = computed(() => languages.value?.languages.some(target => target !== language.value && !exists(target)));
const missingLanguages = computed(() => languages.value?.languages.filter(target => target !== language.value && !exists(target)) || []);
const blocked = computed(() => props.dirty || props.busy || !props.revision || loading.value || preparing.value || !!error.value);
async function load() {
  loading.value = true; error.value = '';
  try { const [content, config, ai] = await Promise.all([api<ArticleSummary[]>('/content'), api<ContentLanguages>('/content-languages'), api<TranslationCapabilities>('/translation/config')]); items.value = content.filter(item => item.kind === props.kind); languages.value = config; capabilities.value = ai; }
  catch (e) { error.value = errorMessage(e); } finally { loading.value = false; }
}
async function translate(language: string, ai = false) {
  if (blocked.value || !languages.value) return;
  const path = targetPath(language);
  if (items.value.some(item => item.path === path)) { emit('open', path); return; }
  preparing.value = true; error.value = '';
  try {
    const result = await api<TranslationResult>(ai ? '/translation' : '/translation/manual', 'POST', { path: props.path, revision: props.revision, language });
    if (alive) { preparing.value = false; emit('open', result.path); }
  } catch (e) { error.value = errorMessage(e); } finally { preparing.value = false; }
}
watch(missingLanguages, values => { if (!values.includes(targetLanguage.value)) targetLanguage.value = values[0] || ''; });
watch(preparing, value => emit('working', value), { flush: 'sync' });
onMounted(load); watch(() => props.revision, load);
</script>
<template>
  <section class="language-versions" :aria-label="t('语言版本')">
    <LoadingState v-if="loading" label="正在读取内容…" compact />
    <div v-else class="language-version-bar">
      <span class="muted small">{{ t('语言版本') }}</span>
      <div class="language-version-tabs" role="tablist" :aria-label="t('语言版本')">
        <button v-for="target in languages?.languages.filter(value => value === language || exists(value))" :key="target" role="tab" :aria-selected="target === language" :class="{ active: target === language }" :disabled="target !== language && blocked" @click="target !== language && translate(target)">{{ target }}<span v-if="target === language && dirty" aria-hidden="true"> ·</span></button>
      </div>
      <button v-if="hasMissingVersion" class="text-button" :disabled="blocked" :aria-expanded="adding" @click="adding = !adding">{{ t('＋ 添加语言') }}</button>
      <span v-if="dirty || !revision" class="muted small">{{ t('先保存当前内容，再创建或打开译文。') }}</span>
    </div>
    <p v-if="error" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="load">{{ t('重试') }}</button></p>
    <div v-if="adding && hasMissingVersion" class="language-version-create">
      <div class="row"><label class="field field-inline"><span>{{ t('目标语言') }}</span><select v-model="targetLanguage" :disabled="blocked"><option v-for="target in missingLanguages" :key="target" :value="target">{{ target }}</option></select></label>
        <button class="secondary" :disabled="blocked || !targetLanguage" @click="translate(targetLanguage)">{{ t('创建译文草稿') }}</button>
        <button class="primary" :disabled="blocked || !capabilities.enabled || !targetLanguage" @click="translate(targetLanguage, true)">{{ t('AI 翻译为草稿') }}</button>
      </div>
      <p v-if="preparing" class="notice" role="status">{{ t('正在生成译文，请稍候…') }}</p>
      <p v-else class="muted small">{{ t('手动译文会复制原文为草稿，请翻译后发布。') }}</p>
      <details v-if="!capabilities.enabled" class="translation-setup"><summary>{{ t('AI 翻译未配置') }}</summary><p class="muted small">{{ t('AI 翻译未配置。请在服务端设置 STUDIO_AI_BASE_URL、STUDIO_AI_MODEL 和 STUDIO_AI_API_KEY，然后重启。') }}</p></details>
      <p v-else class="muted small">{{ t('生成时会将已保存的标题、摘要和正文发送给配置的 AI 服务。译文存为草稿，审核后才可发布。') }}</p>
    </div>
    <p v-if="languages?.languages.length === 1" class="muted small">{{ t('在站点配置中添加语言后，可在这里创建译文。') }}</p>
  </section>
</template>
