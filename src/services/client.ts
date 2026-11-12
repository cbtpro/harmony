import type { DisksApi } from '../../shared/disks';
import type { MediaApi } from '../../shared/media';
import type { FilesApi, Result } from '../../shared/files';
import type { IndexSettings, QuickSearchApi, SearchApi } from '../../shared/search';
import type { TerminalsApi } from '../../shared/terminals';

type DesktopBridge = { request(name: string, args: unknown[]): Promise<Result<unknown>> };
const bridge = (window as Window & { harmonyDesktop?: DesktopBridge }).harmonyDesktop;
export const isDesktop = !!bridge;
let token = '';

if (!bridge && location.hostname === '127.0.0.1') {
  const supplied = new URLSearchParams(location.hash.slice(1)).get('connect');
  if (supplied && /^[A-Za-z0-9_-]{43}$/.test(supplied)) {
    sessionStorage.setItem('harmony-access', supplied);
    history.replaceState(null, '', location.pathname + '#/');
  }
  token = sessionStorage.getItem('harmony-access') ?? '';
}

async function request<T>(name: string, ...args: unknown[]): Promise<Result<T>> {
  try {
    if (bridge) return await bridge.request(name, args) as Result<T>;
    if (!token) return { ok: false, message: '请从 Harmony 客户端打开网页版本。' };
    const response = await fetch('/api/request', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args }),
    });
    if (response.status === 403) return { ok: false, message: '网页会话已失效，请从客户端重新打开。' };
    if (!response.ok) return { ok: false, message: '客户端无法处理此请求，请稍后重试。' };
    return await response.json() as Result<T>;
  } catch {
    return { ok: false, message: '无法连接 Harmony 客户端。' };
  }
}

function chooseDirectory<T>(name: string, canceled: () => Promise<Result<T>>) {
  if (isDesktop) return request<T>(name);
  if (!token) return request<T>(name);
  const path = window.prompt('请输入 Harmony 客户端所在电脑上的绝对目录路径');
  return path ? request<T>(name, path) : canceled();
}

export const files: FilesApi = {
  list: path => path === undefined ? request('files:list') : request('files:list', path),
  choose: () => chooseDirectory('files:choose', async () => ({ ok: true, value: null })),
  mkdir: (directory, name) => request('files:mkdir', directory, name),
  copyFile: (source, directory) => request('files:copyFile', source, directory),
  open: path => request('files:open', path),
  reveal: path => request('files:reveal', path),
  copyPath: path => request('files:copy-path', path),
  trash: path => request('files:trash', path),
};

export const terminals: TerminalsApi = {
  list: () => request('terminals:list'),
  open: (id, path) => request('terminals:open', id, path),
};

export const media: MediaApi = {
  list: query => request('media:list', query),
  inspect: path => request('media:inspect', path),
  scrape: (kind, query, country) => request('media:scrape', kind, query, country),
  save: (path, metadata) => request('media:save', path, metadata),
  rename: (path, stem) => request('media:rename', path, stem),
};

export const search: SearchApi = {
  status: () => request('search:status'),
  addRoot: () => chooseDirectory('search:add-root', () => search.status()),
  removeRoot: path => request('search:remove-root', path),
  addExcluded: () => chooseDirectory('search:add-excluded', () => search.status()),
  removeExcluded: path => request('search:remove-excluded', path),
  rebuild: () => request('search:rebuild'),
  pause: () => request('search:pause'),
  resume: () => request('search:resume'),
  stop: () => request('search:stop'),
  search: query => request('search:find', query),
};

export const quickSearch: QuickSearchApi = {
  find: query => request('search:quick', query),
  open: path => request('search:open-quick', path),
};

export const indexSettings = {
  get: () => request<IndexSettings>('search:settings'),
  save: (threads: number) => request<IndexSettings>('search:set-threads', threads),
};

export const disks: DisksApi = {
  list: () => request('disks:list'),
  index: path => request('disks:index', path),
};

export const openWeb = () => request<void>('web:open');
