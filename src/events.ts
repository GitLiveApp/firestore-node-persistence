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

/**
 * Minimal event / request plumbing for the Node IndexedDB adapter.
 *
 * `simple_db.ts` (the only consumer of raw IndexedDB APIs in the SDK) uses
 * plain `onsuccess`/`onerror`/`onupgradeneeded`/... handler properties and
 * reads `event.target.result`, `event.target.error`, `event.oldVersion` and
 * `event.newVersion`. It never uses `addEventListener`, capture phases or
 * event propagation, so this module implements only that surface.
 */

/**
 * Creates a `DOMException` with the given name. Node.js (>= 17) provides
 * `DOMException` as a global.
 */
export function newDOMException(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

/** The event shape consumed by `simple_db.ts` handler callbacks. */
export interface AdapterEvent {
  type: string;
  target: unknown;
  // Present on versionchange / upgradeneeded events.
  oldVersion?: number;
  newVersion?: number | null;
}

export type EventHandler = ((event: AdapterEvent) => void) | null;

/**
 * Minimal stand-in for IDBRequest. Handlers are plain properties; assigning
 * a handler after the request completed does NOT fire it retroactively
 * (matching IndexedDB, where events fire from the task queue after handler
 * assignment happens synchronously at request-creation time).
 */
export class AdapterRequest {
  onsuccess: EventHandler = null;
  onerror: EventHandler = null;

  result: unknown = undefined;
  error: DOMException | null = null;

  /** Set for open requests during upgrades, read via `request.transaction`. */
  transaction: unknown = null;

  /** Marks the request done and fires onsuccess. */
  dispatchSuccess(result: unknown): void {
    this.result = result;
    this.error = null;
    if (this.onsuccess) {
      this.onsuccess({ type: 'success', target: this });
    }
  }

  /**
   * Marks the request failed and fires onerror. Returns after the handler
   * (if any) ran.
   */
  dispatchError(error: DOMException): void {
    this.error = error;
    if (this.onerror) {
      this.onerror({ type: 'error', target: this });
    }
  }
}

/** Open request: additionally exposes `onupgradeneeded` and `onblocked`. */
export class AdapterOpenRequest extends AdapterRequest {
  onupgradeneeded: EventHandler = null;
  onblocked: EventHandler = null;

  dispatchUpgradeNeeded(oldVersion: number, newVersion: number): void {
    if (this.onupgradeneeded) {
      this.onupgradeneeded({
        type: 'upgradeneeded',
        target: this,
        oldVersion,
        newVersion
      });
    }
  }
}
