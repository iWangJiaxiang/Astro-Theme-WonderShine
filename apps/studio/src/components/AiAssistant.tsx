import type { AiCapabilities, AiImageResult } from "../../shared/ai";
import {
  documentDirectory,
  supportsColocatedMedia,
  type MediaUploadResult,
} from "../../shared/media";
import { api, errorMessage } from "../api";
import { t, type Message } from "../i18n";
import { addUploadedMedia } from "../media-store";
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
import { nextTick, onBeforeUnmount, onMounted, ref } from "../reactivity";

type Props = {
  kind: "summary" | "cover";
  title: string;
  text: string;
  language: string;
  path: string;
};
type Events = {
  close: [];
  summary: [value: string];
  cover: [field: string, value: string];
  working: [value: boolean];
};
const AiAssistant: StudioComponent<Props, Events> = component<Props, Events>(
  "AiAssistant",
  (props, emit, expose) => {
    const dialog = ref<HTMLDialogElement>(),
      capabilities = ref<AiCapabilities>(),
      loading = ref(true),
      busy = ref(false),
      error = ref<Message>("");
    const result = ref(""),
      image = ref<AiImageResult>(),
      imagePrompt = ref("");
    const previousFocus = document.activeElement as HTMLElement | null;
    let alive = true;
    onMounted(async () => {
      await nextTick();
      dialog.value?.showModal();
      try {
        capabilities.value = await api<AiCapabilities>("/ai/config");
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
      }
    });
    onBeforeUnmount(() => {
      alive = false;
      dialog.value?.close();
      previousFocus?.focus();
    });
    function close() {
      if (!busy.value) emit("close");
    }
    async function work(fn: () => Promise<void>) {
      if (busy.value) return false;
      busy.value = true;
      error.value = "";
      emit("working", true);
      try {
        await fn();
        return true;
      } catch (e) {
        if (alive) error.value = errorMessage(e);
        return false;
      } finally {
        busy.value = false;
        emit("working", false);
      }
    }
    function generateText() {
      return work(async () => {
        const response = await api<{ text: string }>("/ai/text", "POST", {
          task: props.kind === "summary" ? "summary" : "cover-prompt",
          title: props.title,
          text: props.text,
          language: props.language,
        });
        if (alive) result.value = response.text;
      });
    }
    function generateImage() {
      return work(async () => {
        const prompt = result.value;
        const response = await api<AiImageResult>("/ai/image", "POST", {
          prompt,
        });
        if (alive) {
          image.value = response;
          imagePrompt.value = prompt;
        }
      });
    }
    async function applyCover() {
      const applied = await work(async () => {
        if (!image.value) return;
        const bundled = supportsColocatedMedia(props.path);
        const directory = bundled
          ? documentDirectory(props.path).replace(/\/$/, "")
          : "public/uploads";
        const bytes = Uint8Array.from(atob(image.value.base64), (character) =>
          character.charCodeAt(0),
        );
        const saved = await api<MediaUploadResult>(
          "/media/upload?" +
            new URLSearchParams({
              directory,
              filename: `ai-cover-${crypto.randomUUID()}.${image.value.extension}`,
            }),
          "POST",
          new Blob([bytes], { type: image.value.mime }),
        );
        addUploadedMedia(saved.item);
        if (alive) {
          emit(
            "cover",
            bundled ? "extra.cover" : "extra.global_cover",
            bundled ? saved.item.name : "/" + saved.item.path.slice(7),
          );
        }
      });
      if (applied && alive) emit("close");
    }
    return () =>
      portal(
        element(
          Fragment,
          null,
          element(
            "dialog",
            {
              ref: domRef(dialog),
              "aria-label": t(
                props.kind === "summary" ? "AI 摘要" : "AI 文章封面",
              ),
              className: classes("ai-assistant-dialog"),
              onCancel: domEvent(($event: Event) => {
                $event.preventDefault();
                close();
              }),
              onClick: domEvent(($event: Event) => {
                $event.target === dialog.value && close();
              }),
            },
            element(
              "header",
              { className: classes("card-heading") },
              element(
                "div",
                null,
                element(
                  "p",
                  { className: classes("eyebrow") },
                  t("AI 创作助手"),
                ),
                element(
                  "h2",
                  null,
                  t(props.kind === "summary" ? "AI 摘要" : "AI 文章封面"),
                ),
              ),
              element(
                "button",
                {
                  disabled: busy.value,
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    close();
                  }),
                },
                t("取消"),
              ),
            ),
            element(
              "div",
              {
                "aria-busy": busy.value || loading.value,
                className: classes("ai-assistant-body"),
              },
              loading.value
                ? element(
                    "p",
                    { className: classes("muted") },
                    t("正在读取 AI 配置…"),
                  )
                : !capabilities.value?.text
                  ? element(
                      "p",
                      { className: classes("notice") },
                      t("尚未配置 AI 文本服务，请联系管理员"),
                    )
                  : null,
              props.kind === "cover" &&
                capabilities.value &&
                !capabilities.value.image
                ? element(
                    "p",
                    { className: classes("notice") },
                    t("尚未配置 AI 图片服务，请联系管理员"),
                  )
                : null,
              error.value
                ? element(
                    "p",
                    { role: "alert", className: classes("notice error") },
                    t(error.value),
                  )
                : null,
              element(
                "div",
                { className: classes("ai-source") },
                element(
                  "span",
                  null,
                  t(
                    props.kind === "summary"
                      ? "根据当前正文生成"
                      : "根据当前摘要生成",
                  ),
                ),
                element("strong", null, props.title || t("未命名内容")),
                element(
                  "p",
                  null,
                  props.text.slice(0, 260),
                  props.text.length > 260 ? "…" : "",
                ),
              ),
              element(
                "div",
                { className: classes("ai-step-heading") },
                element(
                  "strong",
                  null,
                  t(props.kind === "summary" ? "摘要预览" : "1 · 图片提示词"),
                ),
                element(
                  "button",
                  {
                    disabled:
                      busy.value ||
                      !capabilities.value?.text ||
                      !props.text.trim(),
                    className: classes("secondary"),
                    onClick: domEvent(($event: Event) => {
                      generateText();
                    }),
                  },
                  t(
                    result.value
                      ? "重新生成"
                      : props.kind === "summary"
                        ? "生成摘要"
                        : "生成提示词",
                  ),
                ),
              ),
              element("textarea", {
                value: result.value ?? "",
                "aria-label": t(
                  props.kind === "summary" ? "AI 摘要结果" : "图片提示词",
                ),
                disabled: busy.value,
                rows: props.kind === "cover" ? 3 : 5,
                placeholder: t("生成后可以直接修改，再决定是否应用。"),
                onInput: domEvent(($event: Event) => {
                  result.value = ($event.target as HTMLInputElement).value;
                }),
              }),
              props.kind === "cover"
                ? element(
                    Fragment,
                    null,
                    element(
                      "div",
                      { className: classes("ai-step-heading") },
                      element("strong", null, t("2 · 封面预览")),
                      element(
                        "button",
                        {
                          disabled:
                            busy.value ||
                            !capabilities.value?.image ||
                            !result.value.trim(),
                          className: classes("secondary"),
                          onClick: domEvent(($event: Event) => {
                            generateImage();
                          }),
                        },
                        t(image.value ? "重新生成图片" : "生成图片"),
                      ),
                    ),
                    element(
                      "div",
                      { className: classes("ai-image-preview") },
                      image.value
                        ? element("img", {
                            src: `data:${image.value.mime};base64,${image.value.base64}`,
                            alt: t("AI 封面预览"),
                          })
                        : element(
                            "span",
                            { className: classes("muted") },
                            t("确认提示词后生成图片"),
                          ),
                    ),
                    image.value && result.value !== imagePrompt.value
                      ? element(
                          "p",
                          { className: classes("muted small") },
                          t("提示词已修改，请重新生成图片后应用。"),
                        )
                      : null,
                  )
                : null,
              busy.value
                ? element(
                    "p",
                    { role: "status", className: classes("muted") },
                    t("正在处理，请稍候…"),
                  )
                : null,
            ),
            element(
              "footer",
              { className: classes("selection-footer") },
              element(
                "span",
                { className: classes("muted small") },
                t(
                  props.kind === "summary"
                    ? "应用后仍需保存文章。"
                    : "应用时保存图片到仓库；文章仍需保存。",
                ),
              ),
              props.kind === "summary"
                ? element(
                    "button",
                    {
                      disabled: busy.value || !result.value.trim(),
                      className: classes("primary"),
                      onClick: domEvent(($event: Event) => {
                        emit("summary", result.value.trim());
                        emit("close");
                      }),
                    },
                    t("应用摘要"),
                  )
                : element(
                    "button",
                    {
                      disabled:
                        busy.value ||
                        !image.value ||
                        result.value !== imagePrompt.value,
                      className: classes("primary"),
                      onClick: domEvent(($event: Event) => {
                        applyCover();
                      }),
                    },
                    t("保存并设为封面"),
                  ),
            ),
          ),
        ),
      );
  },
  {},
);
export default AiAssistant;
