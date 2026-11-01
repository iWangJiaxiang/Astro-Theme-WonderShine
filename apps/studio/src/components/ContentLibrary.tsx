import { collectionChoices, taxonomyChoices } from "../../shared/choices";
import {
  collectionRoot,
  displayTitle,
  isLibraryItem,
  isSection,
  parentSection,
  sectionDirectory,
  sectionTrail,
  sortLibrary,
} from "../../shared/library";
import { childLayoutChoices, pageProfile } from "../../shared/page-settings";
import { translationLocation } from "../../shared/translation";
import type {
  ArticleSummary,
  ContentLanguages,
  Json,
  Settings,
} from "../../shared/types";
import { api, errorMessage } from "../api";
import { t, translateOptions, type Message } from "../i18n";
import {
  classes,
  component,
  domEvent,
  element,
  Fragment,
  renderList,
  type EventHandler,
  type StudioComponent,
} from "../react-component";
import { computed, onMounted, ref, watch } from "../reactivity";
import DeleteContentDialog from "./DeleteContentDialog";
import Icon from "./Icon";
import LoadingState from "./LoadingState";
import SelectionField from "./SelectionField";

type Props = { kind: "article" | "page" | "collection"; folder?: string };
type Events = {
  open: [path: string];
  create: [path: string, metadata: Record<string, Json>];
  browse: [path: string];
  deleted: [path: string];
  working: [value: boolean];
};
const ContentLibrary: StudioComponent<Props, Events> = component<Props, Events>(
  "ContentLibrary",
  (props, emit, expose) => {
    const deleteTarget = ref<ArticleSummary>();
    function deleted(path: string) {
      items.value = items.value.filter((item) => item.path !== path);
      deleteTarget.value = undefined;
      pageNumber.value = Math.min(pageNumber.value, pages.value);
      emit("deleted", path);
      void load(true);
    }
    const items = ref<ArticleSummary[]>([]),
      search = ref(""),
      status = ref("all"),
      error = ref<Message>(""),
      loading = ref(true);
    const folder = ref(props.folder || collectionRoot),
      pageNumber = ref(1),
      pageSize = 20;
    const tagLabels = ref(new Map<string, string>()),
      categoryLabels = ref(new Map<string, string>());
    const creating = ref(false),
      title = ref(""),
      slug = ref(""),
      parent = ref(""),
      subtype = ref("collection"),
      articleCollection = ref(""),
      childLayout = ref("empty");
    const languages = ref<ContentLanguages>(),
      language = ref(""),
      createLanguage = ref("");
    const languageItems = computed(() =>
      items.value.filter((item) => !item.lang || item.lang === language.value),
    );
    const root = computed(() =>
      languages.value
        ? translationLocation(collectionRoot, language.value, languages.value)
            .path
        : collectionRoot,
    );
    const canonical = (path: string) =>
      languages.value
        ? translationLocation(
            path,
            languages.value.defaultLanguage,
            languages.value,
          ).path
        : path;
    const atRoot = computed(() => canonical(folder.value) === collectionRoot);
    const parents = computed(() =>
      collectionChoices(
        items.value,
        subtype.value === "chapter",
        createLanguage.value,
      ),
    );
    const collections = computed(() =>
      collectionChoices(items.value, true, createLanguage.value),
    );
    watch(
      subtype,
      () => {
        parent.value = "";
      },
      { flush: "sync" },
    );
    watch([search, status, folder, language], () => {
      pageNumber.value = 1;
    });
    const creatingAlbum = computed(
      () => parent.value === "album" || parent.value.startsWith("album/"),
    );
    function contentLabel(item: ArticleSummary) {
      if (!isSection(item))
        return item.path.startsWith("content/collections/album/")
          ? "曲目"
          : "章节";
      if (item.render === false || item.layout === "collection-list")
        return "分组";
      return item.path.startsWith("content/collections/album/")
        ? "专辑"
        : "系列";
    }
    const names = { article: "文章", page: "页面", collection: "合集管理" };
    const currentSection = computed(() =>
      items.value.find((item) => item.path === folder.value),
    );
    const trail = computed(() =>
      sectionTrail(folder.value, languageItems.value),
    );
    const searchable = computed(
      () => !!search.value.trim() || status.value !== "all",
    );
    const visible = computed(() =>
      languageItems.value.filter(
        (item) => item.kind === props.kind && isLibraryItem(item),
      ),
    );
    const filtered = computed(() =>
      sortLibrary(
        visible.value.filter((item) => {
          const text = [
            displayTitle(item),
            item.description,
            ...item.tags.map((tag) => tagLabels.value.get(tag) || tag),
            ...item.categories.map(
              (category) => categoryLabels.value.get(category) || category,
            ),
            ...sectionTrail(item.path, languageItems.value).map(displayTitle),
          ]
            .join(" ")
            .toLowerCase();
          const matches =
            text.includes(search.value.trim().toLowerCase()) &&
            (status.value === "all" ||
              (status.value === "draft"
                ? item.draft
                : !item.draft && item.render !== false && !item.error));
          return (
            matches &&
            (props.kind !== "collection" ||
              searchable.value ||
              canonical(parentSection(item, languageItems.value)) ===
                canonical(folder.value))
          );
        }),
        props.kind,
      ),
    );
    const pages = computed(() =>
      Math.max(1, Math.ceil(filtered.value.length / pageSize)),
    );
    const rows = computed(() =>
      filtered.value.slice(
        (pageNumber.value - 1) * pageSize,
        pageNumber.value * pageSize,
      ),
    );
    function browse(path: string) {
      folder.value = path;
      search.value = "";
      status.value = "all";
      emit("browse", path);
    }
    function openItem(item: ArticleSummary) {
      if (props.kind === "collection" && isSection(item)) browse(item.path);
      else emit("open", item.path);
    }
    function sectionCount(item: ArticleSummary) {
      const children = visible.value.filter(
        (child) =>
          child.path !== item.path &&
          child.path.startsWith(sectionDirectory(item.path)),
      );
      const sections = children.filter(isSection).length;
      return [
        sections ? t("{count} 个分组", { count: sections }) : "",
        t(
          item.path.startsWith("content/collections/album/")
            ? "{count} 首曲目"
            : "{count} 个章节",
          { count: children.length - sections },
        ),
      ]
        .filter(Boolean)
        .join(" · ");
    }
    function summary(item: ArticleSummary) {
      if (item.error) return t("内容格式异常，请打开检查");
      if (props.kind === "collection" && isSection(item))
        return sectionCount(item);
      if (props.kind === "page") return t(pageProfile(item.layout || "").label);
      const labels = item.categories.map(
        (category) => categoryLabels.value.get(category) || category,
      );
      const ancestors =
        props.kind === "collection"
          ? sectionTrail(item.path, languageItems.value).map(displayTitle)
          : [];
      return (
        [...ancestors, item.date.slice(0, 10), ...labels]
          .filter(Boolean)
          .join(" · ") || t("尚未设置日期与分类")
      );
    }
    function startCreate() {
      createLanguage.value = language.value;
      title.value = "";
      slug.value = "";
      articleCollection.value = "";
      childLayout.value = "empty";
      subtype.value = atRoot.value
        ? "column"
        : currentSection.value?.layout === "collection-list"
          ? "collection"
          : "chapter";
      parent.value = atRoot.value
        ? ""
        : sectionDirectory(folder.value).slice(
            "content/collections/".length,
            -1,
          );
      creating.value = true;
    }
    async function load(refresh = false) {
      loading.value = true;
      error.value = "";
      const labels = api<Settings>("/settings/taxonomies")
        .then((settings) => {
          tagLabels.value = new Map(
            taxonomyChoices(settings.values["post.tags"], []).map((option) => [
              option.value,
              option.label,
            ]),
          );
          categoryLabels.value = new Map(
            taxonomyChoices(settings.values["post.categories"], []).map(
              (option) => [option.value, option.label],
            ),
          );
        })
        .catch(() => {
          /* Keep stored labels visible if the dictionary cannot be read. */
        });
      try {
        const [content, config] = await Promise.all([
          api<ArticleSummary[]>("/content" + (refresh ? "?refresh=1" : "")),
          api<ContentLanguages>("/content-languages"),
        ]);
        items.value = content;
        languages.value = config;
        if (!config.languages.includes(language.value))
          language.value = config.defaultLanguage;
        if (!items.value.some((item) => item.path === folder.value))
          browse(root.value);
      } catch (e) {
        error.value = errorMessage(e);
      } finally {
        loading.value = false;
      }
      await labels;
    }
    watch(language, (value) => {
      if (languages.value) {
        folder.value = translationLocation(
          folder.value,
          value,
          languages.value,
        ).path;
        emit("browse", folder.value);
      }
    });
    onMounted(() => load());
    function create() {
      if (!title.value.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(slug.value)) {
        error.value = "请填写标题，网址标识使用小写字母、数字和连字符。";
        return;
      }
      const metadata: Record<string, Json> = {
        title: title.value.trim(),
        draft: true,
      };
      let path = "";
      if (props.kind === "article") {
        if (
          articleCollection.value &&
          !collections.value.some(
            (option) => option.value === articleCollection.value,
          )
        ) {
          error.value = "请选择已有系列。";
          return;
        }
        path = articleCollection.value
          ? `content/collections/${articleCollection.value}/${slug.value}/index.md`
          : `content/articles/${slug.value}/index.md`;
        metadata.date = new Date().toISOString();
        if (articleCollection.value) metadata.layout = "collection-content";
      }
      if (props.kind === "page") {
        path = `content/pages/${slug.value}.md`;
        metadata.layout = childLayout.value;
      }
      if (props.kind === "collection") {
        if (subtype.value !== "chapter") {
          metadata["extra.cover"] = "/img/default-cover.svg";
          metadata["extra.tags"] = [];
        }
        if (
          subtype.value !== "column" &&
          !parents.value.some((option) => option.value === parent.value)
        ) {
          error.value = "请选择已有分组、系列或专辑。";
          return;
        }
        const directory =
          subtype.value === "column"
            ? slug.value
            : `${parent.value}/${slug.value}`;
        path = `content/collections/${directory}/${subtype.value === "chapter" ? "index" : "_index"}.md`;
        if (subtype.value === "column") metadata.layout = "collection-list";
        else if (subtype.value === "collection") {
          metadata.layout = "collection-detail";
          metadata.child_layout = "collection-content";
          metadata.render = true;
          metadata.insert_anchor_links = "heading";
        } else metadata.layout = "collection-content";
      }
      if (languages.value)
        path = translationLocation(
          path,
          createLanguage.value,
          languages.value,
        ).path;
      if (items.value.some((item) => item.path === path)) {
        error.value = "此语言版本已存在，请从内容库打开";
        return;
      }
      error.value = "";
      emit("create", path, metadata);
    }
    return () =>
      element(
        "section",
        { className: classes("content-library") },
        element(
          "div",
          { className: classes("page-heading") },
          element(
            "div",
            null,

            element("h1", null, t(names[props.kind])),
          ),
          element(
            "div",
            { className: classes("row") },
            element(
              "button",
              {
                disabled: loading.value,
                className: classes("secondary"),
                onClick: domEvent(($event: Event) => {
                  load(true);
                }),
              },
              t("刷新内容"),
            ),
            element(
              "button",
              {
                disabled: loading.value || !!error.value,
                className: classes("primary"),
                onClick: domEvent(($event: Event) => {
                  startCreate();
                }),
              },
              element(Icon, { name: "plus" }),
              t(
                props.kind === "article"
                  ? t("新建文章")
                  : props.kind === "page"
                    ? t("新建页面")
                    : t("新建内容"),
              ),
            ),
          ),
        ),
        error.value && !creating.value
          ? element(
              "p",
              { role: "alert", className: classes("notice error") },
              t(error.value),
              " ",
              element(
                "button",
                {
                  disabled: loading.value,
                  className: classes("text-button"),
                  onClick: domEvent(($event: Event) => {
                    load(true);
                  }),
                },
                t("重试"),
              ),
            )
          : null,
        props.kind === "collection"
          ? element(
              "div",
              { className: classes("collection-navigation") },
              element(
                "nav",
                { "aria-label": t("合集层级") },
                element(
                  "button",
                  {
                    className: classes("text-button"),
                    onClick: domEvent(($event: Event) => {
                      browse(root.value);
                    }),
                  },
                  t("全部合集"),
                ),
                renderList(trail.value).map((section) =>
                  element(
                    Fragment,
                    { key: section.path },
                    element("span", { "aria-hidden": "true" }, "/"),
                    element(
                      "button",
                      {
                        className: classes("text-button"),
                        onClick: domEvent(($event: Event) => {
                          browse(section.path);
                        }),
                      },
                      displayTitle(section),
                    ),
                  ),
                ),
              ),
              currentSection.value
                ? element(
                    "button",
                    {
                      className: classes("secondary"),
                      onClick: domEvent(($event: Event) => {
                        emit("open", currentSection.value!.path);
                      }),
                    },
                    atRoot.value ? t("合集首页设置") : t("当前分组设置"),
                  )
                : null,
            )
          : null,
        element(
          "div",
          { className: classes("card") },
          element(
            "div",
            { className: classes("library-toolbar") },
            element(
              "div",
              { className: classes("search-box") },
              element(Icon, { name: "search" }),
              element("input", {
                value: search.value ?? "",
                "aria-label": t("搜索内容"),
                placeholder:
                  props.kind === "collection"
                    ? t("搜索系列、专辑和章节…")
                    : t("搜索标题、标签或分类…"),
                onInput: domEvent(($event: Event) => {
                  search.value = ($event.target as HTMLInputElement).value;
                }),
              }),
            ),
            languages.value
              ? element(SelectionField, {
                  modelValue: language.value,
                  name: "library-language",
                  label: t("内容语言"),
                  options: languages.value.languages.map((value) => ({
                    value,
                    label: value,
                  })),
                  onUpdateModelValue: (($event) => {
                    language.value = String($event);
                  }) satisfies EventHandler<
                    typeof SelectionField,
                    "onUpdateModelValue"
                  >,
                })
              : null,
            element(SelectionField, {
              modelValue: status.value,
              name: "status",
              label: t("筛选状态"),
              options: [
                { value: "all", label: t("全部状态") },
                { value: "draft", label: t("草稿") },
                { value: "published", label: t("已发布") },
              ],
              onUpdateModelValue: (($event) => {
                status.value = String($event);
              }) satisfies EventHandler<
                typeof SelectionField,
                "onUpdateModelValue"
              >,
            }),
          ),
          loading.value
            ? element(LoadingState, { label: "正在读取内容…" })
            : !filtered.value.length && !error.value
              ? element(
                  "div",
                  { className: classes("empty-state") },
                  element(Icon, { name: "book", size: 36 }),
                  element(
                    "h2",
                    null,
                    searchable.value
                      ? t("没有找到匹配内容")
                      : t("这里还没有内容"),
                  ),
                  element(
                    "p",
                    { className: classes("muted") },
                    searchable.value
                      ? t("试试其他关键词或筛选条件。")
                      : t("点击上方按钮，新建内容。"),
                  ),
                )
              : null,
          renderList(rows.value).map((item) =>
            element(
              "div",
              { key: item.path, className: classes("library-row") },
              element(
                "button",
                {
                  "data-path": item.path,
                  className: classes("content-row"),
                  onClick: domEvent(($event: Event) => {
                    openItem(item);
                  }),
                },
                element(
                  "span",
                  { className: classes("content-icon") },
                  element(Icon, { name: isSection(item) ? "folder" : "file" }),
                ),
                element(
                  "span",
                  { className: classes("content-info") },
                  element(
                    "span",
                    { className: classes("content-title") },
                    element("strong", null, displayTitle(item)),
                    props.kind === "collection"
                      ? element(
                          "span",
                          { className: classes("content-kind") },
                          t(contentLabel(item)),
                        )
                      : null,
                  ),
                  element(
                    "small",
                    null,
                    item.lang,
                    " · ",
                    summary(item),
                    (item.availableLanguages?.length || 0) > 1
                      ? element(
                          Fragment,
                          null,
                          " · ",
                          item.availableLanguages?.join(" / "),
                        )
                      : null,
                  ),
                  item.description
                    ? element(
                        "span",
                        { className: classes("content-description") },
                        item.description,
                      )
                    : null,
                  item.tags.length
                    ? element(
                        "span",
                        { className: classes("tags") },
                        renderList(item.tags.slice(0, 5)).map((tag) =>
                          element(
                            "span",
                            { key: tag },
                            "# ",
                            tagLabels.value.get(tag) || tag,
                          ),
                        ),
                        item.tags.length > 5
                          ? element("span", null, "+", item.tags.length - 5)
                          : null,
                      )
                    : null,
                ),
                element(
                  "span",
                  {
                    className: classes([
                      "badge",
                      { draft: item.draft, invalid: item.error },
                    ]),
                  },
                  item.error
                    ? t("需要检查")
                    : item.render === false
                      ? t("仅作分组")
                      : item.draft
                        ? t("草稿")
                        : t("已发布"),
                ),
                element(Icon, { name: "arrow" }),
              ),
              props.kind === "collection" && isSection(item)
                ? element(
                    "button",
                    {
                      "aria-label": t("编辑{p0}设置", {
                        p0: displayTitle(item),
                      }),
                      className: classes("text-button section-edit"),
                      onClick: domEvent(($event: Event) => {
                        emit("open", item.path);
                      }),
                    },
                    t("设置"),
                  )
                : null,
              props.kind === "article"
                ? element(
                    "button",
                    {
                      "aria-label": t("删除{title}的当前语言版本", {
                        title: displayTitle(item),
                      }),
                      className: classes("text-button danger content-delete"),
                      onClick: domEvent(($event: Event) => {
                        deleteTarget.value = item;
                      }),
                    },
                    t("删除"),
                  )
                : null,
            ),
          ),
          !loading.value && !error.value
            ? element(
                "div",
                { className: classes("list-footer library-footer") },
                element(
                  "span",
                  null,
                  t("共 {count} 项", { count: filtered.value.length }),
                  props.kind === "collection" && !searchable.value
                    ? t(" · 当前层级")
                    : "",
                  " · ",
                  t("网站内容将在下次部署后更新"),
                ),
                pages.value > 1
                  ? element(
                      "div",
                      { className: classes("row") },
                      element(
                        "button",
                        {
                          disabled: pageNumber.value <= 1,
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            pageNumber.value--;
                          }),
                        },
                        t("上一页"),
                      ),
                      element(
                        "span",
                        null,
                        pageNumber.value,
                        " / ",
                        pages.value,
                      ),
                      element(
                        "button",
                        {
                          disabled: pageNumber.value >= pages.value,
                          className: classes("text-button"),
                          onClick: domEvent(($event: Event) => {
                            pageNumber.value++;
                          }),
                        },
                        t("下一页"),
                      ),
                    )
                  : null,
              )
            : null,
        ),
        creating.value
          ? element(
              "div",
              {
                className: classes("modal-backdrop"),
                onClick: domEvent(($event: Event) => {
                  if ($event.target !== $event.currentTarget) return;
                  creating.value = false;
                }),
              },
              element(
                "form",
                {
                  className: classes("card modal"),
                  onSubmit: domEvent(($event: Event) => {
                    $event.preventDefault();
                    create();
                  }),
                },
                element(
                  "div",
                  { className: classes("card-heading") },
                  element("h2", null, t("新建内容")),
                  element(
                    "button",
                    {
                      type: "button",
                      className: classes("text-button"),
                      onClick: domEvent(($event: Event) => {
                        creating.value = false;
                      }),
                    },
                    t("取消"),
                  ),
                ),
                error.value
                  ? element(
                      "p",
                      { role: "alert", className: classes("notice error") },
                      t(error.value),
                    )
                  : null,
                props.kind === "collection"
                  ? element(SelectionField, {
                      modelValue: subtype.value,
                      name: "content-type",
                      label: t("内容类型"),
                      options: [
                        { value: "column", label: t("分组（一级目录）") },
                        {
                          value: "collection",
                          label: t(
                            creatingAlbum.value
                              ? "专辑（曲目集合）"
                              : "系列（文章集合）",
                          ),
                        },
                        {
                          value: "chapter",
                          label: t(
                            creatingAlbum.value
                              ? "曲目（正文）"
                              : "章节（正文）",
                          ),
                        },
                      ],
                      onUpdateModelValue: (($event) => {
                        subtype.value = String($event);
                      }) satisfies EventHandler<
                        typeof SelectionField,
                        "onUpdateModelValue"
                      >,
                    })
                  : null,
                languages.value
                  ? element(SelectionField, {
                      modelValue: createLanguage.value,
                      name: "create-language",
                      label: t("内容语言"),
                      options: languages.value.languages.map((value) => ({
                        value,
                        label: value,
                      })),
                      onUpdateModelValue: (($event) => {
                        createLanguage.value = String($event);
                      }) satisfies EventHandler<
                        typeof SelectionField,
                        "onUpdateModelValue"
                      >,
                    })
                  : null,
                element(
                  "label",
                  { className: classes("field field-inline") },
                  element("span", null, t("标题")),
                  element("input", {
                    value: title.value ?? "",
                    required: true,
                    autoFocus: true,
                    placeholder: t("给它取个名字"),
                    onInput: domEvent(($event: Event) => {
                      title.value = ($event.target as HTMLInputElement).value;
                    }),
                  }),
                ),
                element(
                  "label",
                  { className: classes("field field-inline") },
                  element("span", null, t("网址标识")),
                  element("input", {
                    value: slug.value ?? "",
                    required: true,
                    pattern: "[a-z0-9][a-z0-9-]*",
                    placeholder: "my-first-story",
                    onInput: domEvent(($event: Event) => {
                      slug.value = ($event.target as HTMLInputElement).value;
                    }),
                  }),
                  element(
                    "small",
                    { className: classes("muted") },
                    t("用于生成地址，创建后不能在后台重命名。"),
                  ),
                ),
                props.kind === "page"
                  ? element(SelectionField, {
                      modelValue: childLayout.value,
                      name: "page-template",
                      label: t("页面类型"),
                      options: translateOptions(childLayoutChoices),
                      onUpdateModelValue: (($event) => {
                        childLayout.value = String($event);
                      }) satisfies EventHandler<
                        typeof SelectionField,
                        "onUpdateModelValue"
                      >,
                    })
                  : null,
                props.kind === "article"
                  ? element(SelectionField, {
                      modelValue: articleCollection.value,
                      name: "article-collection",
                      label: t("所属系列"),
                      options: [
                        { value: "", label: t("独立文章（不加入系列）") },
                        ...collections.value,
                      ],
                      disabled: loading.value,
                      hint: t(
                        "加入系列后会作为章节显示。新系列请在「合集管理」中创建。",
                      ),
                      onUpdateModelValue: (($event) => {
                        articleCollection.value = String($event);
                      }) satisfies EventHandler<
                        typeof SelectionField,
                        "onUpdateModelValue"
                      >,
                    })
                  : null,
                props.kind === "collection" && subtype.value !== "column"
                  ? element(SelectionField, {
                      modelValue: parent.value,
                      name: "collection-parent",
                      label:
                        subtype.value === "chapter"
                          ? t(creatingAlbum.value ? "所属专辑" : "所属系列")
                          : t("所属分组 / 系列 / 专辑"),
                      options: parents.value,
                      disabled: loading.value || !parents.value.length,
                      hint: t("先创建对应分组、系列或专辑，再添加子内容。"),
                      onUpdateModelValue: (($event) => {
                        parent.value = String($event);
                      }) satisfies EventHandler<
                        typeof SelectionField,
                        "onUpdateModelValue"
                      >,
                    })
                  : null,
                element(
                  "button",
                  {
                    disabled:
                      loading.value ||
                      (props.kind === "collection" &&
                        subtype.value !== "column" &&
                        !parent.value),
                    className: classes("primary wide"),
                  },
                  t("进入编辑器"),
                  element(Icon, { name: "arrow" }),
                ),
              ),
            )
          : null,
        deleteTarget.value
          ? element(DeleteContentDialog, {
              key: deleteTarget.value.path,
              path: deleteTarget.value.path,
              title: displayTitle(deleteTarget.value),
              onDeleted: deleted satisfies EventHandler<
                typeof DeleteContentDialog,
                "onDeleted"
              >,
              onClose: (() => {
                deleteTarget.value = undefined;
              }) satisfies EventHandler<typeof DeleteContentDialog, "onClose">,
              onWorking: (($event) => {
                emit("working", $event);
              }) satisfies EventHandler<
                typeof DeleteContentDialog,
                "onWorking"
              >,
            })
          : null,
      );
  },
  {},
);
export default ContentLibrary;
