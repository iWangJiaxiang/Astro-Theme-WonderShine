# 配置与内容格式

站点根目录保留 `config.toml`、`data.toml`、`data.<语言>.toml`、`content/`、`public/`。主题包默认值先加载，再由站点配置覆盖。对象按字段合并，数组整体替换而非追加；空数组可明确关闭默认列表。

本文入口：[基础配置与内容](#基础配置与内容) · [导航配置](#导航配置) · [动态与订阅](#动态与订阅)。首次建站见 [从零搭建](getting-started.md)，已有 Astro 站点更新依赖见 [主题升级](upgrading.md)。

## 基础配置与内容

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
- 支持 `index`、`post`、`archives`、`threads`、`thread`、`timeline`、`topics`、`topic`、`collection-list`、`collection-category`、`collection-detail`、`collection-content`、`empty`、`about`、`friends`、`equipment`、`music`、`wechat`。
- 动态源码在 `content/threads/<UUID>/index.md`；公开地址为 `/threads/<UUID>/`，由 Studio 维护。
- 话题是独立内容，标签与分类仍在 `taxonomies` 下。系列是有章节的目录，音乐专辑仍可使用系列组件配置展示。
- 草稿、`render = false`、未来发布时间及草稿目录下的内容不公开；当前实现没有发布未来内容的配置开关。静态网站到期后仍须重新构建。
- `extra.references` 的站内文章引用按内容路径保存，渲染时优先当前语言。
- `extra.ai_translation`、翻译来源和审核状态仍由 Studio 维护。
- 内置 `image` 与 `subscribe_list` shortcode 是主题提供的 Markdown 扩展，不运行 Tera。其他自定义 Tera 模板不能自动移植。

`extra.locale.<语言>` 覆盖主题设置；`data.<语言>.toml` 覆盖数据。主题界面翻译位于包内 `locales/`，站点可通过 `translations.theme_<key>`、`languages.<语言>.translations.theme_<key>` 覆盖文案，也可设置 `extra.i18n.catalog_path` 指向自有词典。

资源优先级为主题内置资源 → 旧格式兼容 `static/` → `public/`，同名资源以站点版本为准。新站点和 Studio 统一写入 `public/`。同目录文章媒体可直接写相对路径。

搜索默认关闭。现有界面支持配置 Meilisearch 或 Algolia；本次没有新增本地搜索服务或自动 Pagefind 索引。评论、音乐和统计同样需配置自己的服务，不继承维护者的生产配置。

## 导航配置

导航内容写在站点的 `data.toml`，不是 `config.toml`。以下示例将时间线放入动态的子菜单；请修改已有 `menu.nav_menu` 列表，不要直接追加一份重复菜单：

```toml
[[menu.nav_menu]]
name = "Articles"
href = "/articles/"

[[menu.nav_menu]]
name = "Threads"
href = "/threads/"

[[menu.nav_menu.menus]]
name = "Timeline"
href = "/timeline/"

[[menu.nav_menu]]
name = "About"
href = "/about/"
```

`data.zh-CN.toml` 可用相同结构填写中文名称与 `/zh-CN/articles/` 等地址（以 English 为默认语言的 Starter 为例）。语言文件中的 `menu.nav_menu` 会替换整个列表，应保留该语言所需的全部菜单。导航链接不会创建页面：独立关于页仍需对应内容，目录列表仍需 `_index.md`。保留 Starter 的 `content/threads/_index.md` 和 `content/timeline/_index.md` 及所需译文，主题根据其中的布局生成聚合页面。

主题保留 ClientRouter、首次加载与导航 loading、中等/移动宽度布局、深浅色与语言持久化。中等宽度收纳到“更多”的菜单在 **`config.toml`** 配置：

```toml
[extra.nav]
compact_paths = ["/about", "/zh-CN/about"]
```

这里填写菜单原始 `href` 去掉尾斜杠后的值；若菜单显式带语言前缀，此列表也要包含该前缀。默认值是 `["/friends", "/about"]`，设为 `[]` 可取消收纳。

桌面与移动导航共用 `menu.nav_menu`。启用动态功能后，未配置的 `/threads/`、`/timeline/` 入口默认插入第一个菜单之后；如果任意层级的菜单已显式配置对应地址（含语言前缀及有无尾斜杠），则不再重复插入该入口。可将时间线放在动态菜单的子项中。移动导航的无子项菜单直接跳转，有子项菜单使用原生折叠控件；设置了 `href` 的分组在展开后提供主链接，紧凑导航的“更多”分组同样保留主链接。

## 动态与订阅

`config.toml` 的 `[extra.activity]` 下 `enable = true` 启用动态与话题；主题默认启用。关闭后，动态与话题内容不会进入公开查询，自动动态导航入口也不再添加。手写导航不会因此自动删除，请同步检查菜单。

推荐由 Studio 创建 UUID 和译文；手工维护时可参考 Starter 的 `content/threads/`。例如 `content/threads/11111111-2222-4333-8444-555555555555/index.md`：

```markdown
+++
title = ""
layout = "thread"
date = "2026-01-02T10:00:00Z"
path = "threads/11111111-2222-4333-8444-555555555555"

[extra]
kind = "thread"
id = "11111111-2222-4333-8444-555555555555"

[[extra.references]]
kind = "internal"
path = "articles/welcome/index.md"
+++

一条日常记录，也可以引用本站文章。
```

每条新动态使用不同 UUID；目录、`extra.id` 与详情 `path` 保持一致。译文放在同目录 `index.zh-CN.md`，保留相同 `extra.id`，显式 `path` 改为 `zh-CN/threads/<UUID>`（默认语言不是中文时）。列表目录使用 `layout = "threads"`，详情使用 `layout = "thread"`，不要混用。

`extra.references[].path` 是相对 `content/` 的 Markdown 源路径，不是 `/articles/welcome/` 这样的网址。内部引用支持 `articles/` 和非 `collections/album/` 的系列内容，不支持 `_index.md`；解析时优先当前语言，再回退到默认语言与其他公开译文。草稿和未来内容不会通过引用公开。

`/threads/` 展示动态，`/timeline/` 汇合文章与动态。需要动态和时间线订阅时，在 `config.toml` **第一个表头之前的顶层**设置：

```toml
generate_feeds = true
feed_filenames = ["atom.xml", "threads.xml", "timeline.xml"]
```

Starter 只设置 `generate_feeds = true`，未指定文件名时默认为 `atom.xml`，不会自动产生 `threads.xml`。支持的文件名为 `atom.xml`、`rss.xml`、`threads.xml`、`timeline.xml`；可在 `[languages.zh-CN]` 等语言表中覆盖订阅设置。默认语言订阅为 `/threads.xml`，译文订阅为 `/zh-CN/threads.xml`。上线前检查列表、详情、译文、引用和实际 XML 输出；旧动态路径迁移见 [迁移指南](migration.md#多语言动态与分类)。
