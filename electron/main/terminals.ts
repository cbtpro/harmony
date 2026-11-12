import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { dirname, posix, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { TerminalOption } from '../../shared/terminals';

interface TerminalDefinition extends TerminalOption {
  candidates: string[];
  argumentsFor: (directory: string) => string[];
  bundle?: boolean;
}

interface Launch {
  executable: string;
  args: string[];
  cwd: string;
  waitForExit?: boolean;
}

interface TerminalRuntime {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(path: string, bundle: boolean): Promise<boolean>;
  launch(command: Launch): Promise<void>;
}

const execute = promisify(execFile);
const CACHE_MS = 30_000;

async function exists(path: string, bundle: boolean): Promise<boolean> {
  try {
    const info = await stat(path);
    if (bundle) return info.isDirectory();
    if (!info.isFile()) return false;
    await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function launch({ executable, args, cwd, waitForExit }: Launch) {
  if (waitForExit) {
    await execute(executable, args, { cwd, timeout: 10_000 });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function windowsDefinitions(env: NodeJS.ProcessEnv): TerminalDefinition[] {
  const windows = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const system = win32.join(windows, 'System32');
  const path = (env.Path ?? env.PATH ?? '').split(';')
    .map(directory => directory.replace(/^"(.*)"$/, '$1')).filter(win32.isAbsolute);
  const programs = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)'],
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs')]
    .filter((directory): directory is string => !!directory && win32.isAbsolute(directory));
  const onPath = (name: string) => path.map(directory => win32.join(directory, name));
  const gitRoots = path.filter(directory => ['cmd', 'bin'].includes(win32.basename(directory).toLowerCase()))
    .map(directory => win32.join(directory, '..', 'git-bash.exe'));

  return [
    { id: 'git-bash', label: 'Git Bash',
      candidates: [...programs.map(directory => win32.join(directory, 'Git', 'git-bash.exe')), ...onPath('git-bash.exe'), ...gitRoots],
      argumentsFor: () => [] },
    { id: 'cmd', label: '命令提示符 (CMD)',
      candidates: [win32.join(system, 'cmd.exe')], argumentsFor: () => ['/D'] },
    { id: 'powershell', label: 'Windows PowerShell',
      candidates: [win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      argumentsFor: () => ['-NoLogo'] },
    { id: 'pwsh', label: 'PowerShell 7',
      candidates: [...programs.map(directory => win32.join(directory, 'PowerShell', '7', 'pwsh.exe')), ...onPath('pwsh.exe')],
      argumentsFor: () => ['-NoLogo'] },
  ];
}

function macDefinitions(home: string): TerminalDefinition[] {
  return [
    { id: 'terminal', label: '终端 (Terminal)',
      candidates: ['/System/Applications/Utilities/Terminal.app', '/Applications/Utilities/Terminal.app'],
      bundle: true, argumentsFor: directory => [directory] },
    { id: 'iterm', label: 'iTerm2',
      candidates: [posix.join(home, 'Applications', 'iTerm.app'), '/Applications/iTerm.app',
        posix.join(home, 'Applications', 'iTerm2.app'), '/Applications/iTerm2.app'],
      bundle: true, argumentsFor: directory => [directory] },
  ];
}

function linuxDefinitions(env: NodeJS.ProcessEnv): TerminalDefinition[] {
  const path = [...(env.PATH ?? '').split(':'), '/usr/local/bin', '/usr/bin', '/bin'].filter(posix.isAbsolute);
  const definitions: Array<[string, string, string?]> = [
    ['gnome-terminal', 'GNOME Terminal', '--working-directory'],
    ['konsole', 'Konsole', '--workdir'],
    ['xfce4-terminal', 'Xfce Terminal', '--working-directory'],
    ['mate-terminal', 'MATE Terminal', '--working-directory'],
    ['alacritty', 'Alacritty', '--working-directory'],
    ['kitty', 'kitty', '--directory'],
    ['xterm', 'XTerm'],
  ];
  return definitions.map(([id, label, flag]) => ({
    id, label, candidates: path.map(directory => posix.join(directory, id)),
    argumentsFor: directory => flag ? [flag, directory] : [],
  }));
}

export function createTerminalService(home: string, runtime: TerminalRuntime = {
  platform: process.platform, env: process.env, exists, launch,
}) {
  const definitions = runtime.platform === 'win32' ? windowsDefinitions(runtime.env)
    : runtime.platform === 'darwin' ? macDefinitions(home)
      : runtime.platform === 'linux' ? linuxDefinitions(runtime.env) : [];
  type InstalledTerminal = TerminalDefinition & { path: string };

  let cache: Promise<InstalledTerminal[]> | undefined;
  let expires = 0;

  function discover() {
    if (cache && Date.now() < expires) return cache;
    expires = Date.now() + CACHE_MS;
    cache = Promise.all(definitions.map(async definition => {
      for (const path of new Set(definition.candidates)) {
        if (await runtime.exists(path, !!definition.bundle)) return { ...definition, path };
      }
      return undefined;
    })).then(available => available.filter((item): item is InstalledTerminal => item !== undefined));
    return cache;
  }

  return {
    async list(): Promise<TerminalOption[]> {
      return (await discover()).map(({ id, label }) => ({ id, label }));
    },
    async open(id: unknown, path: string): Promise<void> {
      const terminal = (await discover()).find(option => option.id === id);
      if (!terminal) throw new Error('未找到该终端，请重新打开右键菜单。');
      const directory = (await stat(path)).isDirectory() ? path : dirname(path);
      if (terminal.id === 'cmd' && /^\\\\(?:\?\\UNC\\|[^?.])/i.test(directory)) {
        throw new Error('命令提示符无法将 UNC 路径设为工作目录，请选择其他终端。');
      }

      const args = terminal.argumentsFor(directory);
      try {
        await runtime.launch(terminal.bundle
          ? { executable: '/usr/bin/open', args: ['-a', terminal.path, ...args], cwd: directory, waitForExit: true }
          : { executable: terminal.path, args, cwd: directory });
      } catch {
        cache = undefined;
        throw new Error(`无法启动 ${terminal.label}。`);
      }
    },
  };
}
