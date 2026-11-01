import { t } from "../i18n";
import {
  classes,
  component,
  element,
  renderList,
  type StudioComponent,
} from "../react-component";
import { onBeforeUnmount, ref } from "../reactivity";
import "./LoadingState.css";

type Props = { label: string; compact: boolean };
type Events = {};
const LoadingState: StudioComponent<Props, Events> = component<Props, Events>(
  "LoadingState",
  (props, emit, expose) => {
    const slow = ref(false);
    const timer = setTimeout(() => {
      slow.value = true;
    }, 8000);
    onBeforeUnmount(() => clearTimeout(timer));
    return () =>
      element(
        "div",
        { className: classes("loading-panel", { compact: props.compact }) },
        element(
          "div",
          {
            role: "status",
            "aria-live": "polite",
            className: classes("loading-caption"),
          },
          element("span", {
            "aria-hidden": "true",
            className: classes("loading-spinner"),
          }),
          element(
            "div",
            null,
            element("strong", null, t(props.label)),
            element(
              "p",
              null,
              t(
                slow.value
                  ? "加载比平时久一些，仍在等待服务器响应。"
                  : "首次打开可能需要稍等片刻。",
              ),
            ),
          ),
        ),
        !props.compact
          ? element(
              "div",
              { "aria-hidden": "true", className: classes("loading-skeleton") },
              renderList(3).map((row) =>
                element(
                  "div",
                  { key: row, className: classes("skeleton-row") },
                  element("span", { className: classes("skeleton-icon") }),
                  element(
                    "div",
                    null,
                    element("span", { className: classes("skeleton-line") }),
                    element("span", {
                      className: classes("skeleton-line short"),
                    }),
                  ),
                ),
              ),
            )
          : null,
      );
  },
  { compact: false },
);
export default LoadingState;
