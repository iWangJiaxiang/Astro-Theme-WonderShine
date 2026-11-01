import { pageProfile } from "../../shared/page-settings";
import { t } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, ref, watch } from "../reactivity";
import SettingsView from "./SettingsView";

type Props = { layout: string; body: string; language: string };
type Events = { dirty: [value: boolean] };
const PageSettings: StudioComponent<Props, Events> = component<Props, Events>(
  "PageSettings",
  (props, emit, expose) => {
    const profile = computed(() => pageProfile(props.layout, props.body));
    const active = ref(""),
      dirty = ref(false);
    watch(
      () => profile.value.groups.map((group) => group.id).join(","),
      () => {
        if (!profile.value.groups.some((group) => group.id === active.value))
          active.value = profile.value.groups[0]?.id || "";
      },
      { immediate: true },
    );
    function updateDirty(value: boolean) {
      dirty.value = value;
      emit("dirty", value);
    }
    return () =>
      element(
        "section",
        {
          "aria-label": t("页面专属设置"),
          className: classes("page-template-settings"),
        },
        element(
          "div",
          { className: classes("template-intro") },
          element(
            "h2",
            null,
            t("{name}设置", { name: t(profile.value.label) }),
          ),
          !profile.value.groups.length
            ? element("p", null, t(profile.value.description))
            : null,
          profile.value.groups.length
            ? element(
                "p",
                { className: classes("muted small") },
                t("同语言、同模板的页面共享设置，需单独保存。"),
              )
            : null,
        ),
        profile.value.groups.length
          ? element(
              "div",
              { className: classes("template-settings-layout") },
              element(
                "nav",
                {
                  "aria-label": t("页面配置分组"),
                  className: classes("settings-group-tabs"),
                },
                renderList(profile.value.groups).map((group) =>
                  element(
                    "button",
                    {
                      key: group.id,
                      disabled: dirty.value && active.value !== group.id,
                      className: classes({ active: active.value === group.id }),
                      onClick: domEvent(($event: Event) => {
                        active.value = group.id;
                      }),
                    },
                    t(group.label),
                  ),
                ),
              ),
              dirty.value
                ? element(
                    "p",
                    { className: classes("muted small") },
                    t(
                      "请先保存当前设置，或通过「放弃更改并重新加载」丢弃修改，再切换配置分组。",
                    ),
                  )
                : null,
              props.language
                ? element(SettingsView, {
                    key: `${active.value}:${props.language}`,
                    group: active.value,
                    language: props.language,
                    embedded: true,
                    onDirty: updateDirty satisfies EventHandler<
                      typeof SettingsView,
                      "onDirty"
                    >,
                  })
                : null,
            )
          : null,
      );
  },
  {},
);
export default PageSettings;
