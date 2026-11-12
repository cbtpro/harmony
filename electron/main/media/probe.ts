import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { promisify } from 'node:util';
import type { MediaCategory, MediaDetails } from '../../../shared/media';
import { parseMetadata, text } from './metadata-store';

const run = promisify(execFile);
const audiovisual = new Set<MediaCategory>([
  'movie', 'series', 'animation', 'video', 'music', 'podcast', 'audio', 'audiobook', 'image',
]);
const demuxers = [
  'mov', 'matroska', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'aiff', 'avi', 'asf', 'mpeg', 'mpegts',
  'flv', 'ape', 'amr', 'ac3', 'eac3', 'dts', 'caf', 'dsf', 'wv', 'gif', 'png_pipe', 'jpeg_pipe',
  'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'jxl_pipe', 'ico',
].join(',');

interface ProbeOutput {
  format?: { duration?: string; tags?: Record<string, unknown> };
  streams?: Array<{ codec_name?: unknown; codec_type?: string; width?: number; height?: number }>;
}

async function probeExecutable() {
  if (process.platform === 'darwin') {
    for (const path of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe']) {
      if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
    }
  }
  return 'ffprobe';
}

export async function inspectMedia(path: string, category: MediaCategory): Promise<MediaDetails> {
  const stats = await lstat(path);
  if (!stats.isFile()) throw new Error('请选择普通媒体文件。');
  const base: MediaDetails = { size: stats.size, modified: stats.mtime.toISOString(), probe: 'unsupported' };
  if (!audiovisual.has(category)) return base;

  try {
    const { stdout } = await run(await probeExecutable(), [
      '-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', demuxers,
      '-probesize', '4194304', '-analyzeduration', '2000000', '-max_streams', '64',
      '-show_entries', 'format=duration:format_tags=title,artist,album_artist,genre,date,year,comment:stream=codec_name,codec_type,width,height',
      '-of', 'json', '-i', path,
    ], { timeout: 6000, maxBuffer: 256 * 1024, windowsHide: true });
    const result: ProbeOutput = JSON.parse(stdout);
    const tags = new Map(Object.entries(result.format?.tags ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
    const video = result.streams?.find(stream => stream.codec_type === 'video');
    const duration = Number(result.format?.duration);
    const codecs = [...new Set((result.streams ?? []).flatMap(stream => {
      const codec = text(stream.codec_name, 40);
      return codec ? [codec] : [];
    }))];
    return {
      ...base, probe: 'ready',
      duration: Number.isFinite(duration) && duration > 0 ? duration : undefined,
      width: video?.width,
      height: video?.height,
      codecs,
      metadata: tags.size ? parseMetadata({
        title: text(tags.get('title'), 256) ?? basename(path, extname(path)),
        creator: tags.get('artist') ?? tags.get('album_artist'),
        year: text(tags.get('year') ?? tags.get('date'), 4),
        genre: tags.get('genre'),
        description: tags.get('comment'),
        source: 'local',
      }) : undefined,
    };
  } catch (error) {
    return { ...base, probe: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'unsupported' };
  }
}
