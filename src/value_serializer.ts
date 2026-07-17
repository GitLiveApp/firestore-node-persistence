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

import { deserialize, serialize } from 'v8';

/**
 * Serialization of stored values for the Node IndexedDB adapter.
 *
 * Uses the V8 structured serializer (`node:v8`), which implements exactly the
 * structured-clone semantics IndexedDB requires — including `Uint8Array`
 * fields (used by the `globals` and `indexEntries` stores) and properties
 * with `undefined` values — with no tagging scheme or base64 overhead. This
 * is the same serialization format Chromium's IndexedDB uses on disk.
 *
 * The format is backwards-compatible (newer Node versions read data written
 * by older ones). The reverse direction is not guaranteed, which is
 * acceptable for a cache: a failed read surfaces as a request error and the
 * SDK's existing fallback/recovery paths apply.
 */

/** Serializes a value for storage, applying structured-clone semantics. */
export function serializeValue(value: unknown): Uint8Array {
  return serialize(value);
}

/** Deserializes a stored value. Always returns a fresh object. */
export function deserializeValue(bytes: Uint8Array): unknown {
  return deserialize(bytes);
}
