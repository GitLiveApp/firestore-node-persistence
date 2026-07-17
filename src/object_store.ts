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

import { NodeIDBCursor } from './cursor';
import { AdapterRequest, newDOMException } from './events';
import { encodeIdbKey, isValidIdbKey } from './key_codec';
import { extractKeyFromValue, injectKeyIntoValue } from './key_path';
import { boundsConditions, encodeBounds, EncodedBounds } from './key_range';
import {
  IndexMetadata,
  indexTable,
  SqliteEngine,
  StoreMetadata,
  storeTable
} from './sqlite_engine';
import type { NodeIDBTransaction } from './transaction';
import { deserializeValue, serializeValue } from './value_serializer';

import { NodeIDBIndex } from './index';

/**
 * Minimal IDBObjectStore implementation over a SQLite table.
 *
 * Instances are scoped to one transaction, matching IndexedDB semantics
 * (`transaction.objectStore(name)` returns a transaction-bound store).
 */
export class NodeIDBObjectStore {
  constructor(
    readonly _engine: SqliteEngine,
    readonly _transaction: NodeIDBTransaction,
    readonly _metadata: StoreMetadata
  ) {}

  get name(): string {
    return this._metadata.name;
  }

  get keyPath(): string | string[] | null {
    return this._metadata.keyPath;
  }

  get _table(): string {
    return storeTable(this._metadata.name);
  }

  private request(exec: () => unknown): AdapterRequest {
    const request = new AdapterRequest();
    this._transaction._enqueueRequest(request, exec);
    return request;
  }

  put(value: unknown, key?: IDBValidKey): AdapterRequest {
    return this.storeValue(value, key, /* noOverwrite= */ false);
  }

  add(value: unknown, key?: IDBValidKey): AdapterRequest {
    return this.storeValue(value, key, /* noOverwrite= */ true);
  }

  private storeValue(
    value: unknown,
    explicitKey: IDBValidKey | undefined,
    noOverwrite: boolean
  ): AdapterRequest {
    const { keyPath, autoIncrement, name } = this._metadata;
    if (explicitKey !== undefined && keyPath !== null) {
      throw newDOMException(
        'DataError',
        `An explicit key cannot be provided for object store '${name}' ` +
          'which uses in-line keys.'
      );
    }
    // Per structured-clone semantics, the value is cloned (serialized) at
    // call time.
    let serialized = serializeValue(value);
    let key: IDBValidKey | undefined = explicitKey;
    if (key === undefined && keyPath !== null && !Array.isArray(keyPath)) {
      key = extractKeyFromValue(value, keyPath);
    } else if (key === undefined && Array.isArray(keyPath)) {
      key = extractKeyFromValue(value, keyPath);
    }
    if (key !== undefined && !isValidIdbKey(key)) {
      throw newDOMException(
        'DataError',
        'The provided key is not a valid IndexedDB key.'
      );
    }
    if (key === undefined && !autoIncrement) {
      throw newDOMException(
        'DataError',
        `No key provided and object store '${name}' has no key generator.`
      );
    }

    return this.request(() => {
      let effectiveKey = key;
      if (effectiveKey === undefined) {
        // autoIncrement store: mint a key. For in-line keys, the generated
        // key is also injected into the stored value.
        effectiveKey = this._engine.generateKey(name);
        if (keyPath !== null && !Array.isArray(keyPath)) {
          const patched = deserializeValue(serialized);
          injectKeyIntoValue(patched, keyPath, effectiveKey);
          serialized = serializeValue(patched);
        }
      } else if (autoIncrement && typeof effectiveKey === 'number') {
        this._engine.maybeBumpKeyGenerator(name, effectiveKey);
      }
      const encodedKey = encodeIdbKey(effectiveKey);
      if (noOverwrite) {
        const existing = this._engine.get(
          `SELECT 1 AS present FROM ${this._table} WHERE key = ?`,
          encodedKey
        );
        if (existing) {
          throw newDOMException(
            'ConstraintError',
            `A record with key already exists in object store '${name}'.`
          );
        }
      }
      this.writeRow(encodedKey, serialized);
      return effectiveKey;
    });
  }

