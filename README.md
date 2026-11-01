# Astro Theme WonderShine

一个为创作者设计的 Astro 静态博客主题，支持文章、动态、话题、系列、中英文内容与独立 Creator Studio。

本仓库是独立主题源码，演示内容和插图均为虚构示例；不包含维护者的个人博客数据。当前版本为本地开发预览，尚未发布到 npm。

## 开始使用

- **新建博客**：[从零搭建](docs/getting-started.md)，从空目录到独立站点、第一篇文章和创作中心。
- **已有 Zola 博客**：[迁移到 Astro](docs/migration.md)，保留旧站，在新目录转换内容并核对历史链接。

主题源码、个人站点和 Creator Studio 各自独立。以下「本地运行」预览的是仓库内的 Demo；自己的内容请按上面的指南放进独立站点。

## 本地运行

需要 Node.js 22.23.4 或更高版本。

```sh
npm ci
npm run dev
```

- `npm run build`：编译主题资源并构建完整 Demo。
- `npm run build:starter`：构建最小 Starter。
- `npm run check`：主题和 Studio 类型检查。
- `npm test`：主题与 Studio 单元测试。
- `npm run test:integration`：Studio 写入 → Astro 构建集成测试。
- `npm run test:package`：打包主题，在临时独立目录安装并构建 Starter。
- `npm run audit:distribution`：检查个人数据和旧运行时路径是否进入源码。

## 目录与所有权

| 目录 | 用途 |
| --- | --- |
| `packages/theme` | Astro Integration、组件、默认配置、翻译与资源 |
| `apps/studio` | 独立创作中心，使用服务端环境变量指向站点 |
| `examples/starter` | 可复制的最小站点 |
| `examples/demo` | 展示文章、动态、话题、系列及特殊页面的示例 |
| `docs` | 配置、迁移、部署与发布说明 |

主题更新仅更新依赖，不覆盖使用者的 `content/`、`public/`、`config.toml` 或 `data*.toml`。

## 在独立站点使用

按 [从零搭建](docs/getting-started.md) 打包主题、复制 Starter，并把主题包保存到新站 `vendor/`。使用 `file:vendor/<主题包文件名>.tgz` 相对依赖，让其他设备和 CI 也能安装。正式发布后可换为 npm 版本号。

```js
import { defineConfig } from 'astro/config';
import wondershine from '@wondershine/theme';
export default defineConfig({ integrations: [wondershine()] });
```

主题拥有路由入口。`public/css/custom.css` 可覆盖主题样式，组件与布局通过 package exports 可供 Astro 页面显式导入。没有 Tera 模板继承或同路径自动组件覆盖机制。

## 创作中心

```sh
npm run setup -w @wondershine/studio
npm run studio:dev
```

设置 `STUDIO_SITE_ROOT` 为你的独立站点绝对路径；也可以配置 `STUDIO_GIT_URL` 使用 Git 内容仓库。浏览器本地文件模式只写指定站点。在线 Git 模式每次保存会提交并推送；持久工作区模式则分别保存、提交和同步，见 [工作区说明](docs/studio-workspaces.md)。服务端凭据保存在私有环境中。

桌面 App 可直接连接 Git，并在客户端配置 AI API；密钥仅保留在当前连接。它也能连接已有 Studio 服务。构建方法和移动端限制见 [Studio apps](docs/studio-apps.md)。

博客仍为静态站，不需要长期运行 Node.js；浏览器版 Studio 是另一个独立服务。`astro dev` 会响应保存，静态部署必须重新构建。

## 文档

- [从零搭建博客](docs/getting-started.md)
- [从 Zola 主题迁移](docs/migration.md)
- [配置与内容格式](docs/configuration.md)
- [独立部署](docs/deployment.md)
- [本地打包与后续发布](docs/releasing.md)
- [npm 自动发布与 Trusted Publisher 配置](docs/npm-releases.md)
- [WonderShine Studio App 发行](docs/studio-releases.md)
- [来源与第三方代码](NOTICE.md)

沿用原主题的 **AGPL-3.0-or-later** 许可。见 [LICENSE](LICENSE)。
