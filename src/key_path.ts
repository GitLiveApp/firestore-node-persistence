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

import { isValidIdbKey } from './key_codec';

/**
 * Key path evaluation for the Node IndexedDB adapter, per
 * https://www.w3.org/TR/IndexedDB/#evaluate-a-key-path-on-a-value
 *
 * Firestore's schema uses only plain property names ('batchId') and arrays
 * of plain property names (['userId', 'batchId']), but dotted paths ('a.b')
 * are supported for spec completeness.
 */

/**
 * Extracts the key at `keyPath` from `value`. Returns `undefined` when the
 * key path doesn't resolve or resolves to an invalid key (the caller then
 * treats the operation per spec: error for a store write, "no index entry"
 * for index maintenance).
 */
export function extractKeyFromValue(
  value: unknown,
  keyPath: string | string[]
): IDBValidKey | undefined {
  if (Array.isArray(keyPath)) {
    const result: IDBValidKey[] = [];
    for (const path of keyPath) {
      const component = extractSingle(value, path);
      if (component === undefined || !isValidIdbKey(component)) {
        return undefined;
      }
      result.push(component as IDBValidKey);
    }
    return result;
  }
  const key = extractSingle(value, keyPath);
  if (key === undefined || !isValidIdbKey(key)) {
    return undefined;
  }
  return key as IDBValidKey;
}

function extractSingle(value: unknown, keyPath: string): unknown {
  let current = value;
  if (keyPath === '') {
    return current;
  }
  for (const segment of keyPath.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      !(segment in (current as Record<string, unknown>))
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Injects a generated key into `value` at `keyPath` (used by autoIncrement
 * stores with in-line keys). Intermediate objects are created as needed, per
 * https://www.w3.org/TR/IndexedDB/#inject-a-key-into-a-value
 */
export function injectKeyIntoValue(
  value: unknown,
  keyPath: string,
  key: IDBValidKey
): void {
  const segments = keyPath.split('.');
  let current = value as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    if (
      !(segment in current) ||
      typeof current[segment] !== 'object' ||
      current[segment] === null
    ) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments[segments.length - 1]] = key;
}
