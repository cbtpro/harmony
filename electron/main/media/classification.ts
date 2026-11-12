import { extname } from 'node:path';
import type { MediaCategory } from '../../../shared/media';

const formats = {
  video: 'mkv mp4 m4v mov avi webm wmv mpg mpeg m2v ts mts m2ts vob flv ogv rm rmvb 3gp 3g2 asf divx f4v mk3d',
  audio: 'mp3 flac wav m4a aac ogg oga opus wma aiff aif aifc alac ape mka ac3 eac3 dts amr au caf dsf dff wv mid midi aiffc',
  image: 'jpg jpeg jpe png gif webp avif heic heif jxl bmp tif tiff svg ico psd psb dng cr2 cr3 nef arw raf orf rw2 pef srw xcf hdr exr',
  book: 'epub pdf mobi azw azw3 kfx fb2 djvu chm txt rtf',
  comic: 'cbz cbr cb7 cbt',
  audiobook: 'm4b aa aax',
  subtitle: 'srt ass ssa vtt sub idx sup smi sami ttml lrc',
  playlist: 'm3u m3u8 pls xspf cue wpl',
} satisfies Partial<Record<MediaCategory, string>>;

const extensions = new Map<string, MediaCategory>();
for (const [category, values] of Object.entries(formats)) {
  for (const value of values.split(' ')) extensions.set(value, category as MediaCategory);
}

const folderCategories: Partial<Record<MediaCategory, Record<string, MediaCategory>>> = {
  video: {
    movies: 'movie', films: 'movie', '电影': 'movie',
    'tv shows': 'series', series: 'series', '剧集': 'series', '电视剧': 'series',
    anime: 'animation', animation: 'animation', '动画': 'animation', '动漫': 'animation',
  },
  audio: {
    music: 'music', '音乐': 'music', podcasts: 'podcast', '播客': 'podcast',
    audiobooks: 'audiobook', '有声书': 'audiobook',
  },
  book: { comics: 'comic', manga: 'comic', '漫画': 'comic' },
};

export function classify(path: string): MediaCategory | undefined {
  const category = extensions.get(extname(path).slice(1).toLowerCase());
  if (!category) return undefined;
  const parts = path.split(/[\\/]/);
  const name = parts.pop() ?? path;
  const hints = folderCategories[category];
  if (hints) {
    for (const folder of parts.reverse()) {
      const key = folder.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(hints, key)) return hints[key];
    }
  }
  if (category === 'video' && /\bS\d{1,3}[ ._-]*E\d{1,4}\b|\b\d{1,2}x\d{2,3}\b/i.test(name.replace(/_/g, ' '))) {
    return 'series';
  }
  return category;
}
