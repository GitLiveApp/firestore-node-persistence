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

import { newDOMException } from './events';
import { compareIdbKeys, encodeIdbKey, isValidIdbKey } from './key_codec';

/**
 * Structural implementation of IDBKeyRange for the Node adapter. Instances
 * are shape-compatible with the DOM `IDBKeyRange` interface, so code typed
 * against `IDBKeyRange` works with them unchanged.
 */
export class NodeIDBKeyRange {
  constructor(
    readonly lower: IDBValidKey | undefined,
    readonly upper: IDBValidKey | undefined,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean
  ) {}

  static only(value: IDBValidKey): NodeIDBKeyRange {
    validateRangeKey(value);
    return new NodeIDBKeyRange(value, value, false, false);
  }

  static lowerBound(lower: IDBValidKey, open?: boolean): NodeIDBKeyRange {
    validateRangeKey(lower);
    return new NodeIDBKeyRange(lower, undefined, !!open, true);
  }

  static upperBound(upper: IDBValidKey, open?: boolean): NodeIDBKeyRange {
    validateRangeKey(upper);
    return new NodeIDBKeyRange(undefined, upper, true, !!open);
  }

  static bound(
    lower: IDBValidKey,
    upper: IDBValidKey,
    lowerOpen?: boolean,
    upperOpen?: boolean
  ): NodeIDBKeyRange {
    validateRangeKey(lower);
    validateRangeKey(upper);
    const cmp = compareIdbKeys(lower, upper);
    if (cmp > 0 || (cmp === 0 && (lowerOpen || upperOpen))) {
      throw newDOMException(
        'DataError',
        'The lower key is greater than the upper key.'
      );
    }
    return new NodeIDBKeyRange(lower, upper, !!lowerOpen, !!upperOpen);
  }

  includes(key: IDBValidKey): boolean {
    if (this.lower !== undefined) {
      const cmp = compareIdbKeys(this.lower, key);
      if (cmp > 0 || (cmp === 0 && this.lowerOpen)) {
        return false;
      }
    }
    if (this.upper !== undefined) {
      const cmp = compareIdbKeys(key, this.upper);
      if (cmp > 0 || (cmp === 0 && this.upperOpen)) {
        return false;
      }
    }
    return true;
  }
}

function validateRangeKey(key: unknown): void {
  if (!isValidIdbKey(key)) {
    throw newDOMException(
      'DataError',
      'The provided value is not a valid IndexedDB key.'
    );
  }
}

/**
 * The bounds of a key range, encoded for use in SQL comparisons against the
 * BLOB-encoded key columns. `undefined` means unbounded on that side.
 */
export interface EncodedBounds {
  lower: Uint8Array | undefined;
  lowerOpen: boolean;
  upper: Uint8Array | undefined;
  upperOpen: boolean;
}

/**
 * Encodes the bounds of an IDBKeyRange (or a bare key, or null/undefined
 * meaning "everything") for SQL comparison.
 */
export function encodeBounds(
  keyOrRange: IDBValidKey | IDBKeyRange | null | undefined
): EncodedBounds {
  if (keyOrRange === null || keyOrRange === undefined) {
    return {
      lower: undefined,
      lowerOpen: true,
      upper: undefined,
      upperOpen: true
    };
  }
  if (isKeyRange(keyOrRange)) {
    return {
      lower:
        keyOrRange.lower === undefined
          ? undefined
          : encodeIdbKey(keyOrRange.lower),
      lowerOpen: keyOrRange.lowerOpen,
      upper:
        keyOrRange.upper === undefined
          ? undefined
          : encodeIdbKey(keyOrRange.upper),
      upperOpen: keyOrRange.upperOpen
    };
  }
  const encoded = encodeIdbKey(keyOrRange);
  return { lower: encoded, lowerOpen: false, upper: encoded, upperOpen: false };
}

/**
 * Appends SQL WHERE conditions (and their parameters) applying `bounds` to
 * the given BLOB key column.
 */
export function boundsConditions(
  column: string,
  bounds: EncodedBounds,
  params: unknown[]
): string[] {
  const conditions: string[] = [];
  if (bounds.lower !== undefined) {
    conditions.push(`${column} ${bounds.lowerOpen ? '>' : '>='} ?`);
    params.push(bounds.lower);
  }
  if (bounds.upper !== undefined) {
    conditions.push(`${column} ${bounds.upperOpen ? '<' : '<='} ?`);
    params.push(bounds.upper);
  }
  return conditions;
}

function isKeyRange(value: unknown): value is IDBKeyRange {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    ('lower' in value || 'upper' in value)
  );
}
