/**
 * @license
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * SQLite storage engine for the Node IndexedDB adapter.
 *
 * Uses the built-in `node:sqlite` module (Node.js >= 22.5), loaded lazily via
 * `process.getBuiltinModule` so that:
 * - no static import exists (bundlers never try to resolve it), and
 * - on older Node versions the adapter cleanly reports "unavailable" and the
 *   SDK falls back to memory persistence.
 */

/** Minimal structural typings for the `node:sqlite` API surface we use. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (location: string) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined = undefined;

/**
 * Returns the `node:sqlite` module, or null when unavailable (Node < 22.5 or
 * the module is disabled). The result is cached.
 *
 * `process.getBuiltinModule` (Node >= 22.3) is used instead of
 * `require`/`import()` so the lookup behaves identically in the CJS and ESM
 * builds and bundlers never try to resolve the specifier. It is absent from
 * this repo's `@types/node`, hence the structural cast.
 */
export function loadNodeSqlite(): SqliteModule | null {
  if (sqliteModule === undefined) {
    try {
      const getBuiltinModule = (
        process as unknown as {
          getBuiltinModule?: (id: string) => unknown;
        }
      ).getBuiltinModule;
      sqliteModule =
        (getBuiltinModule?.call(process, 'node:sqlite') as SqliteModule) ??
        null;
    } catch (e) {
      sqliteModule = null;
    }
  }
  return sqliteModule;
}

/** The default directory for persistent cache files. */
export function defaultDatabaseDirectory(): string {
  return path.resolve(process.cwd(), '.firestore');
}

/**
 * Maps an IndexedDB database name (e.g. `firestore/[DEFAULT]/my-project/main`)
 * to a SQLite file path under `directory`. Each slash-separated segment is
 * percent-encoded so arbitrary names map to safe, collision-free paths.
 */
export function databaseFilePath(name: string, directory?: string): string {
  const base = directory ?? defaultDatabaseDirectory();
  const segments = name.split('/').map(encodeURIComponent);
  const fileName = segments.pop()! + '.sqlite';
  return path.join(base, ...segments, fileName);
}

/** Deletes the SQLite database files for the given IndexedDB database name. */
export function deleteDatabaseFiles(name: string, directory?: string): void {
  const filePath = databaseFilePath(name, directory);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(filePath + suffix);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }
}

/** Catalog entry for an object store. */
export interface StoreMetadata {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
}

/** Catalog entry for an index. */
export interface IndexMetadata {
  storeName: string;
  name: string;
  keyPath: string | string[];
  unique: boolean;
}

function hexEncode(name: string): string {
  let hex = '';
  for (let i = 0; i < name.length; i++) {
    hex += name.charCodeAt(i).toString(16).padStart(4, '0');
  }
  return hex;
}

/** SQL identifier for an object store's table. */
export function storeTable(storeName: string): string {
  return `"s_${hexEncode(storeName)}"`;
}

/** SQL identifier for an index's table. */
export function indexTable(storeName: string, indexName: string): string {
  return `"i_${hexEncode(storeName)}_${hexEncode(indexName)}"`;
}

/**
 * Owns the SQLite connection for one IndexedDB database, its schema catalog
 * and its transaction state.
 */
export class SqliteEngine {
  private readonly db: SqliteDatabase;
  private readonly statements = new Map<string, SqliteStatement>();
  private stores = new Map<string, StoreMetadata>();
  private indexes = new Map<string, Map<string, IndexMetadata>>();
  private transactionActive = false;
  private closed = false;

