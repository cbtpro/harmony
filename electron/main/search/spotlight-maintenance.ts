import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dataVolume = '/System/Volumes/Data';
let repairing = false;

export async function openSpotlightSettings() {
  const links = ['x-apple.systempreferences:com.apple.Spotlight-Settings.extension',
    'x-apple.systempreferences:com.apple.preference.spotlight'];
  for (const link of links) {
    try {
      await run('/usr/bin/open', [link], { timeout: 5000 });
      return;
    } catch { /* Try the preference pane on older macOS versions. */ }
  }
  throw new Error('无法打开 Spotlight 设置，请从 macOS 系统设置中打开。');
}

export async function rebuildSpotlight() {
  if (repairing) throw new Error('已在请求重建 Spotlight 索引。');
  repairing = true;
  try {
    const volume = await stat(dataVolume).then(info => info.isDirectory() ? dataVolume : '/', () => '/');
    // Only the built-in startup data volume is eligible. macOS owns the authorization prompt.
    const script = `do shell script "/usr/bin/mdutil -E ${volume}" with administrator privileges`;
    const { stdout } = await run('/usr/bin/osascript', ['-e', script], {
      timeout: 120_000, env: { ...process.env, LC_ALL: 'C' },
    });
    if (/error|indexing disabled/i.test(stdout)) throw new Error('Spotlight 未接受重建请求，请检查系统设置。');
  } catch (error) {
    if (String(error).includes('(-128)')) throw new Error('已取消 Spotlight 重建。');
    if (error instanceof Error && error.message.startsWith('Spotlight 未')) throw error;
    throw new Error('无法重建 Spotlight 索引，请确认索引已开启，并授权管理员操作。');
  } finally {
    repairing = false;
  }
}
