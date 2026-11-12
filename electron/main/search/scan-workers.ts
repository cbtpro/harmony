import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ScanEntry, createScanScope } from './scan';

interface Request {
  directory?: string;
  root: string;
  size: number;
}

interface Batch {
  entries: Array<Pick<ScanEntry, 'name' | 'kind'>>;
  opened: boolean;
  done: boolean;
  skipped: boolean;
}

// Keep the worker entry self-contained so it runs from both source and an Electron ASAR.
function directoryWorker() {
  const { parentPort } = require('node:worker_threads') as typeof import('node:worker_threads');
  const { opendirSync, realpathSync, lstatSync } = require('node:fs') as typeof import('node:fs');
  const { relative } = require('node:path') as typeof import('node:path');
  let handle: import('node:fs').Dir | undefined;

  parentPort?.on('message', ({ directory, root, size }: Request) => {
    const batch: Batch = { entries: [], opened: false, done: false, skipped: false };
    try {
      if (directory !== undefined) {
        const canonical = realpathSync(directory);
        const info = lstatSync(canonical);
        if (relative(directory, canonical) || !info.isDirectory() || info.dev !== lstatSync(root).dev) {
          throw new Error('Directory is outside the selected volume');
        }
        handle = opendirSync(canonical, { bufferSize: size });
        batch.opened = true;
      }
      for (let count = 0; count < size; count++) {
        const child = handle?.readSync();
        if (!child) {
          batch.done = true;
          break;
        }
        if (child.isDirectory()) batch.entries.push({ name: child.name, kind: 'directory' });
        else if (child.isFile()) batch.entries.push({ name: child.name, kind: 'file' });
      }
    } catch {
      batch.done = true;
      batch.skipped = true;
    }
    if (batch.done) {
      try { handle?.closeSync(); } catch { batch.skipped = true; }
      handle = undefined;
    }
    parentPort?.postMessage(batch);
  });
}

interface ScanCallbacks {
  checkpoint(): Promise<boolean>;
  next(reserved: ReadonlySet<string>): string | undefined;
  write(path: string, entries: ScanEntry[], done: boolean, skipped: boolean): void;
  visitDirectory?(path: string): void;
}

export async function scanWithWorkers(
  threads: number,
  size: number,
  scope: ReturnType<typeof createScanScope>,
  callbacks: ScanCallbacks,
) {
  const workers: Worker[] = [];
  const reserved = new Set<string>();
  let cancelled = false;
  let notify: (() => void) | undefined;
  let activity: Promise<void> | undefined;

  function signal() {
    notify?.();
    activity = undefined;
    notify = undefined;
  }

  async function run(worker: Worker) {
    let reply: ((batch: Batch) => void) | undefined;
    let reject: ((error: Error) => void) | undefined;
    let failure: Error | undefined;
    worker.on('message', (batch: Batch) => reply?.(batch));
    worker.on('error', error => { failure = error; reject?.(error); });
    worker.on('exit', code => {
      failure ??= new Error(`索引线程已退出 (${code})`);
      reject?.(failure);
    });

    while (!cancelled && await callbacks.checkpoint()) {
      if (cancelled) return false;
      const path = callbacks.next(reserved);
      if (path === undefined) {
        if (!reserved.size) return true;
        activity ??= new Promise<void>(resolve => { notify = resolve; });
        await activity;
        continue;
      }
      reserved.add(path);
      try {
        const root = scope.owner(path);
        if (root === undefined) {
          callbacks.write(path, [], true, false);
          continue;
        }
        let request: Request = { directory: path, root, size };
        while (!cancelled && await callbacks.checkpoint()) {
          if (cancelled) return false;
          if (failure) throw failure;
          const batch = await new Promise<Batch>((resolve, fail) => {
            reply = resolve;
            reject = fail;
            worker.postMessage(request);
          });
          if (cancelled || !await callbacks.checkpoint()) return false;
          if (batch.opened) callbacks.visitDirectory?.(path);
          const entries = batch.entries.map(entry => ({ ...entry, path: join(path, entry.name) }))
            .filter(entry => scope.owns(path, entry.path));
          callbacks.write(path, entries, batch.done, batch.skipped);
          if (entries.some(entry => entry.kind === 'directory')) signal();
          if (batch.done) break;
          request = { root, size };
        }
      } finally {
        reserved.delete(path);
        signal();
      }
    }
    return false;
  }

  try {
    for (let slot = 0; slot < threads; slot++) {
      workers.push(new Worker(`(${directoryWorker.toString()})()`, { eval: true, execArgv: [] }));
    }
    const completed = await Promise.all(workers.map(run));
    return completed.every(Boolean);
  } finally {
    cancelled = true;
    signal();
    await Promise.allSettled(workers.map(worker => worker.terminate()));
  }
}
