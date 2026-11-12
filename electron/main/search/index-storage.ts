import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ScanEntry } from './scan';

export function openTemporaryDatabase() {
  const database = new DatabaseSync('');
  // An empty SQLite filename uses a private temporary file that can spill to disk.
  try {
    database.exec('PRAGMA temp_store = FILE; PRAGMA cache_size = -2048; PRAGMA cache_spill = ON;');
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function indexKey(value: string) {
  return value.normalize('NFC').toLowerCase();
}

export type ScanState = 'running' | 'paused' | 'stopped' | 'ready';

export class IndexStorage {
  private readonly database: DatabaseSync;
  private readonly insert;
  private readonly byPath;
  private readonly nextDirectory;
  private readonly batch;
  private readonly latest;
  private readonly ignorePath;
  private readonly allowPath;
  private readonly moveFile;
  private readonly markSeen;
  private readonly missingChildren;
  private readonly removePathBatch;
  private readonly queueDirectory;
  private readonly takeDirectories;
  private readonly completeDirectory;
  private readonly updateState;
  count = 0;

  constructor(file?: string) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      closeSync(openSync(file, 'a', 0o600));
    }
    this.database = file ? new DatabaseSync(file) : openTemporaryDatabase();
    if (file) this.database.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA cache_size=-2048;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        parent TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        name_key TEXT NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS directories ON entries(id) WHERE kind = 'directory';
      CREATE INDEX IF NOT EXISTS children ON entries(parent, id);
      CREATE TABLE IF NOT EXISTS ignored (path TEXT PRIMARY KEY) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS scan_state (id INTEGER PRIMARY KEY CHECK (id = 1), signature TEXT, phase TEXT, count INTEGER, skipped INTEGER);
      CREATE TABLE IF NOT EXISTS scan_queue (id INTEGER PRIMARY KEY, path TEXT UNIQUE, done INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS queued ON scan_queue(id) WHERE done = 0;
    `);
    this.insert = this.database.prepare(`
      INSERT OR IGNORE INTO entries(path, parent, name, kind, name_key, seen)
      SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM entries WHERE path = ?)
        AND (? > 0 OR NOT EXISTS (SELECT 1 FROM ignored WHERE path = ?))
    `);
    this.byPath = this.database.prepare('SELECT path, name, kind FROM entries WHERE path = ?');
    this.nextDirectory = this.database.prepare(`
      SELECT id, path FROM entries WHERE kind = 'directory' AND id > ? ORDER BY id LIMIT 1
    `);
    this.batch = this.database.prepare(`
      SELECT id, path, name, kind, (? = '' OR instr(name_key, ?) > 0) AS matched FROM entries
      WHERE id > ? AND id <= ? ORDER BY id LIMIT ?
    `);
    this.latest = this.database.prepare('SELECT coalesce(max(id), 0) AS id FROM entries');
    this.ignorePath = this.database.prepare('INSERT OR IGNORE INTO ignored VALUES (?)');
    this.allowPath = this.database.prepare('DELETE FROM ignored WHERE path = ?');
    this.moveFile = this.database.prepare(`
      UPDATE OR REPLACE entries SET path = ?, parent = ?, name = ?, name_key = ? WHERE path = ? AND kind = 'file'
    `);
    this.markSeen = this.database.prepare('UPDATE entries SET seen = ? WHERE path = ? AND seen <> ?');
    this.missingChildren = this.database.prepare(`
      SELECT id, path, seen FROM entries WHERE parent = ? AND id > ? AND id <= ? ORDER BY id LIMIT ?
    `);
    this.removePathBatch = this.database.prepare(`
      DELETE FROM entries WHERE id IN (
        SELECT id FROM entries WHERE path >= ? AND path < ? LIMIT ?
      ) OR path = ?
    `);
    this.queueDirectory = this.database.prepare('INSERT OR IGNORE INTO scan_queue(path) VALUES (?)');
    this.takeDirectories = this.database.prepare('SELECT path FROM scan_queue WHERE done = 0 ORDER BY id LIMIT ?');
    this.completeDirectory = this.database.prepare('UPDATE scan_queue SET done = 1 WHERE path = ?');
    this.updateState = this.database.prepare('UPDATE scan_state SET count = count + ?, skipped = skipped + ? WHERE id = 1');
    this.count = this.checkpoint()?.count ?? 0;
  }

  private transaction<T>(write: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = write();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      // SQLite may already have rolled back a write when the disk filled up.
      try { this.database.exec('ROLLBACK'); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  add(entries: readonly ScanEntry[], seen = 0) {
    const added = this.transaction(() => this.insertEntries(entries, seen));
    this.count += added;
    return added;
  }

  private insertEntries(entries: readonly ScanEntry[], seen: number) {
    let added = 0;
    for (const { path, name, kind } of entries) {
      const changes = Number(this.insert.run(path, dirname(path), name, kind, indexKey(name), seen, path, seen, path).changes);
      if (!changes && seen) this.markSeen.run(seen, path, seen);
      added += changes;
    }
    return added;
  }

  checkpoint() {
    return this.database.prepare('SELECT signature, phase, count, skipped FROM scan_state WHERE id = 1').get() as
      { signature: string; phase: ScanState; count: number; skipped: number } | undefined;
  }

  begin(signature: string, roots: readonly string[]) {
    this.transaction(() => {
      this.database.exec('DELETE FROM entries; DELETE FROM ignored; DELETE FROM scan_queue; DELETE FROM scan_state;');
      this.database.prepare("INSERT INTO scan_state VALUES (1, ?, 'running', 0, 0)").run(signature);
      for (const root of roots) this.queueDirectory.run(root);
    });
    this.count = 0;
  }

  next(reserved: ReadonlySet<string>) {
    const rows = this.takeDirectories.all(reserved.size + 1) as Array<{ path: string }>;
    return rows.find(row => !reserved.has(row.path))?.path;
  }

  completedDirectories(limit: number) {
    const rows = this.database.prepare('SELECT path FROM scan_queue WHERE done = 1 ORDER BY id LIMIT ?')
      .all(limit) as Array<{ path: string }>;
    return rows.map(row => row.path);
  }

  scanBatch(path: string, entries: readonly ScanEntry[], done: boolean, skipped: boolean) {
    const added = this.transaction(() => {
      const count = this.insertEntries(entries, 0);
      for (const entry of entries) {
        if (entry.kind === 'directory') this.queueDirectory.run(entry.path);
      }
      if (done) this.completeDirectory.run(path);
      this.updateState.run(count, skipped ? 1 : 0);
      return count;
    });
    this.count += added;
  }

  setScanState(phase: ScanState) {
    this.database.prepare('UPDATE scan_state SET phase = ? WHERE id = 1').run(phase);
  }

  find(path: string) {
    return this.byPath.get(path) as ScanEntry | undefined;
  }

  directory(after: number) {
    return this.nextDirectory.get(after) as { id: number; path: string } | undefined;
  }

  lastId() {
    return (this.latest.get() as { id: number }).id;
  }

  read(after: number, through: number, limit: number, term: string) {
    return this.batch.all(term, term, after, through, limit) as unknown as Array<ScanEntry & { id: number; matched: number }>;
  }

  children(parent: string, after: number, through: number, limit: number) {
    return this.missingChildren.all(parent, after, through, limit) as Array<{ id: number; path: string; seen: number }>;
  }

  remove(path: string, limit: number) {
    const prefix = path.endsWith(sep) ? path : path + sep;
    const upper = prefix.slice(0, -1) + String.fromCharCode(sep.charCodeAt(0) + 1);
    const removed = Number(this.removePathBatch.run(prefix, upper, limit, path).changes);
    this.count -= removed;
    return removed;
  }

  replace(previous: string, next: ScanEntry, scanning: boolean) {
    const current = this.find(previous);
    const indexed = current?.kind === 'file';
    const displaced = indexed && previous !== next.path && !!this.find(next.path);
    this.transaction(() => {
      if (scanning) {
        this.ignorePath.run(previous);
        this.allowPath.run(next.path);
        if (indexed) this.ignorePath.run(next.path);
      }
      if (indexed) this.moveFile.run(next.path, dirname(next.path), next.name, indexKey(next.name), previous);
    });
    if (displaced) this.count--;
    return indexed;
  }

  close() {
    this.database.close();
  }
}
