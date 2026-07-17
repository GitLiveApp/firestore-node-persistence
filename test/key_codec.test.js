/**
 * Property tests for the IndexedDB key codec: the memcmp order of encoded
 * keys must equal the IndexedDB key comparison algorithm
 * (https://www.w3.org/TR/IndexedDB/#compare-two-keys), and decoding must
 * round-trip.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
  compareIdbKeys,
  decodeIdbKey,
  encodeIdbKey,
  isValidIdbKey
} = require('../dist/key_codec');
const { NodeIDBKeyRange } = require('../dist/key_range');

/** Independent reference implementation of the spec's key comparison. */
function referenceCompare(a, b) {
  const rank = k =>
    typeof k === 'number'
      ? 0
      : k instanceof Date
        ? 1
        : typeof k === 'string'
          ? 2
          : k instanceof Uint8Array || k instanceof ArrayBuffer
            ? 3
            : 4;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) {
    return ra - rb;
  }
  switch (ra) {
    case 0:
      return a === b ? 0 : a < b ? -1 : 1;
    case 1:
      return a.getTime() - b.getTime();
    case 2:
      return a === b ? 0 : a < b ? -1 : 1;
    case 3: {
      const ba = a instanceof ArrayBuffer ? new Uint8Array(a) : a;
      const bb = b instanceof ArrayBuffer ? new Uint8Array(b) : b;
      for (let i = 0; i < Math.min(ba.length, bb.length); i++) {
        if (ba[i] !== bb[i]) {
          return ba[i] - bb[i];
        }
      }
      return ba.length - bb.length;
    }
    default: {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const c = referenceCompare(a[i], b[i]);
        if (c !== 0) {
          return c;
        }
      }
      return a.length - b.length;
    }
  }
}

function memcmp(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return a.length - b.length;
}

const sign = n => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function prng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomKey(rand, depth) {
  const choice = rand();
  if (choice < 0.3) {
    const r = rand();
    if (r < 0.3) {
      const edges = [
        0,
        -0,
        1,
        -1,
        0.5,
        -0.5,
        Number.MAX_SAFE_INTEGER,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        -Number.MIN_VALUE,
        Infinity,
        -Infinity,
        5e-324,
        1e300
      ];
      return edges[Math.floor(rand() * edges.length)];
    }
    return (rand() - 0.5) * Math.pow(10, Math.floor(rand() * 20) - 10);
  } else if (choice < 0.6) {
    // Strings, including embedded NULs, lone surrogates and non-BMP chars.
    const alphabet = [
      '',
      'a',
      'b',
      'zz',
      ' ',
      '\u0000',
      '\u00ff',
      '\u0100',
      '\ud7ff',
      '\ud800', // lone high surrogate (valid in UTF-16 code unit terms)
      '\udfff',
      '\ue000',
      '\uffff',
      '\ud83d\ude00', // non-BMP: surrogate pair
      '\u6587'
    ];
    let s = '';
    const len = Math.floor(rand() * 5);
    for (let i = 0; i < len; i++) {
      s += alphabet[Math.floor(rand() * alphabet.length)];
    }
    return s;
  } else if (choice < 0.75) {
    const len = Math.floor(rand() * 6);
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      const r = rand();
      bytes[i] = r < 0.25 ? 0 : r < 0.5 ? 255 : Math.floor(rand() * 256);
    }
    return bytes;
  } else if (choice < 0.85 || depth >= 3) {
    return new Date(Math.floor((rand() - 0.5) * 1e12));
  } else {
    const len = Math.floor(rand() * 4);
    const arr = [];
    for (let i = 0; i < len; i++) {
      arr.push(randomKey(rand, depth + 1));
    }
    return arr;
  }
}

describe('IndexedDB key codec', () => {
  it('memcmp order of encoded keys matches IndexedDB key order', () => {
    const rand = prng(20260717);
    const keys = [];
    for (let i = 0; i < 500; i++) {
      keys.push(randomKey(rand, 0));
    }
    const encoded = keys.map(k => encodeIdbKey(k));
    for (let i = 0; i < keys.length; i++) {
      for (let j = 0; j < keys.length; j++) {
        const expected = sign(referenceCompare(keys[i], keys[j]));
        assert.equal(
          sign(memcmp(encoded[i], encoded[j])),
          expected,
          `memcmp mismatch: ${JSON.stringify(keys[i])} vs ${JSON.stringify(
            keys[j]
          )}`
        );
        assert.equal(
          sign(compareIdbKeys(keys[i], keys[j])),
          expected,
          `compare mismatch: ${JSON.stringify(keys[i])} vs ${JSON.stringify(
            keys[j]
          )}`
        );
      }
    }
  });

  it('round-trips keys through encode/decode', () => {
    const rand = prng(42);
    for (let i = 0; i < 1000; i++) {
      const key = randomKey(rand, 0);
      const decoded = decodeIdbKey(encodeIdbKey(key));
      assert.equal(
        sign(referenceCompare(key, decoded)),
        0,
        `round trip changed ${JSON.stringify(key)}`
      );
    }
    assert.ok(Object.is(decodeIdbKey(encodeIdbKey(-0)), 0), '-0 normalizes');
  });

  it('rejects invalid keys', () => {
    for (const key of [NaN, undefined, null, true, {}, [NaN], new Date(NaN)]) {
      assert.equal(isValidIdbKey(key), false);
      assert.throws(() => encodeIdbKey(key));
    }
    const circular = [];
    circular.push(circular);
    assert.equal(isValidIdbKey(circular), false);
  });

  it('key ranges validate and test inclusion', () => {
    const range = NodeIDBKeyRange.bound(['a'], ['a', []], false, true);
    assert.equal(range.includes(['a']), true);
    assert.equal(range.includes(['a', 'b']), true);
    assert.equal(range.includes(['a', []]), false);
    assert.throws(() => NodeIDBKeyRange.bound(2, 1));
  });
});
