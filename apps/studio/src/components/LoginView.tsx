import { api, errorMessage, reauthentication, session } from "../api";
import { t, type Message } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  Fragment,
  type StudioComponent,
} from "../react-component";
import { onMounted, ref } from "../reactivity";
import Icon from "./Icon";
import LanguageSwitcher from "./LanguageSwitcher";
import LoadingState from "./LoadingState";

type Props = {};
type Events = {};
const LoginView: StudioComponent<Props, Events> = component<Props, Events>(
  "LoginView",
  (props, emit, expose) => {
    const username = ref(""),
      password = ref(""),
      busy = ref(false),
      error = ref<Message>("");
    const methods = ref<{
      password: boolean;
      oidc: {
        label: string;
      } | null;
    } | null>(null);
    async function loadMethods() {
      error.value = "";
      try {
        methods.value = await api("/auth/config");
      } catch (e) {
        error.value = errorMessage(e);
      }
    }
    onMounted(async () => {
      await loadMethods();
      if (new URLSearchParams(location.search).has("login")) {
        error.value =
          new URLSearchParams(location.search).get("login") === "denied"
            ? "此身份没有管理权限，请联系站点管理员。"
            : "统一身份登录未完成，请重新尝试。";
        history.replaceState(null, "", "/");
      }
    });
    async function login() {
      busy.value = true;
      error.value = "";
      try {
        session.value = await api("/auth/login", "POST", {
          username: username.value,
          password: password.value,
        });
        reauthentication.value = false;
        password.value = "";
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        busy.value = false;
      }
    }
    return () =>
      element(
        "main",
        { className: classes("login-page") },
        element(
          "div",
          { className: classes("login-language") },
          element(LanguageSwitcher, null),
        ),
        element(
          "section",
          { className: classes("login-intro") },
          element(
            "div",
            { className: classes("brand") },
            element(
              "span",
              { className: classes("brand-mark") },
              "W",
              element("span", null, "·"),
            ),
            element(
              "div",
              null,
              "Wonder Shine",
              element("small", null, t("为创造者而生")),
            ),
          ),
          element(
            "div",
            null,

            element(
              "h1",
              null,
              t("让想法，"),
              element("br", null),
              t("成为下一篇故事。"),
            ),
            element(
              "p",
              { className: classes("login-description") },
              t("文章、专栏与站点设置，"),
              element("br", null),
              t("都在你的创作中心。"),
            ),
          ),
          element(
            "div",
            { className: classes("login-foot") },
            element("span", { className: classes("status-dot") }),
            " ",
            t("你的内容，你的站点。"),
          ),
        ),
        element(
          "section",
          { className: classes("login-panel card") },
          element(
            "div",
            { className: classes("login-symbol") },
            element(Icon, { name: "pen", size: 28 }),
          ),
          element("h2", null, t("欢迎回来")),

          error.value
            ? element(
                "p",
                { role: "alert", className: classes("notice error") },
                t(error.value),
                " ",
                !methods.value
                  ? element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          loadMethods();
                        }),
                      },
                      t("重试连接"),
                    )
                  : null,
              )
            : null,
          methods.value?.password
            ? element(
                "form",
                {
                  onSubmit: domEvent(($event: Event) => {
                    $event.preventDefault();
                    login();
                  }),
                },
                element(
                  "label",
                  { className: classes("field field-inline") },
                  element("span", null, t("账号")),
                  element("input", {
                    value: username.value ?? "",
                    name: "username",
                    autoComplete: "username",
                    required: true,
                    autoFocus: true,
                    placeholder: t("管理员账号"),
                    onInput: domEvent(($event: Event) => {
                      username.value = (
                        $event.target as HTMLInputElement
                      ).value;
                    }),
                  }),
                ),
                element(
                  "label",
                  { className: classes("field field-inline") },
                  element("span", null, t("密码")),
                  element("input", {
                    value: password.value ?? "",
                    name: "password",
                    type: "password",
                    autoComplete: "current-password",
                    required: true,
                    placeholder: t("输入密码"),
                    onInput: domEvent(($event: Event) => {
                      password.value = (
                        $event.target as HTMLInputElement
                      ).value;
                    }),
                  }),
                ),
                element(
                  "button",
                  { disabled: busy.value, className: classes("primary wide") },
                  busy.value ? t("正在登录…") : t("进入创作中心"),
                  element(Icon, { name: "arrow" }),
                ),
              )
            : null,
          methods.value?.oidc
            ? element(
                Fragment,
                null,
                methods.value.password
                  ? element(
                      "div",
                      { className: classes("divider") },
                      t("或使用统一身份"),
                    )
                  : null,
                element(
                  "a",
                  {
                    href: "/api/auth/oidc/start",
                    className: classes("button secondary wide"),
                  },
                  element(Icon, { name: "lock" }),
                  methods.value.oidc.label === "统一身份登录"
                    ? t("统一身份登录")
                    : methods.value.oidc.label,
                ),
              )
            : null,
          !methods.value && !error.value
            ? element(LoadingState, {
                label: "正在连接管理中心…",
                compact: true,
              })
            : null,
          element(
            "details",
            { className: classes("login-help") },
            element("summary", null, t("首次使用或无法登录？")),
            element(
              "p",
              null,
              t(
                "使用 npm run setup 时设置的管理员账号和密码。这里没有公开注册入口，Git 账号不能直接用于登录。",
              ),
            ),
            element(
              "p",
              null,
              t(
                "忘记密码时，管理员可运行 npm run password 生成新哈希，更新服务端配置并重启。OIDC 用户请使用统一身份入口。",
              ),
            ),
            element(
              "p",
              null,
              t(
                "连接失败时运行 npm run doctor；完整步骤见 docs/deployment.md。",
              ),
            ),
          ),
          element(
            "p",
            { className: classes("login-note") },
            t("仅向站点管理员开放 · 内容仓库凭据由服务端保管"),
          ),
        ),
      );
  },
  {},
);
export default LoginView;
