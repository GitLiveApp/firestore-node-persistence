/**
 * Firestore persistent cache for Node.js — runtime add-on prototype.
 *
 * Installs a minimal, SQLite-backed IndexedDB implementation as the global
 * `indexedDB` / `IDBKeyRange`, which is all the stock `@firebase/firestore`
 * package needs for `persistentLocalCache()` to work under Node.js.
 *
 * Must be called before Firestore is initialized.
 */

import { NodeIDBFactory } from './database';
import { NodeIDBKeyRange } from './key_range';
import { loadNodeSqlite } from './sqlite_engine';

export interface FirestoreNodePersistenceOptions {
  /**
   * Directory where the SQLite database files are stored.
   * Defaults to `.firestore` under the current working directory.
   */
  directory?: string;
}

/** True iff the built-in `node:sqlite` module is available (Node >= 22.5). */
export function isNodePersistenceSupported(): boolean {
  return loadNodeSqlite() !== null;
}

/**
 * Installs the SQLite-backed IndexedDB implementation into the global scope
 * so that Firestore's persistent cache works in Node.js.
 *
 * @returns true if installed, false if `node:sqlite` is unavailable (the
 * Firestore SDK will then fall back to its memory cache, as it does today).
 * @throws if a different `indexedDB` global is already installed.
 */
export function registerFirestoreNodePersistence(
  options?: FirestoreNodePersistenceOptions
): boolean {
  const globalAny = globalThis as Record<string, unknown>;
  if (globalAny['__firestoreNodePersistence']) {
    return true; // already registered
  }
  if (typeof globalAny['indexedDB'] !== 'undefined') {
    throw new Error(
      'An indexedDB global is already installed (another polyfill?); ' +
        'refusing to overwrite it.'
    );
  }
  if (!isNodePersistenceSupported()) {
    return false;
  }
  const factory = new NodeIDBFactory(options?.directory);
  globalAny['indexedDB'] = factory;
  globalAny['IDBKeyRange'] = NodeIDBKeyRange;
  globalAny['__firestoreNodePersistence'] = true;
  return true;
}

/** Removes the installed globals (mainly for tests). */
export function unregisterFirestoreNodePersistence(): void {
  const globalAny = globalThis as Record<string, unknown>;
  if (globalAny['__firestoreNodePersistence']) {
    delete globalAny['indexedDB'];
    delete globalAny['IDBKeyRange'];
    delete globalAny['__firestoreNodePersistence'];
  }
}
