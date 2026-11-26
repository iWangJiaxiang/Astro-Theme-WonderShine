import { Channel, invoke } from '@tauri-apps/api/core';
import type { ApkAsset } from './app-updates';

export function appPlatform() {
  if (/Android/.test(navigator.userAgent)) return 'android';
  if (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'desktop';
}

export const apkUnmetered = () => invoke<boolean>('plugin:studio-apk|unmetered');

export async function downloadUpdate(version: string, apk: ApkAsset | undefined, automatic: boolean, report: (bytes: number, total?: number) => void) {
  if (apk) {
    const progress = new Channel<number>();
    progress.onmessage = bytes => report(bytes, apk.size);
    await invoke('plugin:studio-apk|download', { name: apk.name, sha256: apk.sha256, size: apk.size, version, automatic, progress });
  } else {
    const progress = new Channel<[number, number | null]>();
    progress.onmessage = ([bytes, total]) => report(bytes, total ?? undefined);
    await invoke('download_studio_update', { version, progress });
  }
}

export function installUpdate(version: string, apk?: ApkAsset) {
  return apk ? invoke('plugin:studio-apk|install', { version, sha256: apk.sha256 }) : invoke('install_studio_update', { version });
}
