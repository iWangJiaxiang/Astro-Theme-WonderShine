# @wondershine/theme

Astro theme Integration for articles, threads, topics and multilingual publishing.

Use `wondershine()` in `astro.config.mjs`. The consumer owns `config.toml`, `data*.toml`, `content/`, `public/`, and optional `compatibility/heading-aliases.json`. Theme defaults, locales and assets are loaded from this package.

Options: `siteRoot` selects the content directory (default: Astro project root). `ASTRO_SITE_ROOT`, `ASTRO_SITE_URL`, and `ASTRO_OUT_DIR` support isolated builds. A build process handles one site at a time.

Custom CSS: `public/css/custom.css`. Exported components: `@wondershine/theme/components/*`; layouts: `@wondershine/theme/layouts/*`. No Tera renderer, submodule or personal site checkout is required.

License: AGPL-3.0-or-later. Source: https://github.com/iWangJiaxiang/Astro-Theme-WonderShine

Install a channel in your blog and commit the resulting manifest and lockfile:

| Channel | Audience | Command |
| --- | --- | --- |
| latest | Stable sites (default) | `npm install --save-exact @wondershine/theme@latest` |
| next | Public beta and release candidate testers | `npm install --save-exact @wondershine/theme@next` |
| canary | Maintainer blog following verified main changes | `npm install --save-exact @wondershine/theme@canary` |

Run the command again to update. Check channel versions with `npm view @wondershine/theme dist-tags`.

Verified main changes publish directly to npm canary. Beta and RC use GitHub prereleases, and stable versions use full GitHub Releases. Manual runs validate the packed package without publishing. See `docs/npm-releases.md` in the source repository for trusted publisher setup and prerelease rules.
