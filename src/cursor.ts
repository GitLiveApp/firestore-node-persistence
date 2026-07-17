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

import { AdapterRequest, newDOMException } from './events';
import { decodeIdbKey, encodeIdbKey } from './key_codec';
import { EncodedBounds } from './key_range';
import type { NodeIDBObjectStore } from './object_store';
import { deserializeValue } from './value_serializer';

import type { NodeIDBIndex } from './idb_index';

/**
 * Minimal IDBCursor / IDBCursorWithValue implementation.
 *
 * Each step is a fresh B-tree seek (`WHERE key > :position ... LIMIT 1`)
 * against SQLite rather than a materialized result set. This keeps memory
 * bounded for full-store scans and — more importantly — stays correct when
 * the iteration mutates the store as it goes (`deleteAll` iterates a cursor
 * and deletes each row via `cursor.delete()`).
 *
 * Every step is enqueued on the owning transaction and re-fires `onsuccess`
 * on the original request with `result` set to the cursor (or null when
 * exhausted), exactly like real IndexedDB.
 */
export class NodeIDBCursor {
  /** Encoded position of the last returned row, null before the first row. */
  private lastIndexKey: Uint8Array | null = null;
  private lastPrimaryKey: Uint8Array | null = null;

  primaryKey: IDBValidKey | undefined = undefined;
  key: IDBValidKey | undefined = undefined;
  value: unknown = undefined;

  private constructor(
    private readonly store: NodeIDBObjectStore,
    private readonly index: NodeIDBIndex | null,
    private readonly request: AdapterRequest,
    private readonly bounds: EncodedBounds,
    private readonly reverse: boolean,
    private readonly keysOnly: boolean
  ) {}

  static overStore(
    store: NodeIDBObjectStore,
    request: AdapterRequest,
    bounds: EncodedBounds,
    reverse: boolean
  ): NodeIDBCursor {
    return new NodeIDBCursor(store, null, request, bounds, reverse, false);
  }

  static overIndex(
    index: NodeIDBIndex,
    request: AdapterRequest,
    bounds: EncodedBounds,
    reverse: boolean,
    keysOnly: boolean
  ): NodeIDBCursor {
    return new NodeIDBCursor(
      index._store,
      index,
      request,
      bounds,
      reverse,
      keysOnly
    );
  }

  get direction(): IDBCursorDirection {
    return this.reverse ? 'prev' : 'next';
  }

  /** Public IDBCursor API: advance to the next row (>= seekKey if given). */
  continue(seekKey?: IDBValidKey): void {
    this._scheduleStep(seekKey === undefined ? null : encodeIdbKey(seekKey));
  }

  /** Public IDBCursor API: delete the row the cursor points at. */
  delete(): AdapterRequest {
    if (this.keysOnly) {
      throw newDOMException(
        'InvalidStateError',
        'Cannot delete through a keys-only cursor.'
      );
    }
    const encodedPrimaryKey = encodeIdbKey(this.primaryKey!);
    const deleteRequest = new AdapterRequest();
    this.store._transaction._enqueueRequest(deleteRequest, () => {
      this.store._deleteEncoded(encodedPrimaryKey);
      return undefined;
    });
    return deleteRequest;
  }

  /**
   * Enqueues one iteration step. `seek` optionally skips ahead to the first
   * row at or beyond the given encoded key (in iteration direction).
   */
  _scheduleStep(seek: Uint8Array | null): void {
    this.store._transaction._enqueueRequest(this.request, () =>
      this.index === null ? this.stepStore(seek) : this.stepIndex(seek)
    );
  }

  private stepStore(seek: Uint8Array | null): NodeIDBCursor | null {
    const params: unknown[] = [];
    const conditions: string[] = [];
    const gt = this.reverse ? '<' : '>';
    const gte = this.reverse ? '<=' : '>=';
    if (this.lastPrimaryKey !== null) {
      conditions.push(`key ${gt} ?`);
      params.push(this.lastPrimaryKey);
    }
    if (seek !== null) {
      conditions.push(`key ${gte} ?`);
      params.push(seek);
    }
    this.pushBoundsConditions('key', conditions, params);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = this.reverse ? 'DESC' : 'ASC';
    const row = this.store._engine.get(
      `SELECT key, value FROM ${this.store._table} ${where}
       ORDER BY key ${order} LIMIT 1`,
      ...params
    );
    if (!row) {
      return null;
    }
    this.lastPrimaryKey = row['key'] as Uint8Array;
    this.primaryKey = decodeIdbKey(this.lastPrimaryKey);
    this.key = this.primaryKey;
    this.value = deserializeValue(row['value'] as Uint8Array);
    return this;
  }

  private stepIndex(seek: Uint8Array | null): NodeIDBCursor | null {
    const params: unknown[] = [];
    const conditions: string[] = [];
    const gt = this.reverse ? '<' : '>';
    const gte = this.reverse ? '<=' : '>=';
    if (this.lastIndexKey !== null) {
      // Strictly beyond the (index_key, primary_key) composite position.
      conditions.push(
        `(index_key ${gt} ? OR (index_key = ? AND primary_key ${gt} ?))`
      );
      params.push(this.lastIndexKey, this.lastIndexKey, this.lastPrimaryKey);
    }
    if (seek !== null) {
      conditions.push(`index_key ${gte} ?`);
      params.push(seek);
    }
    this.pushBoundsConditions('index_key', conditions, params);
    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const order = this.reverse ? 'DESC' : 'ASC';
    const row = this.store._engine.get(
      `SELECT index_key, primary_key FROM ${this.index!._table} ${where}
       ORDER BY index_key ${order}, primary_key ${order} LIMIT 1`,
      ...params
    );
    if (!row) {
      return null;
    }
    this.lastIndexKey = row['index_key'] as Uint8Array;
    this.lastPrimaryKey = row['primary_key'] as Uint8Array;
    this.key = decodeIdbKey(this.lastIndexKey);
    this.primaryKey = decodeIdbKey(this.lastPrimaryKey);
    if (this.keysOnly) {
      this.value = undefined;
    } else {
      const valueRow = this.store._engine.get(
        `SELECT value FROM ${this.store._table} WHERE key = ?`,
        this.lastPrimaryKey
      );
      this.value = valueRow
        ? deserializeValue(valueRow['value'] as Uint8Array)
        : undefined;
    }
    return this;
  }

  private pushBoundsConditions(
    column: string,
    conditions: string[],
    params: unknown[]
  ): void {
    if (this.bounds.lower !== undefined) {
      conditions.push(`${column} ${this.bounds.lowerOpen ? '>' : '>='} ?`);
      params.push(this.bounds.lower);
    }
    if (this.bounds.upper !== undefined) {
      conditions.push(`${column} ${this.bounds.upperOpen ? '<' : '<='} ?`);
      params.push(this.bounds.upper);
    }
  }
}