  constructor(filePath: string) {
    const sqlite = loadNodeSqlite();
    if (!sqlite) {
      throw new Error(
        'The node:sqlite module is not available in this Node.js version.'
      );
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new sqlite.DatabaseSync(filePath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS _idb_meta (k TEXT PRIMARY KEY, v);
       CREATE TABLE IF NOT EXISTS _idb_stores (
         name TEXT PRIMARY KEY,
         key_path TEXT,
         auto_increment INTEGER NOT NULL DEFAULT 0,
         next_key INTEGER NOT NULL DEFAULT 1);
       CREATE TABLE IF NOT EXISTS _idb_indexes (
         store_name TEXT NOT NULL,
         name TEXT NOT NULL,
         key_path TEXT NOT NULL,
         is_unique INTEGER NOT NULL,
         PRIMARY KEY (store_name, name));`
    );
    this.reloadCatalog();
  }

  private prepare(sql: string): SqliteStatement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  run(sql: string, ...params: unknown[]): number {
    return Number(this.prepare(sql).run(...params).changes);
  }

  get(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.prepare(sql).get(...params);
  }

  all(sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
    return this.prepare(sql).all(...params);
  }

  /** Executes DDL. Invalidates the prepared-statement cache. */
  exec(sql: string): void {
    this.statements.clear();
    this.db.exec(sql);
  }

  /** Reloads the store/index catalog from the database. */
  reloadCatalog(): void {
    this.stores = new Map();
    this.indexes = new Map();
    for (const row of this.all(
      'SELECT name, key_path, auto_increment FROM _idb_stores'
    )) {
      const name = row['name'] as string;
      this.stores.set(name, {
        name,
        keyPath:
          row['key_path'] === null
            ? null
            : JSON.parse(row['key_path'] as string),
        autoIncrement: !!row['auto_increment']
      });
    }
    for (const row of this.all(
      'SELECT store_name, name, key_path, is_unique FROM _idb_indexes'
    )) {
      const storeName = row['store_name'] as string;
      let storeIndexes = this.indexes.get(storeName);
      if (!storeIndexes) {
        storeIndexes = new Map();
        this.indexes.set(storeName, storeIndexes);
      }
      storeIndexes.set(row['name'] as string, {
        storeName,
        name: row['name'] as string,
        keyPath: JSON.parse(row['key_path'] as string),
        unique: !!row['is_unique']
      });
    }
  }

  getVersion(): number {
    const row = this.get(`SELECT v FROM _idb_meta WHERE k = 'version'`);
    return row ? Number(row['v']) : 0;
  }

  setVersion(version: number): void {
    this.run(
      `INSERT INTO _idb_meta (k, v) VALUES ('version', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
      version
    );
  }

  get storeNames(): string[] {
    return Array.from(this.stores.keys()).sort();
  }

  getStore(name: string): StoreMetadata | undefined {
    return this.stores.get(name);
  }

  getIndexes(storeName: string): Map<string, IndexMetadata> {
    return this.indexes.get(storeName) ?? new Map();
  }

  getIndex(storeName: string, indexName: string): IndexMetadata | undefined {
    return this.indexes.get(storeName)?.get(indexName);
  }

  createObjectStore(
    name: string,
    keyPath: string | string[] | null,
    autoIncrement: boolean
  ): void {
    this.exec(
      `CREATE TABLE ${storeTable(name)} (
         key BLOB PRIMARY KEY,
         value BLOB NOT NULL) WITHOUT ROWID`
    );
    this.run(
      'INSERT INTO _idb_stores (name, key_path, auto_increment, next_key) VALUES (?, ?, ?, 1)',
      name,
      keyPath === null ? null : JSON.stringify(keyPath),
      autoIncrement ? 1 : 0
    );
    this.stores.set(name, { name, keyPath, autoIncrement });
  }

  deleteObjectStore(name: string): void {
    for (const indexName of this.getIndexes(name).keys()) {
      this.exec(`DROP TABLE IF EXISTS ${indexTable(name, indexName)}`);
    }
    this.exec(`DROP TABLE IF EXISTS ${storeTable(name)}`);
    this.run('DELETE FROM _idb_stores WHERE name = ?', name);
    this.run('DELETE FROM _idb_indexes WHERE store_name = ?', name);
    this.stores.delete(name);
    this.indexes.delete(name);
  }

  createIndex(
    storeName: string,
    indexName: string,
    keyPath: string | string[],
    unique: boolean
  ): IndexMetadata {
    const table = indexTable(storeName, indexName);
    this.exec(
      `CREATE TABLE ${table} (
         index_key BLOB NOT NULL,
         primary_key BLOB NOT NULL,
         PRIMARY KEY (index_key, primary_key)) WITHOUT ROWID;
       CREATE INDEX ${table.slice(0, -1)}_pk" ON ${table} (primary_key);` +
        (unique
          ? `CREATE UNIQUE INDEX ${table.slice(0, -1)}_u" ON ${table} (index_key);`
          : '')
    );
    this.run(
      'INSERT INTO _idb_indexes (store_name, name, key_path, is_unique) VALUES (?, ?, ?, ?)',
      storeName,
      indexName,
      JSON.stringify(keyPath),
      unique ? 1 : 0
    );
    const metadata: IndexMetadata = {
      storeName,
      name: indexName,
      keyPath,
      unique
    };
    let storeIndexes = this.indexes.get(storeName);
    if (!storeIndexes) {
      storeIndexes = new Map();
      this.indexes.set(storeName, storeIndexes);
    }
    storeIndexes.set(indexName, metadata);
    return metadata;
  }

  deleteIndex(storeName: string, indexName: string): void {
    this.exec(`DROP TABLE IF EXISTS ${indexTable(storeName, indexName)}`);
    this.run(
      'DELETE FROM _idb_indexes WHERE store_name = ? AND name = ?',
      storeName,
      indexName
    );
    this.indexes.get(storeName)?.delete(indexName);
  }

  /** Returns the next auto-increment key for a store and advances it. */
  generateKey(storeName: string): number {
    const row = this.get(
      'SELECT next_key FROM _idb_stores WHERE name = ?',
      storeName
    );
    const key = Number(row!['next_key']);
    this.run(
      'UPDATE _idb_stores SET next_key = next_key + 1 WHERE name = ?',
      storeName
    );
    return key;
  }

  /** Bumps the key generator past an explicitly-written numeric key. */
  maybeBumpKeyGenerator(storeName: string, explicitKey: number): void {
    if (!Number.isFinite(explicitKey) || explicitKey < 1) {
      return;
    }
    this.run(
      'UPDATE _idb_stores SET next_key = max(next_key, ?) WHERE name = ?',
      Math.floor(explicitKey) + 1,
      storeName
    );
  }

  get inTransaction(): boolean {
    return this.transactionActive;
  }

  begin(mode: 'readonly' | 'readwrite' | 'versionchange'): void {
    this.db.exec(mode === 'readonly' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    this.transactionActive = true;
  }

  commit(): void {
    this.db.exec('COMMIT');
    this.transactionActive = false;
  }

  rollback(wasVersionChange: boolean): void {
    // A rollback may be requested after a failed COMMIT; tolerate "no
    // transaction is active".
    try {
      this.db.exec('ROLLBACK');
    } catch (e) {
      // ignored
    }
    this.transactionActive = false;
    if (wasVersionChange) {
      // DDL performed during the aborted upgrade was rolled back; the
      // in-memory catalog must be restored to match.
      this.reloadCatalog();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch (e) {
      // ignored: closing an already-errored connection should not throw into
      // the SDK's shutdown path.
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
