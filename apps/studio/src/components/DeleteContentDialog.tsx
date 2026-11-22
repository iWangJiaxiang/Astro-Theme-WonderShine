import { ErrorNotice } from "./ErrorNotice";
import { translationLocation } from "../../shared/translation";
import type { Article, ContentLanguages, DocumentVersion } from "../../shared/types";
import { api, ApiError, errorMessage, session } from "../api";
import { contentLabel } from "../content-model";
import { forgetDeletedContent } from "../deleted-content";
import { t, type Message } from "../i18n";
import { createBusinessModal } from "../modal-layer";
import {
  classes,
  component,
  domEvent,
  domRef,
  element,
  Fragment,
  portal,
  type StudioComponent,
} from "../react-component";
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
} from "../reactivity";
import "./delete-content.css";

type Props = {
  path: string;
  title?: string;
  revision?: string | null;
  unsaved?: boolean;
};
type Events = { deleted: [paths: string[]]; close: []; working: [value: boolean] };
const DeleteContentDialog: StudioComponent<Props, Events> = component<
  Props,
  Events
>(
  "DeleteContentDialog",
  (props, emit, expose) => {
    const id = useId(),
      dialog = ref<HTMLDialogElement>(),
      heading = ref<HTMLHeadingElement>();
    const loading = ref(true),
      deleting = ref(false),
      error = ref<Message>(""),
      blocked = ref(false);
    const language = ref(""),
      loadedTitle = ref(""),
      revision = ref<string | null>(null);
    const allLanguages = ref(false),
      versions = ref<DocumentVersion[]>([]);
    const path = props.path,
      expectedRevision = props.revision;
    const deletionIdentity = session.value?.identity;
    const title = computed(
      () => props.title?.trim() || loadedTitle.value || t("未命名内容"),
    );
    const busy = computed(() => loading.value || deleting.value);
    let alive = true, wantsOpen = true,
      previousFocus: HTMLElement | null = null;
    const modal = createBusinessModal(() => dialog.value, () => alive && wantsOpen, () => {
      heading.value?.focus();
    });
    async function load() {
      loading.value = true;
      error.value = "";
      blocked.value = false;
      emit("working", true);
      try {
        const [document, languages] = await Promise.all([
          api<Article>(`/document?path=${encodeURIComponent(path)}`),
          api<ContentLanguages>("/content-languages"),
        ]);
        if (!alive) return;
        language.value = translationLocation(
          path,
          languages.defaultLanguage,
          languages,
        ).sourceLanguage;
        loadedTitle.value = contentLabel(
          document.body,
          document.metadata.title,
        );
        // A caller's revision represents what the user edited. Never silently advance it.
        revision.value =
          expectedRevision === undefined ? document.revision : expectedRevision;
        if (!revision.value || revision.value !== document.revision) {
          blocked.value = true;
          error.value =
            "内容版本已变化，请关闭此窗口，重新打开内容检查后再删除。";
        }
      } catch (cause) {
        if (alive) {
          error.value = errorMessage(cause);
          blocked.value = true;
        }
      } finally {
        if (alive) {
          loading.value = false;
          emit("working", false);
        }
      }
    }
    async function selectScope(all: boolean) {
      allLanguages.value = all;
      error.value = "";
      if (!all || busy.value || blocked.value) return;
      versions.value = [];
      loading.value = true;
      emit("working", true);
      try {
        const result = await api<DocumentVersion[]>(`/document/versions?path=${encodeURIComponent(path)}`);
        if (!alive) return;
        if (result.find(version => version.path === path)?.revision !== revision.value) {
          blocked.value = true;
          error.value = "语言版本已变化，请重新打开删除窗口。";
        } else {
          versions.value = result;
        }
      } catch (cause) {
        if (alive) error.value = errorMessage(cause);
      } finally {
        if (alive) {
          loading.value = false;
          emit("working", false);
        }
      }
    }
    function close() {
      if (deleting.value) return;
      wantsOpen = false;
      modal.close();
      emit("close");
    }
    async function remove() {
      if (busy.value || blocked.value || !revision.value || (allLanguages.value && !versions.value.length)) return;
      deleting.value = true;
      error.value = "";
      emit("working", true);
      try {
        const paths = allLanguages.value ? versions.value.map(version => version.path) : [path];
        if (allLanguages.value) {
          const revisions = Object.fromEntries(versions.value.map(version => [version.path, version.revision]));
          await api("/document/versions", "DELETE", { path, revisions });
        } else {
          await api("/document", "DELETE", { path, revision: revision.value });
        }
        try {
          if (deletionIdentity) {
            for (const removed of paths) forgetDeletedContent(localStorage, deletionIdentity, removed);
          }
        } catch {
          /* localStorage itself can be inaccessible. */
        }
        if (alive) emit("deleted", paths);
      } catch (cause) {
        if (!alive) return;
        error.value = errorMessage(cause);
        // Retrying a conflict must not fetch a new revision and delete unseen changes.
        if (
          cause instanceof ApiError &&
          (cause.status === 409 || cause.status === 404)
        )
          blocked.value = true;
      } finally {
        if (alive) {
          deleting.value = false;
          emit("working", false);
        }
      }
    }
    onMounted(async () => {
      previousFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      if (!alive) return;
      modal.open();
      void load();
    });
    onBeforeUnmount(() => {
      alive = false;
      modal.dispose();
      emit("working", false);
      if (previousFocus?.isConnected) previousFocus.focus();
    });
    return () =>
      portal(
        element(
          Fragment,
          null,
          element(
            "dialog",
            {
              ref: domRef(dialog),
              "aria-labelledby": `${id}-title`,
              "aria-describedby": `${id}-scope`,
              "aria-busy": busy.value,
              className: classes("delete-content-dialog"),
              onCancel: domEvent(($event: Event) => {
                $event.preventDefault();
                close();
              }),
              onClick: domEvent(($event: Event) => {
                $event.target === dialog.value && close();
              }),
            },
            element(
              "form",
              {
                className: classes("delete-content-panel"),
                onSubmit: domEvent(($event: Event) => {
                  $event.preventDefault();
                  remove();
                }),
              },
              element("h2", { id: `${id}-title`, ref: domRef(heading), tabIndex: -1 }, t("删除内容")),
              <label className="field delete-content-scope">
                <span>{t("删除范围")}</span>
                <select value={allLanguages.value ? "all" : "current"} disabled={busy.value || blocked.value}
                  onChange={event => void selectScope(event.currentTarget.value === "all")}>
                  <option value="current">{t("当前语言版本")}</option>
                  <option value="all">{t("全部语言版本")}</option>
                </select>
              </label>,
              element(
                "p",
                { id: `${id}-scope` },
                t(allLanguages.value ? "删除以下所有语言的内容文件，图片等资源会保留。网站将在下次构建与部署后更新。" :
                  "只删除当前语言的内容文件，其他语言版本和图片等资源会保留。网站将在下次构建与部署后更新。",
                ),
              ),
              element(
                "dl",
                { className: classes("delete-content-details") },
                element("dt", null, t("标题")),
                element("dd", null, title.value),
                (allLanguages.value ? versions.value : [{ language: language.value || t("正在读取…"), path }]).map(version =>
                  <Fragment key={version.path}><dt>{version.language}</dt><dd className="delete-content-path">{version.path}</dd></Fragment>
                ),
              ),
              props.unsaved
                ? element(
                    "p",
                    { className: classes("notice") },
                    t(
                      "当前编辑器有未保存的更改，删除后这些更改和本地草稿备份也会丢弃。",
                    ),
                  )
                : null,
              loading.value
                ? element(
                    "p",
                    { role: "status", className: classes("muted") },
                    t("正在检查内容版本…"),
                  )
                : null,
              error.value
                ? element(
                    ErrorNotice,
                    { source: "DeleteContentDialog", message: error.value },
                  )
                : null,
              blocked.value && revision.value
                ? element(
                    "p",
                    { className: classes("muted small") },
                    t("请关闭此窗口，检查内容或解除引用后再试。"),
                  )
                : null,
              element(
                "div",
                { className: classes("delete-content-actions") },
                element(
                  "button",
                  {
                    type: "button",
                    disabled: deleting.value,
                    className: classes("secondary"),
                    onClick: domEvent(($event: Event) => {
                      close();
                    }),
                  },
                  t("取消"),
                ),
                element(
                  "button",
                  {
                    type: "submit",
                    disabled: busy.value || blocked.value || !revision.value || (allLanguages.value && !versions.value.length),
                    className: classes("delete-content-confirm"),
                  },
                  t(deleting.value ? "正在删除…" : allLanguages.value ? "确认删除全部语言" : "确认删除当前语言"),
                ),
              ),
            ),
          ),
        ),
      );
  },
  {},
);
export default DeleteContentDialog;
