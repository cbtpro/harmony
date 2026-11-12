import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createTerminalService } from '../electron/main/terminals.ts';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'harmony-terminal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('detects available Windows terminals and starts them with the selected working directory', async t => {
  const directory = await fixture(t);
  const file = join(directory, 'project & notes.txt');
  await writeFile(file, '');
  const binaries = new Set([
    'D:\\Tools\\Git\\git-bash.exe',
    'C:\\Windows\\System32\\cmd.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]);
  const launches: unknown[] = [];
  const service = createTerminalService(directory, {
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows', Path: 'D:\\Tools\\Git\\cmd;.' },
    exists: async path => binaries.has(path),
    launch: async command => { launches.push(command); },
  });

  assert.deepEqual((await service.list()).map(option => option.id), ['git-bash', 'cmd', 'powershell']);
  await service.open('git-bash', file);
  await service.open('cmd', directory);
  await assert.rejects(service.open('D:\\Tools\\other.exe', directory), /未找到该终端/);
  assert.deepEqual(launches, [
    { executable: 'D:\\Tools\\Git\\git-bash.exe', args: [], cwd: directory },
    { executable: 'C:\\Windows\\System32\\cmd.exe', args: ['/D'], cwd: directory },
  ]);
});

test('passes macOS and Linux working directories as literal arguments', async t => {
  const directory = await fixture(t);
  const file = join(directory, '项目 ; 归档.txt');
  await writeFile(file, '');
  const launches: unknown[] = [];
  const record = async (command: unknown) => { launches.push(command); };
  const mac = createTerminalService(directory, {
    platform: 'darwin', env: {},
    exists: async (path, bundle) => bundle && path.endsWith('/Terminal.app'),
    launch: record,
  });
  const linux = createTerminalService(directory, {
    platform: 'linux', env: { PATH: './untrusted:/opt/bin' },
    exists: async path => path === '/opt/bin/konsole',
    launch: record,
  });

  assert.deepEqual((await mac.list()).map(option => option.id), ['terminal']);
  assert.deepEqual((await linux.list()).map(option => option.id), ['konsole']);
  await mac.open('terminal', file);
  await linux.open('konsole', directory);
  await assert.rejects(linux.open('konsole', join(directory, 'missing')));
  assert.deepEqual(launches, [
    { executable: '/usr/bin/open', args: ['-a', '/System/Applications/Utilities/Terminal.app', directory],
      cwd: directory, waitForExit: true },
    { executable: '/opt/bin/konsole', args: ['--workdir', directory], cwd: directory },
  ]);
});
