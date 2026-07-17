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

import { AdapterRequest, EventHandler, newDOMException } from './events';
import { NodeIDBObjectStore } from './object_store';
import type { SqliteEngine } from './sqlite_engine';

export type AdapterTransactionMode = 'readonly' | 'readwrite' | 'versionchange';

/**
 * Transaction scheduling for the Node IndexedDB adapter.
 *
 * All transactions on one connection run strictly FIFO: a transaction holds
 * the underlying SQLite transaction from activation until commit/rollback,
 * and the next queued transaction activates afterwards. This is sufficient
 * for Firestore because all persistence work is funneled through a single
 * `AsyncQueue` and `SimpleDb.runTransaction` awaits each transaction's
 * completion; overlapping transactions do not occur in practice. (FIFO
 * serialization is also spec-legal behavior for overlapping-scope readwrite
 * transactions.)
 */
export class TransactionScheduler {
  private queue: NodeIDBTransaction[] = [];
  private current: NodeIDBTransaction | null = null;

  enqueue(transaction: NodeIDBTransaction): void {
    this.queue.push(transaction);
    queueMicrotask(() => this.maybeActivateNext());
  }

  /**
   * Registers an already-activated transaction (the versionchange
   * transaction, which must be active synchronously during `open` so that
   * schema DDL executes inside it).
   */
  _adopt(transaction: NodeIDBTransaction): void {
    this.current = transaction;
  }

  transactionFinished(transaction: NodeIDBTransaction): void {
    if (this.current === transaction) {
      this.current = null;
    }
    queueMicrotask(() => this.maybeActivateNext());
  }

  private maybeActivateNext(): void {
    if (this.current !== null || this.queue.length === 0) {
      return;
    }
    this.current = this.queue.shift()!;
    this.current._activate();
  }
}

interface QueuedRequest {
  request: AdapterRequest;
  exec: () => unknown;
}

function toDOMException(e: unknown): DOMException {
  return e instanceof DOMException
    ? e
    : newDOMException('UnknownError', String(e));
}

type TransactionState = 'queued' | 'active' | 'finished';

/**
 * Minimal IDBTransaction implementation over a SQLite transaction.
 *
 * Requests are executed from a microtask so that callers always get to
 * assign `onsuccess`/`onerror` handlers synchronously after issuing a
 * request, matching real IndexedDB semantics. Handler callbacks run
 * synchronously during the drain; `PersistencePromise` continuations
 * (Firestore's IDB-safe promise implementation) therefore enqueue any
 * follow-up requests before the queue empties, which makes auto-commit
 * detection reliable: when the request queue is empty after a full drain
 * pass (plus one microtask of grace), the transaction commits.
 */
export class NodeIDBTransaction {
  oncomplete: EventHandler = null;
  onabort: EventHandler = null;
  onerror: EventHandler = null;

  error: DOMException | null = null;

  /** Invoked just before COMMIT (used to persist the new schema version). */
  _beforeCommit: (() => void) | null = null;
  /** Internal completion hooks (used by the open/upgrade flow). */
  _onFinished: ((committed: boolean) => void) | null = null;

  private state: TransactionState = 'queued';
  private requests: QueuedRequest[] = [];
  private draining = false;
  private noNewRequests = false;

  constructor(
    private readonly engine: SqliteEngine,
    private readonly scheduler: TransactionScheduler,
    readonly mode: AdapterTransactionMode,
    activateImmediately = false
  ) {
    if (activateImmediately) {
      scheduler._adopt(this);
      engine.begin(mode);
      this.state = 'active';
      // Run the drain/auto-commit machinery even if no request is ever
      // enqueued (e.g. an upgrade that only performs DDL).
      this.scheduleDrain();
    } else {
      scheduler.enqueue(this);
    }
  }

  get finished(): boolean {
    return this.state === 'finished';
  }

