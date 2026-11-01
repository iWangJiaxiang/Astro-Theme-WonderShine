import { t } from "../i18n";
import type { MediaDirectory } from "../media-tree";
import {
  classes,
  component,
  domEvent,
  element,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { ref, watch } from "../reactivity";

type Props = { node: MediaDirectory; selected: string; depth: number };
type Events = { select: [path: string] };
const MediaDirectoryNode: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "MediaDirectoryNode",
  (props, emit, expose) => {
    const expanded = ref(props.depth < 1);
    watch(
      () => props.selected,
      (value) => {
        if (value.startsWith(props.node.path + "/")) expanded.value = true;
      },
    );
    return () =>
      element(
        "li",
        null,
        element(
          "div",
          {
            className: classes("media-directory-row", {
              active: props.selected === props.node.path,
            }),
            style: Object.assign({}, { paddingLeft: `${props.depth * 12}px` }),
          },
          props.node.children.length
            ? element(
                "button",
                {
                  "aria-expanded": expanded.value,
                  "aria-label": t("展开或收起 {name}", {
                    name: props.node.path,
                  }),
                  className: classes("directory-disclosure"),
                  onClick: domEvent(($event: Event) => {
                    expanded.value = !expanded.value;
                  }),
                },
                expanded.value ? "⌄" : "›",
              )
            : element("span", { className: classes("directory-spacer") }),
          element(
            "button",
            {
              "aria-current":
                props.selected === props.node.path ? "location" : undefined,
              title: props.node.path,
              className: classes("directory-choice"),
              onClick: domEvent(($event: Event) => {
                emit("select", props.node.path);
              }),
            },
            element(
              "span",
              null,
              props.node.path === "public"
                ? t("公共图片")
                : props.node.path === "content"
                  ? t("内容配图")
                  : props.node.name,
            ),
            element("small", null, props.node.count),
          ),
        ),
        expanded.value && props.node.children.length
          ? element(
              "ul",
              null,
              renderList(props.node.children).map((child) =>
                element(MediaDirectoryNode, {
                  key: child.path,
                  node: child,
                  selected: props.selected,
                  depth: props.depth + 1,
                  onSelect: (($event) => {
                    emit("select", $event);
                  }) satisfies EventHandler<
                    typeof MediaDirectoryNode,
                    "onSelect"
                  >,
                }),
              ),
            )
          : null,
      );
  },
  {},
);
export default MediaDirectoryNode;
