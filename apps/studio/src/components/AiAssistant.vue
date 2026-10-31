<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref } from 'vue';
import { api, errorMessage } from '../api';
import { t, type Message } from '../i18n';
import type { AiCapabilities, AiImageResult } from '../../shared/ai';
import { documentDirectory, supportsColocatedMedia, type MediaUploadResult } from '../../shared/media';
import { addUploadedMedia } from '../media-store';
const props = defineProps<{ kind: 'summary' | 'cover'; title: string; text: string; language: string; path: string }>();
const emit = defineEmits<{ close: []; summary: [value: string]; cover: [field: string, value: string]; working: [value: boolean] }>();
const dialog = ref<HTMLDialogElement>(), capabilities = ref<AiCapabilities>(), loading = ref(true), busy = ref(false), error = ref<Message>('');
const result = ref(''), image = ref<AiImageResult>(), imagePrompt = ref('');
const previousFocus = document.activeElement as HTMLElement | null;
let alive = true;
onMounted(async () => {
  await nextTick(); dialog.value?.showModal();
  try { capabilities.value = await api<AiCapabilities>('/ai/config'); } catch (e) { error.value = errorMessage(e); }
  finally { loading.value = false; }
});
onBeforeUnmount(() => { alive = false; dialog.value?.close(); previousFocus?.focus(); });
function close() { if (!busy.value) emit('close'); }
async function work(fn: () => Promise<void>) {
  if (busy.value) return false;
  busy.value = true; error.value = ''; emit('working', true);
  try { await fn(); return true; } catch (e) { if (alive) error.value = errorMessage(e); return false; }
  finally { busy.value = false; emit('working', false); }
}
function generateText() { return work(async () => {
  const response = await api<{ text: string }>('/ai/text', 'POST', { task: props.kind === 'summary' ? 'summary' : 'cover-prompt', title: props.title, text: props.text, language: props.language });
  if (alive) result.value = response.text;
}); }
function generateImage() { return work(async () => {
  const prompt = result.value;
  const response = await api<AiImageResult>('/ai/image', 'POST', { prompt });
  if (alive) { image.value = response; imagePrompt.value = prompt; }
}); }
async function applyCover() { const applied = await work(async () => {
  if (!image.value) return;
  const bundled = supportsColocatedMedia(props.path);
  const directory = bundled ? documentDirectory(props.path).replace(/\/$/, '') : 'public/uploads';
  const bytes = Uint8Array.from(atob(image.value.base64), character => character.charCodeAt(0));
  const saved = await api<MediaUploadResult>('/media/upload?' + new URLSearchParams({ directory, filename: `ai-cover-${crypto.randomUUID()}.${image.value.extension}` }), 'POST', new Blob([bytes], { type: image.value.mime }));
  addUploadedMedia(saved.item);
  if (alive) { emit('cover', bundled ? 'extra.cover' : 'extra.global_cover', bundled ? saved.item.name : '/' + saved.item.path.slice(7)); }
}); if (applied && alive) emit('close'); }
</script>
<template>
  <Teleport to="body"><dialog ref="dialog" class="ai-assistant-dialog" :aria-label="t(kind === 'summary' ? 'AI 摘要' : 'AI 文章封面')" @cancel.prevent="close" @click="($event.target === dialog) && close()">
    <header class="card-heading"><div><p class="eyebrow">{{ t('AI 创作助手') }}</p><h2>{{ t(kind === 'summary' ? 'AI 摘要' : 'AI 文章封面') }}</h2></div><button class="text-button" :disabled="busy" @click="close">{{ t('取消') }}</button></header>
    <div class="ai-assistant-body" :aria-busy="busy || loading">
      <p v-if="loading" class="muted">{{ t('正在读取 AI 配置…') }}</p>
      <p v-else-if="!capabilities?.text" class="notice">{{ t('尚未配置 AI 文本服务，请联系管理员') }}</p>
      <p v-if="kind === 'cover' && capabilities && !capabilities.image" class="notice">{{ t('尚未配置 AI 图片服务，请联系管理员') }}</p>
      <p v-if="error" class="notice error" role="alert">{{ t(error) }}</p>
      <div class="ai-source"><span>{{ t(kind === 'summary' ? '根据当前正文生成' : '根据当前摘要生成') }}</span><strong>{{ title || t('未命名内容') }}</strong><p>{{ text.slice(0, 260) }}{{ text.length > 260 ? '…' : '' }}</p></div>
      <div class="ai-step-heading"><strong>{{ t(kind === 'summary' ? '摘要预览' : '1 · 图片提示词') }}</strong><button class="secondary" :disabled="busy || !capabilities?.text || !text.trim()" @click="generateText">{{ t(result ? '重新生成' : kind === 'summary' ? '生成摘要' : '生成提示词') }}</button></div>
      <textarea v-model="result" :aria-label="t(kind === 'summary' ? 'AI 摘要结果' : '图片提示词')" :disabled="busy" :rows="kind === 'cover' ? 3 : 5" :placeholder="t('生成后可以直接修改，再决定是否应用。')" />
      <template v-if="kind === 'cover'"><div class="ai-step-heading"><strong>{{ t('2 · 封面预览') }}</strong><button class="secondary" :disabled="busy || !capabilities?.image || !result.trim()" @click="generateImage">{{ t(image ? '重新生成图片' : '生成图片') }}</button></div><div class="ai-image-preview"><img v-if="image" :src="`data:${image.mime};base64,${image.base64}`" :alt="t('AI 封面预览')" /><span v-else class="muted">{{ t('确认提示词后生成图片') }}</span></div><p v-if="image && result !== imagePrompt" class="muted small">{{ t('提示词已修改，请重新生成图片后应用。') }}</p></template>
      <p v-if="busy" role="status" class="muted">{{ t('正在处理，请稍候…') }}</p>
    </div>
    <footer class="selection-footer"><span class="muted small">{{ t(kind === 'summary' ? '应用后仍需保存文章。' : '应用时保存图片到仓库；文章仍需保存。') }}</span><button v-if="kind === 'summary'" class="primary" :disabled="busy || !result.trim()" @click="emit('summary', result.trim()); emit('close')">{{ t('应用摘要') }}</button><button v-else class="primary" :disabled="busy || !image || result !== imagePrompt" @click="applyCover">{{ t('保存并设为封面') }}</button></footer>
  </dialog></Teleport>
</template>
