import { execFile, spawn } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { isWithin } from './scan';

const exec = promisify(execFile);
export const SYSTEM_RESULT_LIMIT = 1000;
export const SYSTEM_MEDIA_LIMIT = 10_000;
const QUERY_TIMEOUT = 6000;

export interface SystemQuery {
  term?: string;
  extensions?: readonly string[];
}

export interface SystemProvider {
  name: string;
  probe(root: string): Promise<boolean>;
  find(root: string, query: SystemQuery, limit: number): Promise<string[]>;
}

function spotlightLiteral(value: string) {
  return value.replace(/[\\"*?]/g, '\\$&');
}

export function spotlightQuery({ term, extensions }: SystemQuery) {
  const name = term ? `kMDItemFSName == "*${spotlightLiteral(term)}*"cd` : undefined;
  const suffix = extensions?.length ? '(' + extensions.map(ext => `kMDItemFSName == "*.${spotlightLiteral(ext)}"c`).join(' || ') + ')' : undefined;
  return [name, suffix].filter(Boolean).join(' && ') || 'kMDItemFSName != ""';
}

async function command(file: string, args: string[], timeout = QUERY_TIMEOUT) {
  const { stdout } = await exec(file, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return stdout;
}

async function spotlightPaths(root: string, query: SystemQuery, limit: number) {
  const child = spawn('/usr/bin/mdfind', ['-0', '-onlyin', root, spotlightQuery(query)], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const paths: string[] = [];
  let pending = '';
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, QUERY_TIMEOUT);
  return new Promise<string[]>((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (paths.length >= limit) return;
      const parts = (pending + chunk).split('\0');
      pending = parts.pop() ?? '';
      for (const path of parts) {
        if (path) paths.push(path);
        if (paths.length >= limit) {
          child.kill();
          break;
        }
      }
    });
    child.once('error', reject);
    child.once('close', code => {
      if (timedOut || (code !== 0 && paths.length < limit)) reject(new Error('Spotlight 查询失败。'));
      else resolve(paths);
    });
  }).finally(() => clearTimeout(timer));
}

function sqlLiteral(value: string) {
  return "'" + value.replace(/'/g, "''") + "'";
}

export function windowsQuery(root: string, { term, extensions }: SystemQuery, limit: number) {
  const name = term ? 'System.FileName LIKE ' + sqlLiteral('%' + term + '%') : undefined;
  const suffix = extensions?.length ? '(' + extensions.map(ext => 'System.FileExtension = ' + sqlLiteral('.' + ext)).join(' OR ') + ')' : undefined;
  const match = [name, suffix].filter(Boolean).join(' AND ') || 'System.FileName IS NOT NULL';
  return `SELECT TOP ${limit} System.ItemPathDisplay FROM SystemIndex WHERE SCOPE=${sqlLiteral('file:' + root.replace(/\\/g, '/'))} AND ${match}`;
}

async function windowsPaths(root: string, query: SystemQuery, limit: number) {
  if (query.extensions && query.extensions.length > 32) {
    const paths: string[] = [];
    for (let i = 0; i < query.extensions.length && paths.length < limit; i += 32) {
      paths.push(...await windowsPaths(root, { ...query, extensions: query.extensions.slice(i, i + 32) }, limit - paths.length));
    }
    return paths;
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const sql = Buffer.from(windowsQuery(root, query, limit), 'utf8').toString('base64');
  const script = `
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
    $sql = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${sql}'))
    $conn = New-Object System.Data.OleDb.OleDbConnection "Provider=Search.CollatorDSO;Extended Properties='Application=Windows';"
    try {
      $conn.Open()
      $cmd = $conn.CreateCommand()
      $cmd.CommandText = $sql
      $reader = $cmd.ExecuteReader()
      $paths = New-Object 'System.Collections.Generic.List[string]'
      while ($reader.Read()) { if (-not $reader.IsDBNull(0)) { $paths.Add($reader.GetString(0)) } }
      ConvertTo-Json -InputObject @($paths.ToArray()) -Compress
    } finally { $conn.Dispose() }
  `;
  const output = await command(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
  const paths: unknown = JSON.parse(output);
  if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string')) throw new Error('Windows Search 返回了无效结果。');
  return paths as string[];
}

export function sparqlQuery(root: string, { term, extensions }: SystemQuery, limit: number) {
  const directory = pathToFileURL(root.endsWith('/') ? root : root + '/').href;
  const name = 'LCASE(STR(?name))';
  const nameMatch = term ? `CONTAINS(${name}, ${JSON.stringify(term.toLowerCase())})` : undefined;
  const suffix = extensions?.length ? '(' + extensions.map(ext => `STRENDS(${name}, ${JSON.stringify('.' + ext)})`).join(' || ') + ')' : undefined;
  const match = [nameMatch, suffix].filter(Boolean).join(' && ') || 'true';
  return `PREFIX nfo: <http://tracker.api.gnome.org/ontology/v3/nfo#>
    PREFIX nie: <http://tracker.api.gnome.org/ontology/v3/nie#>
    PREFIX tracker: <http://tracker.api.gnome.org/ontology/v3/tracker#>
    SELECT DISTINCT ?url WHERE {
      GRAPH tracker:FileSystem { ?item nie:url ?url ; nfo:fileName ?name . }
      FILTER(STRSTARTS(STR(?url), ${JSON.stringify(directory)}) && ${match})
    } LIMIT ${limit}`;
}

function gnome(name: string, executable: string, args: string[]): SystemProvider {
  return provider(name, async (root, query, limit) => {
    const output = await command(executable, [...args, sparqlQuery(root, query, limit)]);
    return output.split(/\r?\n/).flatMap(line => {
      const url = line.trim();
      if (!url.startsWith('file://')) return [];
      try { return [fileURLToPath(url)]; } catch { return []; }
    });
  });
}

function baloo(executable: string): SystemProvider {
  return provider('Baloo', async (root, { term, extensions }, limit) => {
    const expression = extensions?.length ? extensions.map(ext => `filename:"${ext}"`).join(' OR ')
      : term ? `filename:"${term.replace(/[\\"]/g, '\\$&')}"` : 'type:Folder OR filename:*';
    const output = await command(executable, ['--limit', String(limit), '--directory', root, '--', expression]);
    return output.split(/\r?\n/).filter(line => line.startsWith('/'));
  });
}

function provider(name: string, find: SystemProvider['find']): SystemProvider {
  return { name, find, probe: async root => (await find(root, {}, 8)).some(path =>
    isWithin(root, path) && relative(root, path) !== '') };
}

export function platformProviders(platform = process.platform): SystemProvider[] {
  if (platform === 'darwin') return [provider('Spotlight', spotlightPaths)];
  if (platform === 'win32') return [provider('Windows Search', windowsPaths)];
  if (platform === 'linux') return [
    gnome('GNOME LocalSearch', 'tinysparql3', ['sparql', '--dbus-service', 'org.freedesktop.LocalSearch3', '--query']),
    gnome('GNOME LocalSearch', 'tinysparql', ['query', '--dbus-service', 'org.freedesktop.LocalSearch3']),
    gnome('Tracker', 'tracker3', ['sparql', '--dbus-service', 'org.freedesktop.Tracker3.Miner.Files', '--query']),
    baloo('baloosearch6'),
    baloo('baloosearch'),
  ];
  return [];
}
