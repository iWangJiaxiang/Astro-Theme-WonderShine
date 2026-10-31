<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue';
import type { Json } from '../../shared/types';
import { dateParts } from '../../shared/form-fields';
import { publicationDateDraft, publicationDateValue } from '../publication-date';
import { t } from '../i18n';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: Json | undefined; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId(), dialog = ref<HTMLDialogElement>(), trigger = ref<HTMLButtonElement>();
const opened = ref(false), pending = ref(publicationDateDraft(''));
const parts = computed(() => dateParts(String(props.modelValue || '')));
const pendingValue = computed(() => publicationDateValue(pending.value));
const zone = (value?: string) => value && /^[zZ]$/.test(value) ? 'UTC' : value || '';
async function open() {
  if (props.disabled) return;
  pending.value = publicationDateDraft(String(props.modelValue || '')); opened.value = true;
  await nextTick(); dialog.value?.showModal();
}
function close() { dialog.value?.close(); opened.value = false; trigger.value?.focus(); }
function apply() {
  if (props.disabled || !pendingValue.value) return;
  emit('update:modelValue', pendingValue.value); close();
}
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <div class="note-date-field">
    <span :id="`${id}-label`">{{ t('发布时间') }}</span>
    <button ref="trigger" type="button" class="note-date-trigger" :class="{ 'date-missing': !parts }" :disabled="disabled" :aria-label="t('修改发布时间')" :aria-describedby="`${id}-value`" aria-haspopup="dialog" :aria-expanded="opened" @click="open">
      <span v-if="parts" :id="`${id}-value`" class="note-date-value">{{ parts.date.replaceAll('-', '/') }}<small v-if="parts.time">{{ parts.time.slice(0, 5) }} <span>{{ zone(parts.zone) }}</span></small></span>
      <span v-else :id="`${id}-value`">{{ t('设置发布时间') }}</span>
      <span class="note-date-edit"><Icon name="pen" :size="13" />{{ t('修改') }}</span>
    </button>
    <Teleport to="body">
      <dialog v-if="opened" ref="dialog" class="publication-date-dialog" :aria-labelledby="`${id}-title`" @cancel.prevent="close" @click="($event.target === dialog) && close()">
        <form @submit.prevent="apply">
          <div class="card-heading"><h2 :id="`${id}-title`">{{ t('发布时间') }}</h2><button type="button" class="text-button" @click="close">{{ t('取消') }}</button></div>
          <div class="publication-date-fields">
            <label class="field field-inline"><span>{{ t('日期') }}</span><input v-model="pending.date" type="date" required autofocus :aria-label="t('发布日期')" /></label>
            <label class="field field-inline"><span>{{ t('时间') }}</span><input type="time" required step="0.001" :aria-label="t('发布时间')" :value="pending.time.slice(0, 12)" @input="pending.time = ($event.target as HTMLInputElement).value" /></label>
            <p v-if="!pendingValue" class="danger small" role="alert">{{ t('请填写有效的日期和时间') }}</p>
            <details class="publication-date-help"><summary>{{ t('时间与时区说明') }}<span>{{ zone(pending.zone) }}</span></summary><p>{{ t('修改日期时保留原时区与时间精度，修改时间时保留原时区。此设置不会自动定时发布。') }}</p><p v-if="!parts?.zone">{{ t('旧内容未指定时区，应用后使用 UTC。') }}</p></details>
          </div>
          <div class="selection-footer"><button type="submit" class="primary" :disabled="disabled || !pendingValue">{{ t('应用时间') }}</button></div>
        </form>
      </dialog>
    </Teleport>
  </div>
</template>
