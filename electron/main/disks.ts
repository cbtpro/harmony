import { execFile } from 'node:child_process';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { basename, join, parse } from 'node:path';
import { promisify } from 'node:util';

interface Mount {
  path: string;
  name: string;
  space?: { total: number | null; available: number | null };
}

const run = promisify(execFile);
const networkTypes = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs']);

export function linuxMounts(input: string): Mount[] {
  const mounts = new Map<string, Mount>();
  for (const line of input.split('\n')) {
    const [header, tail] = line.split(' - ');
    const encoded = header.split(' ')[4];
    if (!encoded || !tail) continue;
    const path = encoded.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
    const [type, source] = tail.split(' ');
    if (path === '/' || (source?.startsWith('/dev/') && type !== 'squashfs') || networkTypes.has(type)) {
      mounts.set(path, { path, name: basename(path) || '系统磁盘' });
    }
  }
  return [...mounts.values()];
}

export async function discoverMounts(home: string): Promise<Mount[]> {
  const root = parse(home).root;
  const system = { path: root, name: '系统磁盘' };
  if (process.platform === 'linux') {
    const input = await readFile('/proc/self/mountinfo', 'utf8').catch(() => '');
    const mounts = linuxMounts(input);
    return mounts.length ? mounts : [system];
  }
  if (process.platform === 'darwin') {
    const [entries, parent] = await Promise.all([
      readdir('/Volumes', { withFileTypes: true }).catch(() => []),
      stat('/Volumes').catch(() => null),
    ]);
    const volumes = [system];
    for (const entry of entries.filter(item => item.isDirectory()).slice(0, 63)) {
      const path = join('/Volumes', entry.name);
      const info = await stat(path).catch(() => null);
      if (info && info.dev !== parent?.dev) volumes.push({ path, name: entry.name });
    }
    return volumes;
  }
  if (process.platform === 'win32') {
    const command = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; '
      + 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType >= 2 AND DriveType <= 5" '
      + '| Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress';
    try {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
        { timeout: 5000, windowsHide: true, maxBuffer: 128 * 1024 });
      const rows = stdout.trim() ? JSON.parse(stdout) : [];
      const volumes = (Array.isArray(rows) ? rows : [rows]).flatMap(row =>
        typeof row?.DeviceID === 'string' && /^[A-Z]:$/i.test(row.DeviceID)
          ? [{ path: row.DeviceID.toUpperCase() + '\\', name: row.VolumeName || row.DeviceID,
              space: { total: row.Size ?? null, available: row.FreeSpace ?? null } }]
          : []);
      return volumes.length ? volumes : [system];
    } catch {
      return [system];
    }
  }
  return [system];
}

export async function diskSpace(mount: Mount) {
  if (mount.space) return mount.space;
  try {
    const { bsize, blocks, bavail } = await statfs(mount.path, { bigint: true });
    return { total: Number(bsize * blocks), available: Number(bsize * bavail) };
  } catch {
    return { total: null, available: null };
  }
}
