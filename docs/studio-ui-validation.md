# Studio responsive and mobile interaction validation

Studio shares a React DOM interface between browsers and Tauri WebViews. Responsive Chromium evidence is not native iOS/Android acceptance.

## Remote-only verification

`.github/workflows/studio-ui-audit.yml` builds isolated synthetic fixtures and runs:

- `form-audit.mjs`: inventories global settings, fixture pages, template setting groups, content libraries, editor modes and reachable shared dialogs. Each surface records its actual size/gesture coverage and failures in `test-results/form-audit/report.json` and `report.md`.
- `root-modals-runner.mjs`: native HTML dialog focus containment, nested choice dialogs, creation resume and actual expired-session authentication over AI/delete dialogs. No mutation is automatically replayed after authentication.
- `native-ui.mjs`: production native adapters with a synthetic Tauri IPC host. Optional `STUDIO_TEST_GESTURES=true` collects CDP scroll/pinch observations alongside native fixture screenshots. These are not real OS locks, system gesture recognizers or WebView measurements.

Do not run project installation/build/test locally. Inspect downloaded CI screenshots as well as the structured report. A blocked surface or unavailable gesture is an explicit coverage gap, not a pass.

## Shared interface contracts

- Business dialogs share an authentication-aware activation owner: pending opens cannot overtake the blocking reauthentication modal; cancellation/unmount disposes pending activation without replaying operations.
- The app never cancels intentional pinch zoom or installs a maximum viewport scale. Text inputs have a mobile 16 CSS px floor to avoid accidental focus zoom; this is not a substitute for Dynamic Type or OS magnification testing.
- Shared touch sizing includes login, first-run screens and body portals. Native Android targets use 48 CSS px, iOS uses 44 CSS px; actual device logical-point mapping still needs device validation.
- `accessibility.css` owns common visible-viewport constraints. The visual viewport tracker also runs in browsers, so keyboard/zoom offsets can inform dialogs and save popups. Below 360 visible CSS px, dialogs fall back from fixed chrome plus inner results scrolling to one scrollable surface, keeping confirmation reachable.
- Phone form labels stack above fields rather than compressing inputs next to desktop label columns. Repeated-item actions receive a separate row. Desktop retains compact form rhythm.
- Navigation position is memory-only, after the existing leave guard succeeds. New destinations start at their heading; returning to the same library restores viewport context when content is ready. User input cancels queued restoration, and slow requests do not expire it before the destination is ready. No editor content or credentials enter history/URLs, and this does not implement browser/Android Back routing.
- Narrow media libraries move to the selected image details and provide a return-to-tile control; desktop keeps the side-by-side inspector.

## Required physical-device follow-up

Use at least one iPhone and one Android device, plus tablet portrait/landscape where supported. For every top-level page, template setting group, editor mode and dialog:

1. Scroll down and up with a finger, including over controls and inside nested lists. Confirm no scroll trap, unreachable footer or unexpected activation.
2. Pinch in and out; pan while magnified. Confirm deliberate zoom is available and actions remain reachable. Compare this with OS text sizing rather than treating it as equivalent.
3. Open the keyboard in the first and last field; rotate while editing. Confirm caret, error feedback, Cancel and Save remain accessible above the keyboard and system insets.
4. Check system Back/edge navigation, background/resume, modal dismissal and unsaved drafts. Current app navigation does not promise an OS-native history stack.
5. Repeat important flows in dark appearance, increased text size and Reduce Motion. Check VoiceOver/TalkBack labels, reading/focus order, announcements and touch exploration.

Record OS/device/build, surface, orientation, gesture and result. CI screenshots cannot establish these outcomes, physical latency or App Store/TestFlight readiness.
