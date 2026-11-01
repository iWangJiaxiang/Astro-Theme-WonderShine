import { glyphs, spriteURL, symbolChoices } from "../icons";
import {
  classes,
  component,
  element,
  type StudioComponent,
} from "../react-component";

type Props = { value: string; kind?: string };
type Events = {};
const ChoicePreview: StudioComponent<Props, Events> = component<Props, Events>(
  "ChoicePreview",
  (props, emit, expose) => {
    return () =>
      props.kind === "icon" && glyphs.has(props.value)
        ? element(
            "span",
            { "aria-hidden": "true", className: classes("studio-glyph") },
            glyphs.get(props.value),
          )
        : props.kind === "symbol" &&
            symbolChoices.some((option) => option.value === props.value)
          ? element(
              "svg",
              { "aria-hidden": "true", className: classes("symbol-preview") },
              element("use", { href: `${spriteURL}#${props.value}` }),
            )
          : props.kind === "emoji"
            ? element(
                "span",
                { "aria-hidden": "true", className: classes("emoji-preview") },
                props.value,
              )
            : null;
  },
  {},
);
export default ChoicePreview;
