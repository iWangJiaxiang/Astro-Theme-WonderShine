import { locale, setLocale, t } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  type StudioComponent,
} from "../react-component";

type Props = {};
type Events = {};
const LanguageSwitcher: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "LanguageSwitcher",
  (props, emit, expose) => {
    return () =>
      element(
        "label",
        { className: classes("language-switcher") },
        element("span", { className: classes("sr-only") }, t("界面语言")),
        element(
          "select",
          {
            value: locale.value,
            "aria-label": t("界面语言"),
            onChange: domEvent(($event: Event) => {
              setLocale(($event.target as HTMLSelectElement).value);
            }),
          },
          element("option", { value: "en" }, "English"),
          element("option", { value: "zh-CN" }, "简体中文"),
        ),
      );
  },
  {},
);
export default LanguageSwitcher;
