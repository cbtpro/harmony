import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute } from 'node:path';
import type { IndexSource, SearchResults } from '../../../shared/search';
import { indexKey } from './index-storage';
import { isWithin } from './scan';
import type { createScanScope, ScanEntry } from './scan';
import { platformProviders, SYSTEM_RESULT_LIMIT } from './system-providers';
import type { SystemProvider, SystemQuery } from './system-providers';

type ScanScope = ReturnType<typeof createScanScope>;
const PROBE_TTL = 60_000;
const VALIDATION_BATCH = 16;

export class SystemIndex {
  private readonly probes = new Map<string, { expires: number; result: Promise<SystemProvider | undefined> }>();
  private readonly providers: readonly SystemProvider[];
  private active = 0;

  constructor(providers = platformProviders()) {
    this.providers = providers;
  }

  get names() {
    return [...new Set(this.providers.map(provider => provider.name))];
  }

  invalidate() {
    this.probes.clear();
  }

  private forRoot(root: string) {
    const cached = this.probes.get(root);
    if (cached && cached.expires > Date.now()) return cached.result;
    if (this.probes.size >= 32) this.probes.clear();
    const result = this.detect(root);
    this.probes.set(root, { expires: Date.now() + PROBE_TTL, result });
    return result;
  }

  private async detect(root: string) {
    for (const provider of this.providers) {
      try { if (await provider.probe(root)) return provider; } catch { /* Try the next local provider. */ }
    }
    return undefined;
  }

  async plan(roots: readonly string[], preferSystem: boolean) {
    const providers = new Map<string, SystemProvider>();
    const sources: IndexSource[] = [];
    for (const root of roots) {
      const provider = preferSystem ? await this.forRoot(root) : undefined;
      if (provider) providers.set(root, provider);
      sources.push({ root, provider: provider?.name ?? 'Harmony' });
    }
    return { providers, sources, localRoots: roots.filter(root => !providers.has(root)) };
  }

  async entry(path: string, scope: ScanScope): Promise<ScanEntry | undefined> {
    if (!isAbsolute(path) || !scope.allows(path)) return;
    try {
      const [canonical, info] = await Promise.all([realpath(path), lstat(path)]);
      if (!scope.allows(canonical) || !isWithin(path, canonical) || !isWithin(canonical, path)) return;
      if (info.isDirectory() || info.isFile()) {
        return { name: basename(path), path, kind: info.isDirectory() ? 'directory' : 'file' };
      }
    } catch { /* Catalog entries can be stale or inaccessible. */ }
  }

  async *batches(providers: ReadonlyMap<string, SystemProvider>, scope: ScanScope, query: SystemQuery,
    limit = SYSTEM_RESULT_LIMIT, failed?: (root: string) => void, isCurrent = () => true,
    directory?: string): AsyncGenerator<readonly ScanEntry[]> {
    if (!providers.size) return;
    if (this.active >= 4) throw new Error('系统索引查询繁忙，请稍后重试。');
    this.active++;
    try {
      for (const [root, provider] of providers) {
        if (!isCurrent()) return;
        if (directory && !isWithin(root, directory) && !isWithin(directory, root)) continue;
        const searchRoot = directory && isWithin(root, directory) ? directory : root;
        if (!scope.owns(root, searchRoot)) continue;
        let paths: string[];
        try { paths = await provider.find(searchRoot, query, limit); }
        catch {
          if (searchRoot === root) {
            this.probes.set(root, { expires: Date.now() + PROBE_TTL, result: Promise.resolve(undefined) });
            failed?.(root);
          }
          continue;
        }
        const term = query.term && indexKey(query.term);
        const candidates = paths.filter(path => isAbsolute(path) && scope.owns(root, path) && path !== root
          && (!term || indexKey(basename(path)).includes(term)));
        for (let i = 0; i < candidates.length; i += VALIDATION_BATCH) {
          const entries = await Promise.all(candidates.slice(i, i + VALIDATION_BATCH).map(path => this.entry(path, scope)));
          if (!isCurrent()) return;
          yield entries.filter((entry): entry is ScanEntry => !!entry);
        }
      }
    } finally { this.active--; }
  }
}

export async function collectSearch(batches: AsyncIterable<readonly ScanEntry[]>, limit: number): Promise<SearchResults> {
  const matches: SearchResults['matches'] = [];
  const seen = new Set<string>();
  for await (const entries of batches) {
    for (const entry of entries) {
      if (seen.has(entry.path)) continue;
      if (matches.length === limit) return { matches, truncated: true };
      seen.add(entry.path);
      matches.push({ ...entry, directory: dirname(entry.path) });
    }
  }
  return { matches, truncated: false };
}
