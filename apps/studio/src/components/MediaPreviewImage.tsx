import { useSignals } from '@preact/signals-react/runtime';
import { useEffect, useRef, useState } from 'react';
import { mediaURL, type MediaItem } from '../../shared/media';
import { apiTransportGeneration } from '../api';

type ImageLoader = (item: MediaItem, thumbnail: boolean, signal: AbortSignal, version: number) => Promise<Blob | string>;
let loadNativeImage: ImageLoader | undefined;
export function setMediaImageLoader(loader?: ImageLoader) { loadNativeImage = loader; }

export default function MediaPreviewImage({ item, version, thumbnail = false, onError }: {
  item: MediaItem; version: number; thumbnail?: boolean; onError: () => void;
}) {
  useSignals();
  const host = useRef<HTMLSpanElement>(null);
  const onFailure = useRef(onError);
  onFailure.current = onError;
  const [visible, setVisible] = useState(!thumbnail);
  const [resolved, setResolved] = useState<{ key: string; url: string }>();
  const generation = apiTransportGeneration.value;
  const key = JSON.stringify([generation, item.path, version, thumbnail]);
  const loader = loadNativeImage;

  useEffect(() => {
    if (visible || !host.current) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        setVisible(true);
      }
    }, { rootMargin: '80px' });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!loader || !visible) return;
    const controller = new AbortController();
    let objectURL: string | undefined;
    void loader(item, thumbnail, controller.signal, version).then(result => {
      if (controller.signal.aborted) return;
      const url = typeof result === 'string' ? result : (objectURL = URL.createObjectURL(result));
      setResolved({ key, url });
    }, () => { if (!controller.signal.aborted) onFailure.current(); });
    return () => {
      controller.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [key, loader, thumbnail, visible, item.path, version]);

  const src = !visible ? undefined : loader
    ? (resolved?.key === key ? resolved.url : undefined)
    : mediaURL(item.path, version);
  return <span ref={host} className="media-image-slot">
    {src && <img src={src} alt={thumbnail ? '' : item.name} decoding="async" onError={onError} />}
  </span>;
}
