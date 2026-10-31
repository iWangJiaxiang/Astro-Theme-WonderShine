<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import type { Article, ContentLanguages } from '../../shared/types';
import { translationLocation } from '../../shared/translation';
import { api, ApiError, errorMessage, session } from '../api';
import { forgetDeletedContent } from '../deleted-content';
import { contentLabel } from '../content-model';
import { t, type Message } from '../i18n';
import './delete-content.css';

const props = defineProps<{ path: string; title?: string; revision?: string | null; unsaved?: boolean }>();
const emit = defineEmits<{ deleted: [path: string]; close: []; working: [value: boolean] }>();
const id = useId(), dialog = ref<HTMLDialogElement>(), cancelButton = ref<HTMLButtonElement>();
const loading = ref(true), deleting = ref(false), error = ref<Message>(''), blocked = ref(false);
const language = ref(''), loadedTitle = ref(''), revision = ref<string | null>(null);
const path = props.path, expectedRevision = props.revision;
const deletionIdentity = session.value?.identity;
const title = computed(() => props.title?.trim() || loadedTitle.value || t('未命名内容'));
const busy = computed(() => loading.value || deleting.value);
let alive = true, previousFocus: HTMLElement | null = null;

async function load() {
  loading.value = true; error.value = ''; blocked.value = false; emit('working', true);
  try {
    const [document, languages] = await Promise.all([
      api<Article>(`/document?path=${encodeURIComponent(path)}`), api<ContentLanguages>('/content-languages'),
    ]);
    if (!alive) return;
    language.value = translationLocation(path, languages.defaultLanguage, languages).sourceLanguage;
    loadedTitle.value = contentLabel(document.body, document.metadata.title);
    // A caller's revision represents what the user edited. Never silently advance it.
    revision.value = expectedRevision === undefined ? document.revision : expectedRevision;
    if (!revision.value || revision.value !== document.revision) {
      blocked.value = true;
      error.value = '内容版本已变化，请关闭此窗口，重新打开内容检查后再删除。';
    }
  } catch (cause) { if (alive) { error.value = errorMessage(cause); blocked.value = true; } }
  finally { if (alive) { loading.value = false; emit('working', false); } }
}
function close() { if (!deleting.value) emit('close'); }
async function remove() {
  if (busy.value || blocked.value || !revision.value) return;
  deleting.value = true; error.value = ''; emit('working', true);
  try {
    await api('/document', 'DELETE', { path, revision: revision.value });
    try { if (deletionIdentity) forgetDeletedContent(localStorage, deletionIdentity, path); } catch { /* localStorage itself can be inaccessible. */ }
    if (alive) emit('deleted', path);
  } catch (cause) {
    if (!alive) return;
    error.value = errorMessage(cause);
    // Retrying a conflict must not fetch a new revision and delete unseen changes.
    if (cause instanceof ApiError && (cause.status === 409 || cause.status === 404)) blocked.value = true;
  } finally { if (alive) { deleting.value = false; emit('working', false); } }
}
onMounted(async () => {
  previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (!alive) return;
  dialog.value?.showModal(); cancelButton.value?.focus();
  void load();
});
onBeforeUnmount(() => {
  alive = false; dialog.value?.close(); emit('working', false);
  if (previousFocus?.isConnected) previousFocus.focus();
});
</script>

<template>
  <Teleport to="body"><dialog ref="dialog" class="delete-content-dialog" :aria-labelledby="`${id}-title`" :aria-describedby="`${id}-scope`" :aria-busy="busy" @cancel.prevent="close" @click="($event.target === dialog) && close()">
    <form class="delete-content-panel" @submit.prevent="remove">
      <h2 :id="`${id}-title`">{{ t('删除当前语言版本') }}</h2>
      <p :id="`${id}-scope`">{{ t('只删除当前语言的内容文件，其他语言版本和图片等资源会保留。网站将在下次构建与部署后更新。') }}</p>
      <dl class="delete-content-details"><dt>{{ t('标题') }}</dt><dd>{{ title }}</dd><dt>{{ t('内容语言') }}</dt><dd>{{ language || t('正在读取…') }}</dd><dt>{{ t('文件位置') }}</dt><dd class="delete-content-path">{{ path }}</dd></dl>
      <p v-if="unsaved" class="notice">{{ t('当前编辑器有未保存的更改，删除后这些更改和本地草稿备份也会丢弃。') }}</p>
      <p v-if="loading" role="status" class="muted">{{ t('正在检查内容版本…') }}</p>
      <p v-if="error" class="notice error" role="alert">{{ t(error) }}</p>
      <p v-if="blocked && revision" class="muted small">{{ t('请关闭此窗口，检查内容或解除引用后再试。') }}</p>
      <div class="delete-content-actions"><button ref="cancelButton" type="button" class="secondary" :disabled="deleting" @click="close">{{ t('取消') }}</button><button type="submit" class="delete-content-confirm" :disabled="busy || blocked || !revision">{{ t(deleting ? '正在删除…' : '确认删除当前语言') }}</button></div>
    </form>
  </dialog></Teleport>
</template>
