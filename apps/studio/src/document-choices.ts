import type { Choice } from '../shared/choices';

export const documentChoices: Record<string, Choice[]> = {
  layout: [
    { value: 'post', label: '文章' },
    { value: 'empty', label: '普通页面' },
    { value: 'about', label: '关于' },
    { value: 'friends', label: '友链' },
    { value: 'music', label: '音乐' },
    { value: 'equipment', label: '装备' },
    { value: 'wechat', label: '微信' },
    { value: 'archives', label: '归档' },
    { value: 'collection-list', label: '合集分组' },
    { value: 'collection-detail', label: '系列 / 专辑详情' },
    { value: 'collection-content', label: '章节 / 曲目' },
    { value: 'collection-category', label: '合集分类' },
  ],
  child_layout: [
    { value: 'collection-content', label: '章节 / 曲目' },
    { value: 'post', label: '文章' },
    { value: 'empty', label: '普通页面' },
  ],
  insert_anchor_links: [
    { value: 'none', label: '不显示' },
    { value: 'left', label: '标题左侧' },
    { value: 'right', label: '标题右侧' },
    { value: 'heading', label: '整个标题' },
  ],
};
