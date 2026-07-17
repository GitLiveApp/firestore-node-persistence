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
import { AdapterRequest } from './events';
import { boundsConditions, encodeBounds } from './key_range';
import type { NodeIDBObjectStore } from './object_store';
import { IndexMetadata, indexTable } from './sqlite_engine';
import { deserializeValue } from './value_serializer';

/** Minimal IDBIndex implementation over the adapter's index tables. */
export class NodeIDBIndex {
  constructor(
    readonly _store: NodeIDBObjectStore,
    readonly _metadata: IndexMetadata
  ) {}

  get name(): string {
    return this._metadata.name;
  }

  get _table(): string {
    return indexTable(this._metadata.storeName, this._metadata.name);
  }

  getAll(
    range?: IDBValidKey | IDBKeyRange | null,
    count?: number
  ): AdapterRequest {
    const bounds = encodeBounds(range);
    const request = new AdapterRequest();
    this._store._transaction._enqueueRequest(request, () => {
      const params: unknown[] = [];
      const conditions = boundsConditions('i.index_key', bounds, params);
      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit =
        count !== undefined && count > 0 ? `LIMIT ${Math.floor(count)}` : '';
      const rows = this._store._engine.all(
        `SELECT s.value AS value
           FROM ${this._table} i JOIN ${this._store._table} s
             ON s.key = i.primary_key
           ${where}
           ORDER BY i.index_key ASC, i.primary_key ASC ${limit}`,
        ...params
      );
      return rows.map(row => deserializeValue(row['value'] as Uint8Array));
    });
    return request;
  }

  openCursor(
    range?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection
  ): AdapterRequest {
    return this.cursor(range, direction, /* keysOnly= */ false);
  }

  openKeyCursor(
    range?: IDBValidKey | IDBKeyRange | null,
    direction?: IDBCursorDirection
  ): AdapterRequest {
    return this.cursor(range, direction, /* keysOnly= */ true);
  }

  private cursor(
    range: IDBValidKey | IDBKeyRange | null | undefined,
    direction: IDBCursorDirection | undefined,
    keysOnly: boolean
  ): AdapterRequest {
    const request = new AdapterRequest();
    const cursor = NodeIDBCursor.overIndex(
      this,
      request,
      encodeBounds(range),
      direction === 'prev',
      keysOnly
    );
    cursor._scheduleStep(null);
    return request;
  }
}
