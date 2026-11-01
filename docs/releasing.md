# 打包与发布

主题与 Studio 源码托管在 Astro-Theme-WonderShine；主题包和 App 使用各自的发行流程。

推荐在 GitHub Actions 的 **Theme npm package** 中手动运行远程 dry-run，完成打包、独立安装与浏览器验证。正式主题发行使用 `theme-vX.Y.Z` Release，经验证后通过 OIDC 发布 npm；预发布进入 `next`。首次 npm 权限配置、触发规则与失败恢复见 [npm 自动发布](npm-releases.md)。普通手动运行不会发布公共包。

下列命令供需要手动打包的主题开发者使用；本项目验收在远程 CI 执行：

1. `npm ci`
2. `npm run build`
3. `npm run check && npm test && npm run test:integration`
4. `npm run audit:distribution && npm run test:package`
5. 查看 `npm pack ./packages/theme --dry-run`，确认只有主题 runtime、组件、资源、默认值与翻译。

主题的 `prepack` 会从源码重建资源，不依赖已存在的 ignored 输出。打包白名单不包含个人内容、examples、Studio、测试、缓存或服务端状态。测试从实际 `.tgz` 安装到新目录，避免工作区链接掩盖缺文件问题。

正式发布前确认 npm scope 和包权限、版本号、变更日志及 Trusted Publisher 配置。主题包公开源代码受 AGPL-3.0-or-later 约束，保持 LICENSE 和第三方来源声明。

升级主题：在个人站点修改依赖版本并更新 lockfile。文章和图片不属于主题包，不随升级被覆盖。Starter 当前依赖本地 workspace 版本；尚未发布时，复制使用需改为本地 `.tgz`。

## 主题与个人站点的回归

主题 CI 构建 Demo 后运行 `npm run test:browser`，覆盖内容页面、ClientRouter、语言切换、1165px 和 390px 布局，并保留截图。可通过 `STUDIO_TEST_BROWSER` 指定 Chrome。

个人站点可以复用 `scripts/test-browser.mjs`：传入 JSON 文件，包含相对于配置文件的 `siteRoot`、`pages`（截图名称与路径的数组）和 `navigation`（`path`、`language`、`translatedPath`）。先构建站点；脚本会自动启动与关闭独立 preview，不接触已有服务。

建议站点以 submodule 固定主题提交，并安装从该提交打出的实际 tgz。主题仓库只使用中性 Demo；站点自己的 CI 使用真实内容回归。升级时提交 submodule 指针、包文件、依赖和 lockfile，通过预览验证后再部署。常规 push / PR CI 仅验证与上传构建产物；正式 npm 发布由上述 Release 工作流负责，不部署个人网站。


## 更新独立站点中的本地包

在主题源码目录切换到要验证的版本，安装依赖并重新打包：

```sh
npm ci
mkdir -p temp/theme-pack
npm pack ./packages/theme --pack-destination temp/theme-pack
```

将生成的包复制到博客 `vendor/`。开发阶段即使包内版本未变，也应使用不同的归档文件名，例如 `wondershine-theme-0.1.0-<源码提交短号>.tgz`，避免新旧包混用。随后在博客根目录执行（将示例文件名替换为实际值）：

```sh
npm install "./vendor/wondershine-theme-0.1.0-<源码提交短号>.tgz"
npm run build
npm run preview
```

命令中的 `<源码提交短号>` 是占位符，必须替换后再执行。若源码有未提交改动，不要把归档标成某个干净提交的产物。检查内容页面和布局后，保存主题包、依赖清单、lockfile，以及使用 submodule 时的源码指针。其他设备只需取得站点仓库并运行 `npm ci`，无需访问打包机器的绝对路径。

## Studio App 发行

Studio 独立使用 `studio-vX.Y.Z` 标签，支持 Actions 手动发布。桌面和移动 App 的构建及测试只在远程 CI 执行。平台矩阵、Android/iOS 签名、TestFlight 和应用更新提醒见 [Studio App 发行](studio-releases.md)。上面的主题 npm 包流程不用于 Studio App 打包。
