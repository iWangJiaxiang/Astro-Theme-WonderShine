# 配置与内容格式

站点根目录保留 `config.toml`、`data.toml`、`data.<语言>.toml`、`content/`、`public/`。主题包默认值先加载，再由站点配置覆盖。空数组可明确关闭默认列表。

```toml
base_url = "https://example.com"
title = "My blog"
author = "Alex"
default_language = "en"
[languages.zh-CN]
title = "我的博客"
```

文章采用 TOML frontmatter：

```markdown
+++
title = "Hello"
layout = "post"
date = 2026-01-01
[extra]
cover = "cover.svg"
+++
正文写在这里。
```

- `index.md` 是默认语言，`index.zh-CN.md` 是对应译文；`_index.md` 是目录设置。
- `layout` 选择 Astro 页面布局，`child_layout` 设置目录下内容的默认布局。
- 支持 `index`、`post`、`archives`、`notes`、`note`、`timeline`、`topics`、`topic`、`collection-list`、`collection-category`、`collection-detail`、`collection-content`、`empty`、`about`、`friends`、`equipment`、`music`、`wechat`。
- 动态源码在 `content/notes/<UUID>/index.md`；公开地址为 `/thread/<UUID>/`，由 Studio 维护。
- 话题是独立内容，标签与分类仍在 `taxonomies` 下。系列是有章节的目录，音乐专辑仍可使用系列组件配置展示。
- 草稿不公开。未来日期是否公开由配置控制；静态网站到期后仍须重新构建。
- `extra.references` 的站内文章引用按内容路径保存，渲染时优先当前语言。
- `extra.ai_translation`、翻译来源和审核状态仍由 Studio 维护。
- 内置 `image` 与 `subscribe_list` shortcode 是主题提供的 Markdown 扩展，不运行 Tera。其他自定义 Tera 模板不能自动移植。

`extra.locale.<语言>` 覆盖主题设置；`data.<语言>.toml` 覆盖数据。主题界面翻译位于包内 `locales/`，站点可通过 `translations.theme_<key>`、`languages.<语言>.translations.theme_<key>` 覆盖文案，也可设置 `extra.i18n.catalog_path` 指向自有词典。

资源优先级为主题内置资源 → 旧格式兼容 `static/` → `public/`，同名资源以站点版本为准。新站点和 Studio 统一写入 `public/`。同目录文章媒体可直接写相对路径。

搜索默认关闭。现有界面支持配置 Meilisearch 或 Algolia；本次没有新增本地搜索服务或自动 Pagefind 索引。评论、音乐和统计同样需配置自己的服务，不继承维护者的生产配置。

主题保留 ClientRouter、首次加载与导航 loading、中等/移动宽度布局、深浅色与语言持久化。`extra.nav.compact_paths` 可指定中等宽度收纳到“更多”的菜单地址。
