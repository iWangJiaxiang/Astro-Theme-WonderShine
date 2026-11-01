# Document independent site setup and Zola migration

- [x] Add a Chinese zero-to-site guide with reproducible local package installation, first content, languages, Studio and deployment.
- [x] Expand Zola/WonderShine migration instructions, supported boundaries, preservation checks and rollback.
- [x] Link both routes from project and Studio documentation; distinguish server and App AI configuration.
- [x] Execute the documented independent Starter and migration workflow in temporary fixtures; check links and reader comprehension.

Docs only; preserve existing implementation and personal repositories. No commit, push, publication or deployment.

## Verification — 2026-10-31

- Packed the actual theme with its prepack build.
- Extracted and executed the Node snippets directly from both guides.
- Installed the archive into independent temporary sites, checked that it was not a workspace symlink, and built the Starter with the documented first article.
- Migrated a neutral Zola-format fixture through the real CLI, installed and built the result, and verified unchanged source bytes, converted layouts and exclusion of legacy admin resources.
- Built the Starter again after switching its default language to Chinese, including navigation data and explicit about/thread paths; checked both language route sets.
- Passed `npx tsx --test tests/migration.test.ts` (1 test).
- Independent reader review passed after fixing default-language URL instructions, missing data.toml guidance and the old absolute package dependency example. All 37 relative links in the six documents resolved.
- Removed temporary fixture sites and verification runner after success. Retained the ignored local theme archive for the documented packaging workflow.

Interactive Studio Setup, actual credentials, remote Git and cloud deployment were not executed for this documentation task. These boundaries are documented; no personal content was migrated or changed.