  /** Returns a transaction-scoped store accessor. */
  objectStore(name: string): NodeIDBObjectStore {
    if (this.state === 'finished') {
      throw newDOMException(
        'InvalidStateError',
        'The transaction has finished.'
      );
    }
    const metadata = this.engine.getStore(name);
    if (!metadata) {
      throw newDOMException(
        'NotFoundError',
        `No object store named '${name}' in this database.`
      );
    }
    return new NodeIDBObjectStore(this.engine, this, metadata);
  }

  /** Called by the scheduler when this transaction reaches the head. */
  _activate(): void {
    if (this.state === 'finished') {
      // abort() was called while still queued.
      this.scheduler.transactionFinished(this);
      return;
    }
    try {
      this.engine.begin(this.mode);
    } catch (e) {
      // e.g. the connection was closed while this transaction was queued.
      this.abort(toDOMException(e));
      return;
    }
    this.state = 'active';
    this.scheduleDrain();
  }

  /**
   * Enqueues a request. `exec` runs synchronously against SQLite when the
   * request is drained; its return value becomes `request.result`.
   */
  _enqueueRequest(request: AdapterRequest, exec: () => unknown): void {
    if (this.state === 'finished' || this.noNewRequests) {
      throw newDOMException(
        'TransactionInactiveError',
        'The transaction has finished.'
      );
    }
    this.requests.push({ request, exec });
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.draining || this.state !== 'active') {
      return;
    }
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.state !== 'active') {
      return;
    }
    while (this.requests.length > 0) {
      const { request, exec } = this.requests.shift()!;
      let result: unknown;
      try {
        result = exec();
      } catch (e) {
        const error =
          e instanceof DOMException
            ? e
            : newDOMException('UnknownError', String(e));
        request.dispatchError(error);
        // Per spec, an unhandled request error aborts the transaction. (The
        // SDK also calls abort() itself from its promise chain; whichever
        // runs first wins.)
        if (this.state === 'active') {
          this.abort(error);
        }
        return;
      }
      request.dispatchSuccess(result);
      // Handler callbacks may have aborted/committed the transaction.
      if ((this.state as TransactionState) !== 'active') {
        return;
      }
    }
    // The queue is empty. Give handlers one microtask to issue follow-up
    // requests, then auto-commit.
    queueMicrotask(() => {
      if (this.state === 'active' && this.requests.length === 0) {
        this.doCommit();
      }
    });
  }

  /** Explicit commit (IndexedDB v3 `transaction.commit()`). */
  commit(): void {
    if (this.state === 'finished') {
      throw newDOMException(
        'InvalidStateError',
        'The transaction has already finished.'
      );
    }
    this.noNewRequests = true;
    if (this.state === 'active' && this.requests.length === 0) {
      this.doCommit();
    }
    // Otherwise the drain loop commits once the queue empties.
  }

  private doCommit(): void {
    if (this.state !== 'active') {
      return;
    }
    try {
      if (this._beforeCommit) {
        this._beforeCommit();
      }
      this.engine.commit();
    } catch (e) {
      const error =
        e instanceof DOMException
          ? e
          : newDOMException('UnknownError', String(e));
      this.finish(false, error);
      return;
    }
    this.finish(true, null);
  }

  abort(error?: DOMException): void {
    if (this.state === 'finished') {
      return;
    }
    if (this.state === 'active') {
      this.engine.rollback(this.mode === 'versionchange');
    }
    this.finish(false, error ?? null);
  }

  private finish(committed: boolean, error: DOMException | null): void {
    const pending = this.requests;
    this.requests = [];
    this.state = 'finished';
    this.error = error;
    if (!committed) {
      // Settle any never-executed requests so no promise dangles.
      const abortError =
        error ?? newDOMException('AbortError', 'The transaction was aborted.');
      for (const { request } of pending) {
        request.dispatchError(abortError);
      }
    }
    if (this._onFinished) {
      this._onFinished(committed);
    }
    if (committed) {
      if (this.oncomplete) {
        this.oncomplete({ type: 'complete', target: this });
      }
    } else {
      if (this.onabort) {
        this.onabort({ type: 'abort', target: this });
      }
    }
    this.scheduler.transactionFinished(this);
  }
}
