import type { Json } from '../shared/types.js';
import { getValue } from './content.js';
import { StudioError } from './errors.js';

export const channelPath = 'extra.theme.channel';
export const pinPath = 'extra.theme.pinned';
export const versionPath = 'extra.theme.version';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:beta|rc|canary)\.(0|[1-9]\d*))?$/;

export async function themePin(data: Record<string, unknown>, changes: Record<string, Json>, request: typeof fetch) {
  const channel = changes[channelPath] ?? getValue(data, channelPath) ?? 'latest';
  if (channel !== 'latest' && channel !== 'next' && channel !== 'canary') throw new StudioError(400, '请选择有效的主题渠道');
  if (!(changes[pinPath] ?? getValue(data, pinPath))) return null;
  const previous = getValue(data, versionPath);
  const specified = changes[versionPath];
  if (specified !== undefined && (typeof specified !== 'string' || (specified !== '' && !versionPattern.test(specified)))) throw new StudioError(400, '请输入完整的主题版本号');
  if (specified === undefined && getValue(data, pinPath) === true && (getValue(data, channelPath) ?? 'latest') === channel && typeof previous === 'string' && versionPattern.test(previous)) return previous;
  const url = specified ? 'https://registry.npmjs.org/@wondershine%2ftheme/' + specified
    : 'https://registry.npmjs.org/-/package/@wondershine%2ftheme/dist-tags';
  try {
    const response = await request(url, { signal: AbortSignal.timeout(15000), cache: 'no-store', credentials: 'omit', redirect: 'error' });
    if (specified && response.status === 404) throw new StudioError(400, '指定的主题版本尚未发布');
    if (response.ok) {
      const result = await response.json();
      if (specified && result.name === '@wondershine/theme' && result.version === specified) return specified;
      const version = result[channel];
      if (!specified && typeof version === 'string' && versionPattern.test(version)) return version;
    }
  } catch (error) {
    if (error instanceof StudioError) throw error;
  }
  throw new StudioError(502, '无法获取所选渠道的主题版本，请联网后重试');
}
