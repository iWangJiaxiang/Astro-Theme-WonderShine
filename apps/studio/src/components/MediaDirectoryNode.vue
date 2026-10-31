<script setup lang="ts">
import { ref, watch } from 'vue';
import { t } from '../i18n';
import type { MediaDirectory } from '../media-tree';
const props = defineProps<{ node: MediaDirectory; selected: string; depth: number }>();
const emit = defineEmits<{ select: [path: string] }>();
const expanded = ref(props.depth < 1);
watch(() => props.selected, value => { if (value.startsWith(props.node.path + '/')) expanded.value = true; });
</script>
<template><li><div class="media-directory-row" :class="{ active: selected === node.path }" :style="{ paddingLeft: `${depth * 12}px` }"><button v-if="node.children.length" class="directory-disclosure" :aria-expanded="expanded" :aria-label="t('展开或收起 {name}', { name: node.path })" @click="expanded = !expanded">{{ expanded ? '⌄' : '›' }}</button><span v-else class="directory-spacer"></span><button class="directory-choice" :aria-current="selected === node.path ? 'location' : undefined" :title="node.path" @click="emit('select', node.path)"><span>{{ node.path === 'public' ? t('公共图片') : node.path === 'content' ? t('内容配图') : node.name }}</span><small>{{ node.count }}</small></button></div><ul v-if="expanded && node.children.length"><MediaDirectoryNode v-for="child in node.children" :key="child.path" :node="child" :selected="selected" :depth="depth + 1" @select="emit('select', $event)" /></ul></li></template>
