<script setup lang="ts">
import { ref, watch } from 'vue';
import { t } from '../i18n';
import Icon from './Icon.vue';
const props = defineProps<{ identityKey: string; mode?: string; expanded?: boolean }>();
const emit = defineEmits<{ navigate: [view: string] }>();
const dismissed = ref(false), showingSteps = ref(false);
const storageKey = () => `studio-guide:v1:${props.identityKey}`;
watch(() => props.identityKey, () => {
  try { dismissed.value = localStorage.getItem(storageKey()) === 'dismissed'; }
  catch { dismissed.value = false; }
}, { immediate: true });
function dismiss() {
  dismissed.value = true;
  try { localStorage.setItem(storageKey(), 'dismissed'); } catch { /* Dismiss for this visit if storage is unavailable. */ }
}
const steps = [
  { view: 'site', icon: 'globe', title: '确认站点信息', description: '设置站点名称、简介和正式网址；界面语言不会改变主站语言。' },
  { view: 'taxonomies', icon: 'tag', title: '准备标签与分类', description: '先维护名称，再在文章中选择；已有文章里的旧标签会保留。' },
  { view: 'media', icon: 'image', title: '准备写作图片', description: '上传图片或选择仓库已有图片。上传立即保存，选图后仍需保存表单。' },
  { view: 'article', icon: 'pen', title: '写下第一篇草稿', description: '创建文章，选择标签和分类，保存草稿；准备好后再设为已发布。' },
  { view: 'note', icon: 'pen', title: '记录一条动态', description: '直接写正文，标题可选；每条动态独立发布，也可以添加语言版本。' },
  { view: 'topic', icon: 'tag', title: '用话题串联内容', description: '创建话题介绍，再在文章或动态中选择关联；标签与分类仍按原来的方式使用。' },
];
</script>
<template>
  <section v-if="expanded || !dismissed" class="card getting-started" :class="{ 'guide-page': expanded }" aria-labelledby="guide-title">
    <div class="guide-heading"><div><p class="eyebrow">{{ t('创作中心入门') }}</p><component :is="expanded ? 'h1' : 'h2'" id="guide-title">{{ expanded ? t('使用指南') : t('从这里开始') }}</component><p class="muted">{{ t('按需要完成这些步骤，随时可以开始写作。') }}</p></div><button v-if="!expanded" class="text-button" @click="dismiss">{{ t('收起入门指引') }}</button></div>
    <p v-if="mode && (expanded || showingSteps)" class="guide-connection"><span class="status-dot" />{{ mode === 'git' ? t('正在使用 Git 内容仓库。保存会提交到配置的分支。') : t('正在使用本地站点。保存会直接修改站点文件。') }}</p>
    <button v-if="!expanded" class="text-button guide-toggle" :aria-expanded="showingSteps" @click="showingSteps = !showingSteps">{{ showingSteps ? t("收起步骤") : t("查看入门步骤") }}</button>
    <div v-if="expanded || showingSteps" class="guide-steps"><button v-for="(step, index) in steps" :key="step.view" class="guide-step" @click="emit('navigate', step.view)"><span class="guide-number">{{ index + 1 }}</span><span><strong>{{ t(step.title) }}</strong><small>{{ t(step.description) }}</small></span><Icon name="arrow" /></button></div>
    <div v-if="expanded || showingSteps" class="guide-publish"><strong>{{ t('保存之后，如何上线？') }}</strong><p>{{ mode === 'git' ? t('Git 保存成功后，到主站部署平台查看构建结果。后台不会自动为你创建发布流程。') : t('本地保存后，在站点根目录运行 npm run dev 预览，或运行 npm run build 构建发布。') }}</p><p>{{ t('「已发布」是内容状态，网站需要完成部署才能显示最新内容；未来日期的动态或话题还需到期后重新构建。') }}</p></div>
    <p v-if="!expanded && showingSteps" class="muted small">{{ t('关闭后可从左侧「使用指南」重新查看。') }}</p>
    <template v-if="expanded">
      <h2>{{ t('常见问题') }}</h2>
      <details><summary>{{ t('话题、标签和系列有什么区别？') }}</summary><p>{{ t('标签和分类用于稳定归类；话题连接持续更新的文章与动态；文章系列和音乐专辑仍在「合集管理」中维护，原有链接保留。') }}</p></details>
      <details><summary>{{ t('修改话题介绍会让话题排到前面吗？') }}</summary><p>{{ t('不会。最近内容更新时间取自当前语言中已公开的关联文章和动态。话题资料修改和读者评论不会改变它；没有关联内容时不显示内容活动时间。') }}</p></details>
      <details><summary>{{ t('关联了话题，为什么前台没有显示？') }}</summary><p>{{ t('请确认话题已发布、发布时间已到，并且有当前内容语言的版本，再重新构建网站。草稿话题和缺少当前语言版本的话题不会显示公开链接。') }}</p></details>
      <details><summary>{{ t('后台账号、Git token 和 OIDC 有什么区别？') }}</summary><p>{{ t('后台账号或 OIDC 用来登录；Git token 用来读取和提交内容仓库。它们分别配置，不能互相代替。密钥只放在服务端环境变量。') }}</p></details>
      <details><summary>{{ t('图片上传后为什么主站还看不到？') }}</summary><p>{{ t('上传只把文件保存到内容仓库。还需要在文章或表单中选用、保存，并完成主站部署。取消选图不会删除已经上传的文件。') }}</p></details>
      <details><summary>{{ t('友链图标为什么有两个地址？') }}</summary><p>{{ t('「本地图标」用于预览和选择图片；「备用图标地址」只保留地址，后台不会自动拉取。') }}</p></details>
      <details><summary>{{ t('保存冲突或登录过期怎么办？') }}</summary><p>{{ t('遇到保存冲突，先下载备份，再重新加载并合并修改。登录过期请重新登录；未保存的草稿不是已经提交到仓库的内容。') }}</p></details>
      <details><summary>{{ t('如何修改账号、仓库或启用 OIDC？') }}</summary><p>{{ t('修改服务端 .env 或部署平台环境变量，然后重启或重新部署。npm run setup 仅用于首次创建配置；npm run doctor 可以检查现有配置。详细说明在主题 docs/deployment.md。') }}</p></details>
      <details><summary>{{ t('页面正文和页面设置有什么区别？') }}</summary><p>{{ t('正文与属性管理当前页面；页面设置管理模板使用的配置。两者分别保存，同模板页面可能共用设置。') }}</p></details>
    </template>
  </section>
</template>
