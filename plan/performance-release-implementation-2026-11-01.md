# Performance and release implementation

Approved scope: implement the Lighthouse/image plan, resolve Actions version annotations, change Studio identifier to `wang.jiaxiang.wondershine-studio`, and add npm publishing for the theme. Preserve navigation, loading, languages, comments and editing. All builds, tests and packaging run in remote CI; no local build or App packaging.

## Work items

- [x] Theme runtime: remove unnecessary libraries from initial pages; build-time code highlighting; load page capabilities safely through ClientRouter; remove duplicated global/page CSS; fix observed accessibility and SEO findings.
- [x] Images: unify Markdown picture output, dimensions and sizes; honor AVIF configuration; improve component coverage without discarding originals; verify temporal LCP evidence before changing loading priority.
- [x] Actions: inspect actual annotations, update incompatible/deprecated official actions and pin runner OS where relevant; identify external runner notices separately.
- [x] Studio: update application identifier and references; document application-data identity implications; verify all platform builds remotely.
- [x] npm: separate theme version/tag from Studio, dry-run package validation, version checks and trusted publishing, document required npm-side configuration. Do not publish a public package during validation.
- [x] Review, push, run CI and Lighthouse against the changed SHA, compare the same production demo pages and preserve regression evidence.

## Verification

Behavior tests cover escaped/unknown code, language transitions and toolbar interactions, Markdown images and AVIF disabled, publication version/ref mismatch and dry-run safety. Remote browser checks cover first load and navigation Loading, no unnecessary Prism/KaTeX requests on home/timeline, code rendering and copy/fold, Chinese/English switching and viewport overflow. Run existing unit, type, package, distribution and browser checks in CI, plus desktop/Android/iOS builds for the identifier/action updates. Re-measure 5 pages × 2 devices × 3 cold runs.

## Review focus

ClientRouter first-load vs subsequent navigation ordering; vendor dependencies and late callbacks after navigation; no content XSS from build-time highlighting/images; responsive source and cache consistency; npm publishing from an immutable matching tag only, without turning manual verification into publishing; old desktop application data remains untouched after the identifier change.

## Outcome

All scoped implementation and remote validation completed. See [results](performance-release-results-2026-11-01.md) for actual measurements, CI runs, annotations, external npm setup and retained limitations.
