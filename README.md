# Astro Theme WonderShine

一个为创作者设计的 Astro 静态博客主题，支持文章、动态、话题、系列、中英文内容与独立 Creator Studio。

本仓库是独立主题源码，演示内容和插图均为虚构示例；不包含维护者的个人博客数据。当前版本为本地开发预览，尚未发布到 npm。

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

首次本地打包：

```sh
npm run build:theme
npm pack ./packages/theme --pack-destination /tmp
```

复制 `examples/starter` 到独立目录，将其中 `@wondershine/theme` 的依赖改为生成的 `.tgz` 的绝对 `file:` 地址，然后运行 `npm install` 和 `npm run dev`。正式发布后再换为 npm 版本号。

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

设置 `STUDIO_SITE_ROOT` 为你的独立站点绝对路径；也可以配置 `STUDIO_GIT_URL` 使用 Git 内容仓库。凭据只保存在 Studio 服务端环境中。Studio 的 Git 模式会写入并推送所配置的内容仓库，请按实际部署需求启用；本次提取和验证只使用本地或临时测试仓库。

博客仍为静态站，不需要长期运行 Node.js；Studio 是另一个独立服务。`astro dev` 会响应保存，静态部署必须重新构建。

## 文档

- [配置与内容格式](docs/configuration.md)
- [从旧站点迁移](docs/migration.md)
- [独立部署](docs/deployment.md)
- [本地打包与后续发布](docs/releasing.md)
- [来源与第三方代码](NOTICE.md)

沿用原主题的 **AGPL-3.0-or-later** 许可。见 [LICENSE](LICENSE)。
