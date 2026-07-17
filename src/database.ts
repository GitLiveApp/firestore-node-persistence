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

import {
  AdapterOpenRequest,
  AdapterRequest,
  EventHandler,
  newDOMException
} from './events';
import { NodeIDBObjectStore } from './object_store';
import {
  databaseFilePath,
  deleteDatabaseFiles,
  SqliteEngine
} from './sqlite_engine';
import { NodeIDBTransaction, TransactionScheduler } from './transaction';

/** Array-backed stand-in for DOMStringList. */
class StoreNameList {
  constructor(private readonly names: string[]) {}

  get length(): number {
    return this.names.length;
  }

  item(index: number): string | null {
    return index < this.names.length ? this.names[index] : null;
  }

  contains(name: string): boolean {
    return this.names.indexOf(name) >= 0;
  }

  [Symbol.iterator](): Iterator<string> {
    return this.names[Symbol.iterator]();
  }
}

/** Minimal IDBDatabase implementation for the Node adapter. */
export class NodeIDBDatabase {
  /**
   * Only fired by real IndexedDB when another connection requests an
   * upgrade or deletion. The Node adapter has no cross-connection
   * notifications, so this handler is stored but never invoked.
   */
  onversionchange: EventHandler = null;

  private readonly scheduler = new TransactionScheduler();
  private versionChangeTransaction: NodeIDBTransaction | null = null;
  private closed = false;

  constructor(
    readonly name: string,
    readonly version: number,
    private readonly engine: SqliteEngine
  ) {}

  get objectStoreNames(): StoreNameList {
    return new StoreNameList(this.engine.storeNames);
  }

  transaction(
    storeNames: string | string[],
    mode?: IDBTransactionMode
  ): NodeIDBTransaction {
    if (this.closed) {
      throw newDOMException(
        'InvalidStateError',
        'The database connection is closed.'
      );
    }
    if (
      this.versionChangeTransaction !== null &&
      !this.versionChangeTransaction.finished
    ) {
      throw newDOMException(
        'InvalidStateError',
        'A versionchange transaction is running.'
      );
    }
    const names = typeof storeNames === 'string' ? [storeNames] : storeNames;
    for (const storeName of names) {
      if (!this.engine.getStore(storeName)) {
        throw newDOMException(
          'NotFoundError',
          `No object store named '${storeName}' in this database.`
        );
      }
    }
    return new NodeIDBTransaction(
      this.engine,
      this.scheduler,
      mode === 'readwrite' ? 'readwrite' : 'readonly'
    );
  }

  /** DDL: only valid during a versionchange transaction. */
  createObjectStore(
    name: string,
    options?: IDBObjectStoreParameters
  ): NodeIDBObjectStore {
    const transaction = this.requireVersionChange('createObjectStore');
    if (this.engine.getStore(name)) {
      throw newDOMException(
        'ConstraintError',
        `An object store named '${name}' already exists.`
      );
    }
    const keyPath = options?.keyPath ?? null;
    this.engine.createObjectStore(
      name,
      keyPath as string | string[] | null,
      !!options?.autoIncrement
    );
    return new NodeIDBObjectStore(
      this.engine,
      transaction,
      this.engine.getStore(name)!
    );
  }

  deleteObjectStore(name: string): void {
    this.requireVersionChange('deleteObjectStore');
    if (!this.engine.getStore(name)) {
      throw newDOMException(
        'NotFoundError',
        `No object store named '${name}' in this database.`
      );
    }
    this.engine.deleteObjectStore(name);
  }

  private requireVersionChange(operation: string): NodeIDBTransaction {
    if (
      this.versionChangeTransaction === null ||
      this.versionChangeTransaction.finished
    ) {
      throw newDOMException(
        'InvalidStateError',
        `${operation} is only allowed within a versionchange transaction.`
      );
    }
    return this.versionChangeTransaction;
  }

  /**
   * Starts the versionchange transaction for an upgrade. Activated
   * synchronously so that schema DDL issued from the `onupgradeneeded`
   * handler executes inside the SQLite transaction.
   */
  _beginVersionChange(): NodeIDBTransaction {
    const transaction = new NodeIDBTransaction(
      this.engine,
      this.scheduler,
      'versionchange',
      /* activateImmediately= */ true
    );
    this.versionChangeTransaction = transaction;
    return transaction;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.engine.close();
  }
}

/**
 * Minimal IDBFactory implementation: `open` and `deleteDatabase`.
 *
 * Contrary to real IndexedDB there is no cross-connection version/blocked
 * arbitration: concurrent access to the same database file is mediated by
 * SQLite's file locking (`busy_timeout`), and a lock timeout surfaces as a
 * request error which the SDK's existing retry logic handles.
 */
export class NodeIDBFactory {
  constructor(private readonly directory?: string) {}

  open(name: string, version: number): AdapterOpenRequest {
    const request = new AdapterOpenRequest();
    queueMicrotask(() => {
      let engine: SqliteEngine;
      try {
        engine = new SqliteEngine(databaseFilePath(name, this.directory));
      } catch (e) {
        request.dispatchError(
          newDOMException('UnknownError', `Failed to open database: ${e}`)
        );
        return;
      }
      try {
        const oldVersion = engine.getVersion();
        if (oldVersion > version) {
          engine.close();
          request.dispatchError(
            newDOMException(
              'VersionError',
              `The requested version (${version}) is less than the ` +
                `existing version (${oldVersion}).`
            )
          );
          return;
        }
        const db = new NodeIDBDatabase(name, version, engine);
        if (oldVersion === version) {
          request.dispatchSuccess(db);
          return;
        }
        const transaction = db._beginVersionChange();
        // During an upgrade, the connection is already exposed through
        // `request.result` (read by `onupgradeneeded` handlers).
        request.result = db;
        request.transaction = transaction;
        transaction._beforeCommit = () => engine.setVersion(version);
        transaction._onFinished = committed => {
          request.transaction = null;
          if (committed) {
            request.dispatchSuccess(db);
          } else {
            db.close();
            request.dispatchError(
              transaction.error ??
                newDOMException(
                  'AbortError',
                  'The upgrade transaction was aborted.'
                )
            );
          }
        };
        // The handler synchronously performs DDL and enqueues data
        // migration requests; the transaction auto-commits once they drain.
        request.dispatchUpgradeNeeded(oldVersion, version);
      } catch (e) {
        engine.close();
        request.dispatchError(
          e instanceof DOMException
            ? e
            : newDOMException('UnknownError', String(e))
        );
      }
    });
    return request;
  }

  deleteDatabase(name: string): AdapterRequest {
    const request = new AdapterRequest();
    queueMicrotask(() => {
      try {
        deleteDatabaseFiles(name, this.directory);
        request.dispatchSuccess(undefined);
      } catch (e) {
        request.dispatchError(
          newDOMException('UnknownError', `Failed to delete database: ${e}`)
        );
      }
    });
    return request;
  }
}
