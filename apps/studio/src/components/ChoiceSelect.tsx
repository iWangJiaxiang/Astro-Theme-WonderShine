import type { Choice } from "../../shared/choices";
import type { Json } from "../../shared/types";
import {
  component,
  element,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import SelectionField from "./SelectionField";

type Props = {
  modelValue: Json;
  options: Choice[];
  name: string;
  label: string;
  disabled?: boolean;
  hint?: string;
  compact?: boolean;
  icon?: string;
};
type Events = { "update:modelValue": [value: Json] };
const ChoiceSelect: StudioComponent<Props, Events> = component<Props, Events>(
  "ChoiceSelect",
  (props, emit, expose) => {
    return () =>
      element(SelectionField, {
        modelValue: props.modelValue,
        options: props.options,
        name: props.name,
        label: props.label,
        disabled: props.disabled,
        hint: props.hint,
        compact: props.compact,
        icon: props.icon,
        multiple: true,
        onUpdateModelValue: (($event) => {
          emit("update:modelValue", $event);
        }) satisfies EventHandler<typeof SelectionField, "onUpdateModelValue">,
      });
  },
  {},
);
export default ChoiceSelect;