  /**
   * Writes a row and maintains all index tables. Shared by put/add.
   */
  private writeRow(encodedKey: Uint8Array, serialized: Uint8Array): void {
    const indexes = this._engine.getIndexes(this.name);
    if (indexes.size > 0) {
      // Remove index entries for any row being overwritten, then re-derive.
      for (const index of indexes.values()) {
        this._engine.run(
          `DELETE FROM ${indexTable(this.name, index.name)} WHERE primary_key = ?`,
          encodedKey
        );
      }
      const value = deserializeValue(serialized);
      for (const index of indexes.values()) {
        this.insertIndexEntry(index, value, encodedKey);
      }
    }
    this._engine.run(
      `INSERT INTO ${this._table} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      encodedKey,
      serialized
    );
  }

  private insertIndexEntry(
    index: IndexMetadata,
    value: unknown,
    encodedPrimaryKey: Uint8Array
  ): void {
    const indexKey = extractKeyFromValue(value, index.keyPath);
    if (indexKey === undefined) {
      // Per IndexedDB semantics, a record whose value doesn't yield a valid
      // index key simply has no entry in that index.
      return;
    }
    try {
      this._engine.run(
        `INSERT INTO ${indexTable(this.name, index.name)}
           (index_key, primary_key) VALUES (?, ?)`,
        encodeIdbKey(indexKey),
        encodedPrimaryKey
      );
    } catch (e) {
      if (index.unique && String(e).indexOf('UNIQUE') >= 0) {
        throw newDOMException(
          'ConstraintError',
          `Unable to add key to index '${index.name}': at least one key ` +
            `does not satisfy the uniqueness requirements.`
        );
      }
      throw e;
    }
  }

  get(keyOrRange: IDBValidKey | IDBKeyRange): AdapterRequest {
    const bounds = encodeBounds(keyOrRange);
    return this.request(() => {
      const params: unknown[] = [];
      const conditions = boundsConditions('key', bounds, params);
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const row = this._engine.get(
        `SELECT value FROM ${this._table} ${where} ORDER BY key ASC LIMIT 1`,
        ...params
      );
      return row ? deserializeValue(row['value'] as Uint8Array) : undefined;
    });
  }

  delete(keyOrRange: IDBValidKey | IDBKeyRange): AdapterRequest {
    const bounds = encodeBounds(keyOrRange);
    return this.request(() => {
      this.deleteWhere(bounds);
      return undefined;
    });
  }

  /** Deletes all rows matching bounds, maintaining index tables. */
  private deleteWhere(bounds: EncodedBounds): void {
    const params: unknown[] = [];
    const conditions = boundsConditions('key', bounds, params);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    for (const index of this._engine.getIndexes(this.name).values()) {
      this._engine.run(
        `DELETE FROM ${indexTable(this.name, index.name)}
         WHERE primary_key IN (SELECT key FROM ${this._table} ${where})`,
        ...params
      );
    }
    this._engine.run(`DELETE FROM ${this._table} ${where}`, ...params);
  }

  /** Deletes a single row given its already-encoded primary key. */
  _deleteEncoded(encodedKey: Uint8Array): void {
    for (const index of this._engine.getIndexes(this.name).values()) {
      this._engine.run(
        `DELETE FROM ${indexTable(this.name, index.name)} WHERE primary_key = ?`,
        encodedKey
      );
    }
    this._engine.run(`DELETE FROM ${this._table} WHERE key = ?`, encodedKey);
  }

  count(): AdapterRequest {
    return this.request(() => {
      const row = this._engine.get(`SELECT COUNT(*) AS n FROM ${this._table}`);
      return Number(row!['n']);
    });
  }

  clear(): AdapterRequest {
    return this.request(() => {
      for (const index of this._engine.getIndexes(this.name).values()) {
        this._engine.run(`DELETE FROM ${indexTable(this.name, index.name)}`);
      }
      this._engine.run(`DELETE FROM ${this._table}`);
      return undefined;
    });
  }

  getAll(
    range?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ): AdapterRequest {
    const bounds = encodeBounds(range);
    return this.request(() => {
      const params: unknown[] = [];
      const conditions = boundsConditions('key', bounds, params);
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit =
        count !== undefined && count > 0 ? `LIMIT ${Math.floor(count)}` : '';
      const rows = this._engine.all(
        `SELECT value FROM ${this._table} ${where} ORDER BY key ASC ${limit}`,
        ...params
      );
      return rows.map(row => deserializeValue(row['value'] as Uint8Array));
    });
  }

  openCursor(
    range?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection
  ): AdapterRequest {
    const request = new AdapterRequest();
    const cursor = NodeIDBCursor.overStore(
      this,
      request,
      encodeBounds(range),
      direction === 'prev'
    );
    cursor._scheduleStep(null);
    return request;
  }

  index(name: string): NodeIDBIndex {
    const metadata = this._engine.getIndex(this.name, name);
    if (!metadata) {
      throw newDOMException(
        'NotFoundError',
        `No index named '${name}' on object store '${this.name}'.`
      );
    }
    return new NodeIDBIndex(this, metadata);
  }

  /** DDL: only valid during a versionchange transaction. */
  createIndex(
    name: string,
    keyPath: string | string[],
    options?: IDBIndexParameters
  ): NodeIDBIndex {
    if (this._transaction.mode !== 'versionchange') {
      throw newDOMException(
        'InvalidStateError',
        'createIndex is only allowed within a versionchange transaction.'
      );
    }
    if (options?.multiEntry) {
      // No Firestore schema version uses multiEntry indexes; supporting them
      // would require a different index-table layout.
      throw newDOMException(
        'InvalidAccessError',
        'multiEntry indexes are not supported by the Node persistence adapter.'
      );
    }
    const metadata = this._engine.createIndex(
      this.name,
      name,
      keyPath,
      !!options?.unique
    );
    // Populate the index from existing rows (IndexedDB indexes are
    // retroactive when created over a non-empty store).
    const rows = this._engine.all(`SELECT key, value FROM ${this._table}`);
    for (const row of rows) {
      this.insertIndexEntry(
        metadata,
        deserializeValue(row['value'] as Uint8Array),
        row['key'] as Uint8Array
      );
    }
    return new NodeIDBIndex(this, metadata);
  }

  deleteIndex(name: string): void {
    if (this._transaction.mode !== 'versionchange') {
      throw newDOMException(
        'InvalidStateError',
        'deleteIndex is only allowed within a versionchange transaction.'
      );
    }
    this._engine.deleteIndex(this.name, name);
  }
}
