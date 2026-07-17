# @gitlive/firestore-node-persistence

Persistent local cache for **Cloud Firestore on Node.js**, as a runtime add-on
for the stock `firebase` / `@firebase/firestore` npm packages — no fork, no
patching.

The Firestore SDK's persistence layer is built entirely on IndexedDB and its
only environment gate is the presence of a working `indexedDB` global. This
package provides a minimal IndexedDB implementation backed by the built-in
`node:sqlite` module (Node.js ≥ 22.5), covering exactly the API surface the
SDK's `SimpleDb` wrapper uses, and installs it as `globalThis.indexedDB` /
`globalThis.IDBKeyRange`. The SDK's entire persistence stack (schema v18,
migrations, LRU garbage collection, client-side indexing) then runs unchanged.

## Usage

```js
import { registerFirestoreNodePersistence } from '@gitlive/firestore-node-persistence';

// Must run before Firestore is initialized.
registerFirestoreNodePersistence({ directory: './.firestore' }); // directory is optional

import { initializeApp } from 'firebase/app';
import { initializeFirestore, persistentLocalCache } from 'firebase/firestore';

const app = initializeApp({ /* ... */ });
const db = initializeFirestore(app, {
  localCache: persistentLocalCache()
});
```

Documents written offline are durably staged and query results are cached in
SQLite files under `directory` (default: `.firestore` in the working
directory), one file per Firestore database, and survive process restarts.

`registerFirestoreNodePersistence()` returns `false` (and installs nothing)
when `node:sqlite` is unavailable (Node < 22.5); Firestore then falls back to
its memory cache exactly as it does today.

## Implementation notes

- **Key encoding**: IndexedDB keys (numbers, strings, binary, nested arrays)
  are encoded to byte strings whose memcmp order equals the IndexedDB key
  ordering — including UTF-16 code-unit string comparison — so SQLite BLOB
  primary keys reproduce IndexedDB semantics exactly. Validated by property
  tests against a reference implementation of the spec's comparison algorithm.
- **Values** are stored with the V8 structured serializer (`node:v8`), the
  same structured-clone semantics (and on-disk format family) Chromium's own
  IndexedDB uses.
- **Transactions** map to SQLite transactions with FIFO scheduling and
  IndexedDB-style auto-commit; cursors are incremental B-tree seeks, so
  iterate-and-mutate patterns and large scans behave correctly with bounded
  memory.
- Validated against the SDK's own persistence test suites (SimpleDb,
  LocalStore, IndexedDbPersistence incl. primary-lease arbitration, and the
  spec test matrix) as well as an offline write → restart → read-from-cache
  end-to-end test against the published `firebase` package.

## Caveats

- **Single tab manager only**: `persistentSingleTabManager` (the default).
  Multi-tab synchronization requires LocalStorage and does not apply to Node.
- **One process per cache directory.** The stock SDK has a bug on
  LocalStorage-less platforms (`isClientZombied` treats every client as
  zombied), so a second process pointed at the same directory would steal the
  primary lease instead of failing cleanly. Fixed upstream in
  [firebase-js-sdk PR](https://github.com/GitLiveApp/firebase-js-sdk/pull/1);
  until that lands, share nothing.
- The SDK logs a spurious `LocalStorage is unavailable` warning at startup on
  Node; it is harmless (that concern is about browser tab refreshes).
- Data written by a newer Node.js major version may not be readable by an
  older one (V8 serializer forward-compatibility); for a cache this surfaces
  as a clean failure and rebuild, not corruption.
- The globals are only installed if no `indexedDB` global already exists
  (refuses to fight other polyfills such as `fake-indexeddb`).

## License

Apache-2.0. Portions derived from
[firebase-js-sdk](https://github.com/firebase/firebase-js-sdk) (Apache-2.0).
