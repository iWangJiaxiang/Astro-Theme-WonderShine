import { ErrorNotice } from "./ErrorNotice";
import { formatBytes, type MediaItem } from "../../shared/media";
import { t } from "../i18n";
import { mediaListing, mediaVersion } from "../media-store";
import { createBusinessModal } from "../modal-layer";
import { component, domRef, portal, type StudioComponent } from "../react-component";
import { onBeforeUnmount, ref, useId, watch } from "../reactivity";
import Icon from "./Icon";
import MediaBrowser from "./MediaBrowser";
import MediaPreviewImage from "./MediaPreviewImage";

const MediaLibrary: StudioComponent<{}, {}> = component<{}, {}>("MediaLibrary", () => {
  const selected = ref<MediaItem>();
  const selectedPath = ref("");
  const dialog = ref<HTMLDialogElement | null>(null);
  const closeButton = ref<HTMLButtonElement | null>(null);
  const browser = ref<HTMLElement | null>(null);
  const copied = ref("");
  const copyFailed = ref(false);
  const failed = ref(false);
  const title = useId();
  let trigger: HTMLButtonElement | undefined;
  const modal = createBusinessModal(() => dialog.value, () => !!selected.value,
    () => closeButton.value?.focus({ preventScroll: true }));

  function close() {
    modal.close();
    selected.value = undefined;
    const target = trigger?.isConnected && !trigger.disabled ? trigger : browser.value;
    target?.focus({ preventScroll: true });
    trigger = undefined;
  }

  watch(mediaVersion, () => {
    if (!selectedPath.value) return;
    const item = mediaListing.value.items.find(item => item.path === selectedPath.value);
    if (!item || item.unavailable) {
      selectedPath.value = "";
      if (selected.value) close();
    } else if (selected.value) {
      selected.value = item;
      failed.value = false;
    }
  });
  onBeforeUnmount(modal.dispose);

  async function copy(value: string) {
    const item = selected.value;
    let failure = false;
    try { await navigator.clipboard.writeText(value); }
    catch { failure = true; }
    if (selected.value !== item) return;
    copyFailed.value = failure;
    copied.value = value;
  }

  return () => {
    const item = selected.value;
    const publicPath = item?.path.startsWith("public/") ? "/" + item.path.slice(7) : "";
    return <section className="media-library">
      <div className="page-heading"><h1>{t("媒体库")}</h1></div>
      <section className="card media-library-browser" ref={domRef(browser)} tabIndex={-1}>
        <MediaBrowser mode="library" documentPath="" svgOnly={false} selected={selectedPath.value} onSelect={(image, _value, button) => {
          selectedPath.value = image.path;
          if (!button) return;
          trigger = button;
          selected.value = image;
          copied.value = "";
          copyFailed.value = false;
          failed.value = false;
          modal.open();
        }} />
      </section>
      {portal(<dialog ref={domRef(dialog)} className="media-details" aria-labelledby={title}
        onCancel={event => { event.preventDefault(); close(); }}
        onClick={event => { if (event.target === event.currentTarget) close(); }}>
        {item && <div className="media-details-panel">
          <header className="card-heading">
            <h2 id={title}>{item.name}</h2>
            <button ref={domRef(closeButton)} type="button" className="icon-button media-details-close"
              aria-label={t("关闭")} onClick={close}><Icon name="close" size={20} /></button>
          </header>
          {failed.value ? <ErrorNotice source="MediaLibrary" message="暂时无法预览" />
            : <MediaPreviewImage item={item} version={mediaVersion.value} onError={() => { failed.value = true; }} />}
          <div className="media-details-meta">
            <dl>
              <dt>{t("类型与大小")}</dt><dd>{item.mime} · {formatBytes(item.size)}</dd>
              <dt>{t("文件位置")}</dt><dd>{item.path}</dd>
              {publicPath && <><dt>{t("站点路径")}</dt><dd>{publicPath}</dd></>}
            </dl>
            <div className="row">
              {publicPath && <button type="button" className="primary" onClick={() => void copy(publicPath)}>{t("复制站点路径")}</button>}
              <button type="button" className="secondary" onClick={() => void copy(item.path)}>{t("复制仓库路径")}</button>
              {!publicPath && <button type="button" className="secondary" onClick={() => void copy(item.name)}>{t("复制文件名")}</button>}
            </div>
            {copied.value && <>
              <p role="status" className="muted small">{t(copyFailed.value ? "可选中下方路径手动复制" : "路径已复制")}</p>
              <input aria-label={t("已复制的图片路径")} value={copied.value} readOnly onFocus={event => event.currentTarget.select()} />
            </>}
          </div>
        </div>}
      </dialog>)}
    </section>;
  };
}, {});

export default MediaLibrary;
