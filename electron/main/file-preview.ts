import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { PreviewContent } from '../../shared/files';
import { entryPath } from './files';

const images: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
};
const textExtensions = new Set('txt text log csv tsv json jsonl xml html css js ts tsx jsx vue py java sh yaml yml ini cfg conf toml sql srt vtt rst go rs c h cpp rb swift'.split(' '));
const textLimit = 256 * 1024;
const binaryLimit = 20 * 1024 * 1024;

export async function readFilePreview(value: unknown): Promise<PreviewContent> {
  const path = entryPath(value);
  const extension = extname(path).slice(1).toLowerCase();
  const mime = images[extension];
  const kind = mime ? 'image' : extension === 'pdf' ? 'pdf'
    : ['md', 'markdown', 'mdown'].includes(extension) ? 'markdown'
      : textExtensions.has(extension) || !extension && /^(readme|license|changelog|makefile|dockerfile)$/i.test(basename(path))
        ? 'text' : undefined;
  if (!kind) throw new Error('此文件类型不支持预览，可用默认应用打开。');
  const expected = await lstat(path, { bigint: true });
  if (!expected.isFile()) throw new Error('请选择普通文件。');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || expected.dev !== info.dev || expected.ino !== info.ino) throw new Error('文件已变更。');
    const binary = kind === 'image' || kind === 'pdf';
    const limit = binary ? binaryLimit : textLimit;
    if (binary && info.size > BigInt(limit)) throw new Error('文件超过 20 MiB，请使用默认应用打开。');
    const buffer = Buffer.allocUnsafe(Math.min(Number(info.size), limit));
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (binary) return { kind, mime, data: bytes.toString('base64') };
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le'
      : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    if (encoding === 'utf-8' && bytes.includes(0)) throw new Error('文件不是受支持的文本格式。');
    return { kind, data: new TextDecoder(encoding).decode(bytes), truncated: info.size > BigInt(limit) };
  } finally { await file.close(); }
}
