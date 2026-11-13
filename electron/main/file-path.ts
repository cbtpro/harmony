import { win32 } from 'node:path';

export function windowsPath(value: string): string {
  let path = value.replace(/\//g, '\\');
  if (/^\\\\\?\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);
  if (!/^(?:[a-z]:\\|\\\\[^\\?.:][^\\:]*\\[^\\:]+(?:\\|$))/i.test(path)) {
    throw new Error('请输入包含盘符或网络共享的绝对路径。');
  }
  const normalized = win32.normalize(path);
  if (normalized.includes('\0') || normalized.slice(win32.parse(normalized).root.length).includes(':')) {
    throw new Error('路径包含不支持的文件名。');
  }
  return normalized;
}

export function filesystemPath(path: string): string {
  return process.platform === 'win32' ? win32.toNamespacedPath(windowsPath(path)) : path;
}

export function componentLength(name: string): number {
  return process.platform === 'win32' ? name.length : Buffer.byteLength(name);
}
