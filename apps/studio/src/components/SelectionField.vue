<script setup lang="ts">
import { t, type Message } from '../i18n';
import { errorMessage } from '../api';
import { computed, ref, watch, useId, nextTick, onBeforeUnmount } from 'vue';
import type { Json } from '../../shared/types';
import type { Choice } from '../../shared/choices';
import ChoicePreview from './ChoicePreview.vue';
import Icon from './Icon.vue';
const props = defineProps<{ modelValue: Json | undefined; options: Choice[]; name: string; label: string; multiple?: boolean; disabled?: boolean; hint?: string; preview?: string; compact?: boolean; icon?: string;
  createOption?: (title: string) => Promise<Choice>; createLabel?: string; createHint?: string; createdHint?: string; searchPlaceholder?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string | string[]] }>();
const id = useId(), dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>();
const opened = ref(false), search = ref(''), pending = ref<string[]>([]), known = ref<string[]>([]);
const creating = ref(false), createError = ref<Message>(''), created = ref(false), addedOptions = ref<Choice[]>([]);
let alive = true;
const normalized = (value: string) => value.trim().replace(/\s+/gu, ' ').normalize('NFKC').toLowerCase();
const query = computed(() => search.value.trim().replace(/\s+/gu, ' '));
const selected = computed(() => props.multiple ? Array.isArray(props.modelValue) ? props.modelValue.filter((v): v is string => typeof v === 'string' && !!v) : [] : [String(props.modelValue ?? '')]);
watch(selected, values => { known.value = [...new Set([...known.value, ...values.filter(Boolean)])]; }, { immediate: true });
const options = computed<Choice[]>(() => [...props.options, ...addedOptions.value.filter(option => !props.options.some(item => item.value === option.value)), ...known.value.filter(value => ![...props.options, ...addedOptions.value].some(option => option.value === value)).map(value => ({ value, label: t('{value}（自定义）', { value }) }))]);
const filtered = computed(() => options.value.filter(option => normalized(`${option.label} ${option.value} ${(option.searchTerms || []).join(' ')}`).includes(normalized(search.value))));
const canCreate = computed(() => !!props.createOption && !!query.value && !options.value.some(option => [option.label, ...(option.searchTerms || [])].some(term => normalized(term) === normalized(query.value))));
watch(search, () => { createError.value = ''; created.value = false; });
const labels = computed(() => new Map(options.value.map(option => [option.value, option.label])));
function toggle(values: string[], value: string): string[] { return props.multiple ? values.includes(value) ? values.filter(item => item !== value) : [...values, value] : [value]; }
function publish(values: string[]) { if (!props.disabled) emit('update:modelValue', props.multiple ? values : values[0] ?? ''); }
async function open() {
  if (props.disabled) return;
  pending.value = [...selected.value]; search.value = ''; createError.value = ''; created.value = false; opened.value = true;
  await nextTick(); dialog.value?.showModal();
}
function close() { if (creating.value) return; dialog.value?.close(); opened.value = false; trigger.value?.focus(); }
function confirm() { if (creating.value) return; publish(pending.value); close(); }
async function create() {
  if (!props.createOption || !canCreate.value || creating.value || props.disabled) return;
  creating.value = true; createError.value = ''; created.value = false;
  try {
    const option = await props.createOption(query.value);
    if (!alive) return;
    addedOptions.value = [...addedOptions.value.filter(item => item.value !== option.value), option];
    pending.value = props.multiple ? [...new Set([...pending.value, option.value])] : [option.value];
    created.value = true;
  } catch (error) { if (alive) createError.value = errorMessage(error); }
  finally { creating.value = false; }
}
watch(() => props.disabled, disabled => { if (disabled && opened.value) close(); });
onBeforeUnmount(() => { alive = false; dialog.value?.close(); });
</script>
<template>
  <div class="field field-inline choice-field" :class="{ 'choice-multiple': multiple, 'choice-preview-field': preview, 'choice-compact': compact }" :data-field="name">
    <span :id="`${id}-label`" :class="{ 'sr-only': compact }">{{ label }}</span>
    <fieldset v-if="!compact && !createOption && options.length <= 5" class="choice-options" :disabled="disabled" :aria-labelledby="`${id}-label`">
      <label v-for="option in options" :key="option.value" class="choice-tile" :class="{ selected: selected.includes(option.value) }">
        <input :type="multiple ? 'checkbox' : 'radio'" :name="name" :value="option.value" :checked="selected.includes(option.value)" @change="publish(toggle(selected, option.value))" />
        <ChoicePreview :value="option.value" :kind="preview" /><span>{{ option.label }}</span>
      </label>
      <small v-if="!options.length" class="muted">{{ t("暂无可选项，请先添加关联内容。") }}</small>
    </fieldset>
    <button v-else ref="trigger" type="button" class="secondary choice-trigger" :name="name" :disabled="disabled" aria-haspopup="dialog" :aria-expanded="opened" :aria-labelledby="compact && !selected.filter(Boolean).length ? `${id}-label` : `${id}-label ${id}-value`" :title="compact && selected.filter(Boolean).length ? selected.filter(Boolean).map(value => labels.get(value) || value).join(' · ') : undefined" @click="open">
      <ChoicePreview v-if="!multiple" :value="selected[0] || ''" :kind="preview" />
      <template v-if="compact"><Icon v-if="icon" :name="icon" :size="16" /><span :id="`${id}-value`">{{ selected.filter(Boolean).length ? selected.filter(Boolean).map(value => labels.get(value) || value).join(' · ') : label }}</span><span v-if="selected.filter(Boolean).length" class="choice-count">{{ selected.filter(Boolean).length }}</span></template>
      <template v-else><span :id="`${id}-value`">{{ multiple ? t("选择{p0}{p1}", { p0: label, p1: selected.length ? t("（已选 {p0} 项）", { p0: selected.length }) : '' }) : labels.get(selected[0]) || t("请选择…") }}</span><span aria-hidden="true">⌄</span></template>
    </button>
    <div v-if="!compact && multiple && selected.length" class="selected-choices" :aria-label="t('已选{p0}', { p0: label })">
      <button v-for="(value, index) in selected" :key="`${value}-${index}`" type="button" :disabled="disabled" :aria-label="t('移除{p0}：{p1}', { p0: label, p1: labels.get(value) || value })" @click="publish(selected.filter((_, i) => i !== index))">{{ labels.get(value) || value }} <span aria-hidden="true">×</span></button>
    </div>
    <small v-if="hint" class="muted">{{ hint }}</small>
    <Teleport to="body"><dialog v-if="opened" ref="dialog" class="selection-dialog" :class="{ 'selection-visual': preview, 'selection-creatable': createOption }" :aria-labelledby="`${id}-title`" :aria-busy="creating" @cancel.prevent="close" @click="($event.target === dialog) && close()">
      <div class="selection-panel"><div class="card-heading"><h2 :id="`${id}-title`">{{ label }}</h2><button type="button" class="text-button" :disabled="creating" @click="close">{{ t("取消") }}</button></div>
        <label class="field selection-search"><span>{{ t("搜索选项") }}</span><input v-model="search" type="search" :disabled="creating" @keydown.enter.prevent autofocus :placeholder="searchPlaceholder || t('输入名称搜索…')" /></label>
        <div v-if="createOption" class="selection-create">
          <button v-if="canCreate || creating" type="button" class="selection-create-action" :disabled="creating || disabled" @click="create"><Icon name="plus" :size="17" /><span>{{ creating ? t('正在创建…') : t(createLabel || '创建「{title}」', { title: query }) }}</span></button>
          <p v-if="createError" class="notice error" role="alert">{{ t(createError) }}</p>
          <p v-else-if="created && createdHint" class="muted small" role="status">{{ createdHint }}</p>
          <p v-else-if="createHint" class="muted small">{{ createHint }}</p>
        </div>
        <fieldset class="selection-results" :disabled="creating" :aria-label="label"><label v-for="option in filtered" :key="option.value" class="choice-tile" :class="{ selected: pending.includes(option.value) }"><input :type="multiple ? 'checkbox' : 'radio'" :name="`${name}-dialog`" :value="option.value" :checked="pending.includes(option.value)" @change="pending = toggle(pending, option.value)" /><ChoicePreview :value="option.value" :kind="preview" /><span>{{ option.label }}</span></label><p v-if="!filtered.length" class="muted">{{ t(createOption ? (query ? '没有匹配的话题，可以直接创建。' : '暂无话题，输入名称即可创建。') : options.length ? "没有匹配的选项" : "暂无可选项，请先添加关联内容。") }}</p></fieldset>
        <div class="selection-footer"><small class="muted">{{ multiple ? t("已选 {p0} 项", { p0: pending.length }) : t("单选") }} · {{ t("共 {count} 项", { count: options.length }) }}</small><button type="button" class="primary" :disabled="creating || disabled || (!multiple && !options.some(option => option.value === pending[0]))" @click="confirm">{{ t("确认选择") }}</button></div>
      </div>
    </dialog></Teleport>
  </div>
</template>
