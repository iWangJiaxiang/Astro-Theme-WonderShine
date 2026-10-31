<script setup lang="ts">
import LoadingState from './LoadingState.vue';
import { t, type Message } from '../i18n';
import { ref, shallowRef, computed, watch, onBeforeUnmount, provide } from 'vue';
import type { Settings, Json, SaveResult, ArticleSummary, Field } from '../../shared/types';
import { api, session, errorMessage } from '../api';
import ValueEditor from './ValueEditor.vue';
import FormField from './FormField.vue';
import { formContext } from '../form-context';
import type { Choice } from '../../shared/choices';
const props = defineProps<{ group: string; embedded?: boolean; language?: string }>();
const endpoint = computed(() => `/settings/${props.group}${props.language ? `?language=${encodeURIComponent(props.language)}` : ''}`);
const emit = defineEmits<{ dirty: [value: boolean]; saved: [] }>();
const settings = shallowRef<Settings | null>(null), values = ref<Record<string, Json>>({}), baseline = ref<Record<string, Json>>({});
const unresolvedItems = ref<ArticleSummary[]>([]);
const unresolved = computed(() => unresolvedItems.value.map(item => `${item.title}: ${t(item.linkWarning)}`));
const postItems = ref<ArticleSummary[]>([]);
const posts = computed<Choice[]>(() => postItems.value.map(item => ({ value: item.path.replace(/^content\//, ''), label: `${item.title} · ${t("文件位置")}：${item.path.replace(/^content\//, '')}` })));
const links = ref<Choice[]>([]), relationsLoading = ref(false), relationsError = ref<Message>('');
const siteLinks = computed(() => [{ value: '/', label: t('首页') }, ...links.value.filter(item => item.value !== '/')]);
provide(formContext, { unresolved, posts, links: siteLinks, values, loading: relationsLoading, error: relationsError });
async function loadRelations() {
  relationsLoading.value = true; relationsError.value = '';
  try {
    const items = await api<ArticleSummary[]>('/content');
    unresolvedItems.value = items.filter(item => item.linkWarning);
    postItems.value = items.filter(item => !item.error && item.kind !== 'page' && !/\/_index(?:\.[^.]+)?\.md$/.test(item.path));
    links.value = [...items.filter(item => !item.error && item.publicPath && item.render !== false).map(item => ({ value: item.publicPath!, label: item.title }))].filter((item, index, all) => all.findIndex(other => other.value === item.value) === index);
  } catch (e) { relationsError.value = errorMessage(e); }
  finally { relationsLoading.value = false; }
}
void loadRelations();
// Presentation groups only: schema keys and saved values remain unchanged.
const groupDefinitions: Record<string, { title: string; paths: string[] }[]> = {
  site: [
    { title: '基本信息', paths: ['title', 'author', 'base_url', 'default_language', 'description', 'extra.site.seo'] },
    { title: '站点视觉', paths: ['extra.site.logo', 'extra.site.favicon', 'extra.site.default_cover', 'extra.site.author.avatar', 'extra.site.author.about_image'] },
    { title: '联系与备案', paths: ['extra.site.email', 'extra.site.start_year', 'extra.site.compliance_icp', 'extra.site.compliance_security', 'extra.site.compliance_security_link'] },
  ],
  appearance: [
    { title: '主题与字体', paths: ['extra.style.theme_light_skin', 'extra.style.theme_dark_skin', 'extra.style.color_scheme', 'extra.style.font_family'] },
    { title: '显示效果', paths: ['extra.style.universe'] },
  ],
  recommendations: [
    { title: '推荐内容', paths: ['post.recommend_posts'] },
    { title: '今日推荐', paths: ['post.today_recommend.post_path', 'post.today_recommend.title', 'post.today_recommend.small_title', 'post.today_recommend.url', 'post.today_recommend.cover'] },
  ],
  about: [
    { title: '个人介绍', paths: ['extra.about.hello', 'extra.about.content', 'extra.about.idea'] },
    { title: '个人标签与经历', paths: ['extra.about.author_info_left_tags', 'extra.about.author_info_right_tags', 'extra.about.careers', 'extra.about.map'] },
    { title: '生活与偏好', paths: ['extra.about.photos', 'extra.about.hobbies', 'extra.about.like', 'extra.about.music'] },
    { title: '页面布局', paths: ['extra.about.widget_list', 'extra.about.textarea_left', 'extra.about.textarea_right'] },
  ],
};
const fieldGroups = computed(() => {
  const fields = settings.value?.fields || [], definitions = groupDefinitions[props.group] || [];
  const used = new Set<string>(), groups: { title: string; fields: Field[] }[] = [];
  for (const definition of definitions) {
    const members = definition.paths.flatMap(path => { const field = fields.find(field => field.path === path); return field ? [field] : []; });
    if (!members.length) continue;
    members.forEach(field => used.add(field.path)); groups.push({ title: definition.title, fields: members });
  }
  const remaining = fields.filter(field => !used.has(field.path));
  if (remaining.length) groups.push({ title: '', fields: remaining });
  return groups;
});
const ready = ref(false);
const storageKey = `studio-settings:${session.value?.identity.method}:${session.value?.identity.id}:${props.group}:${props.language || 'default'}`;
const busy = ref(false), error = ref<Message>(''), message = ref<Message>('');
const changes = computed(() => Object.fromEntries(Object.entries(values.value).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(baseline.value[key]))));
const dirty = computed(() => Object.keys(changes.value).length > 0);
watch(dirty, value => emit('dirty', value), { flush: 'sync' });
watch([values, baseline, () => settings.value?.revision], () => {
  if (!ready.value || !settings.value) return;
  try {
    if (dirty.value) sessionStorage.setItem(storageKey, JSON.stringify({ values: values.value, baseline: baseline.value, revision: settings.value.revision }));
    else sessionStorage.removeItem(storageKey);
  } catch { /* The mounted form remains available when tab storage is disabled. */ }
}, { deep: true });
let requestId = 0;
async function load() {
  const id = ++requestId; ready.value = false;
  error.value = ''; settings.value = null; message.value = '';
  try {
    const result = await api<Settings>(endpoint.value);
    if (id !== requestId) return;
    settings.value = result; values.value = structuredClone(result.values); baseline.value = structuredClone(result.values);
    try {
      const draft = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      if (draft?.values && draft?.baseline && typeof draft.revision === 'string') {
        values.value = draft.values; baseline.value = draft.baseline; settings.value.revision = draft.revision;
        message.value = '已恢复当前标签页中的配置草稿；保存时仍会检查仓库版本。';
      }
    } catch { /* Invalid or unavailable tab storage does not block loading. */ }
    ready.value = true;
  } catch (e) { if (id === requestId) error.value = errorMessage(e); }
}
watch(() => props.group, load, { immediate: true });
onBeforeUnmount(() => { requestId++; emit('dirty', false); });
function reload() { if (!dirty.value || window.confirm(t('重新加载会丢弃当前未保存修改，继续吗？'))) { ready.value = false; try { sessionStorage.removeItem(storageKey); } catch {} void load(); } }
async function save() {
  if (!settings.value) return;
  busy.value = true; error.value = ''; message.value = '';
  const submitted = JSON.parse(JSON.stringify(values.value));
  try {
    const result = await api<SaveResult>(endpoint.value, 'PUT', { revision: settings.value.revision, changes: changes.value });
    settings.value.revision = result.revision; baseline.value = submitted; message.value = result.message; emit('saved');
  } catch (e) { error.value = errorMessage(e); }
  finally { busy.value = false; }
}
</script>
<template>
  <section v-if="settings" class="settings-page" :data-settings-group="group" :class="{ 'embedded-settings': embedded }">
    <div class="page-heading"><div><p v-if="!embedded" class="eyebrow">{{ t("站点管理") }}</p><component :is="embedded ? 'h3' : 'h1'">{{ t(settings.title) }}</component><p class="muted">{{ t(settings.description) }}</p></div><button class="primary" :disabled="busy || !dirty" @click="save">{{ busy ? t("正在保存…") : embedded ? t("保存页面设置") : t("保存更改") }}</button></div>
    <p v-if="error" class="notice error" role="alert">{{ t(error) }} <button class="text-button" @click="reload">{{ t("重新加载") }}</button></p>
    <p v-if="message" class="notice success" role="status">{{ t(message) }}</p>
    <button v-if="dirty" class="text-button settings-discard" @click="reload">{{ t("放弃更改并重新加载") }}</button>
    <div class="card settings-card"><div class="card-heading"><h2>{{ t("配置内容") }}</h2><span class="settings-state" :class="{ pending: dirty }" role="status">{{ dirty ? t("有未保存的更改") : t("已保存") }}</span></div>
      <p v-if="relationsError" class="notice error">{{ t("无法加载可选内容：") }}{{ t(relationsError) }} <button class="text-button" @click="loadRelations">{{ t("重试选项") }}</button></p>
      <div class="settings-groups"><section v-for="(section, index) in fieldGroups" :key="section.title || index" class="settings-form-group" :class="{ 'has-heading': section.title }"><header v-if="section.title" class="settings-group-heading"><span class="settings-group-index" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span><h3>{{ t(section.title) }}</h3></header><div class="settings-grid"><template v-for="field in section.fields" :key="field.path">
        <div v-if="field.kind === 'structured'" class="full-width"><ValueEditor v-model="values[field.path]" :name="field.path" :label="t(field.label)" :sprite="String(values['skill.svg_sprite'] || '')" /></div>
        <FormField v-else v-model="values[field.path]" :class="{ 'full-width': field.kind === 'textarea' }" :name="field.path" :label="t(field.label)" :kind="field.kind" :hint="t(field.hint)" />
      </template></div></section></div>
    </div>
    <p class="muted small">{{ t("仅修改对应字段，保留其他配置。列表内容发生修改时会重新排版该列表。") }}</p>
  </section>
  <p v-else-if="error" class="notice error" role="alert">{{ t(error) }} <button @click="load">{{ t("重试") }}</button></p>
  <LoadingState v-else label="正在读取配置…" />
</template>
