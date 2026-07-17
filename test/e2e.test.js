/**
 * End-to-end test against the stock published firebase package: enable
 * persistence at runtime, write a document while offline, "restart" (new
 * Firestore instance over the same directory) and read it back from the
 * cache, then clear persistence.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  registerFirestoreNodePersistence,
  isNodePersistenceSupported
} = require('../dist/register');

test('offline writes survive a restart via the SQLite cache', async () => {
  assert.ok(isNodePersistenceSupported(), 'node:sqlite must be available');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-addon-'));
  assert.equal(registerFirestoreNodePersistence({ directory }), true);

  const { initializeApp, deleteApp } = require('firebase/app');
  const {
    initializeFirestore,
    persistentLocalCache,
    disableNetwork,
    doc,
    setDoc,
    getDocFromCache,
    terminate,
    clearIndexedDbPersistence
  } = require('firebase/firestore');

  const APP_CONFIG = { apiKey: 'fake-api-key', projectId: 'addon-e2e-project' };
  const APP_NAME = 'addon-e2e';
  const newFirestore = () => {
    const app = initializeApp(APP_CONFIG, APP_NAME);
    const db = initializeFirestore(app, {
      localCache: persistentLocalCache()
    });
    return { app, db };
  };

  // Session 1: stage a write while offline.
  let { app, db } = newFirestore();
  await disableNetwork(db);
  setDoc(doc(db, 'users/alice'), {
    name: 'Alice',
    age: 30,
    tags: ['a', 'b']
  }).catch(() => {});

  let snap = await getDocFromCache(doc(db, 'users/alice'));
  assert.equal(snap.exists(), true);
  assert.deepEqual(snap.data(), { name: 'Alice', age: 30, tags: ['a', 'b'] });
  assert.equal(snap.metadata.hasPendingWrites, true);

  await terminate(db);
  await deleteApp(app);

  // Session 2: reopen over the same directory; data must come from disk.
  ({ app, db } = newFirestore());
  await disableNetwork(db);
  snap = await getDocFromCache(doc(db, 'users/alice'));
  assert.equal(snap.exists(), true);
  assert.deepEqual(snap.data(), { name: 'Alice', age: 30, tags: ['a', 'b'] });

  const sqliteFiles = fs
    .readdirSync(directory, { recursive: true })
    .map(String)
    .filter(f => f.endsWith('.sqlite'));
  assert.ok(sqliteFiles.length > 0, 'sqlite files exist under directory');

  // Clearing persistence removes the files.
  await terminate(db);
  await clearIndexedDbPersistence(db);
  const left = fs
    .readdirSync(directory, { recursive: true })
    .map(String)
    .filter(f => f.endsWith('.sqlite'));
  assert.deepEqual(left, []);

  await deleteApp(app);
  fs.rmSync(directory, { recursive: true, force: true });
});
