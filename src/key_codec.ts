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

/**
 * Order-preserving binary encoding of IndexedDB keys.
 *
 * The encoding is designed so that an unsigned bytewise comparison (memcmp,
 * which is exactly how SQLite compares BLOBs) of two encoded keys yields the
 * same ordering as the IndexedDB key comparison algorithm defined in
 * https://www.w3.org/TR/IndexedDB/#compare-two-keys:
 *
 *   number < date < string < binary < array
 *
 * Every encoded key is a type tag byte followed by a self-delimiting payload,
 * which makes the encoding unambiguously decodable (required to recover
 * cursor primary keys and generated keys).
 *
 * - number: 8-byte big-endian IEEE-754 with the standard total-order
 *   transform (negative numbers have all bits inverted; non-negative numbers
 *   have the sign bit set), so bytewise order equals numeric order.
 *   `-0` is normalized to `+0` (IndexedDB compares them equal).
 * - date: the same number encoding of `getTime()` under a different tag.
 * - string: UTF-16 code units (IndexedDB compares strings by code unit, NOT
 *   by code point or UTF-8 bytes), each written as 2 big-endian bytes, with
 *   0x00 bytes escaped as 0x00 0xFF and a 0x00 0x00 terminator. The escape
 *   keeps the terminator smaller than any payload, so a prefix string sorts
 *   before its extensions.
 * - binary: raw bytes with the same escape/terminator scheme.
 * - array: concatenation of the full encodings of its elements followed by a
 *   0x00 terminator byte. The terminator is smaller than every type tag, so
 *   a prefix array sorts before its extensions.
 */

const TAG_NUMBER = 0x10;
const TAG_DATE = 0x20;
const TAG_STRING = 0x30;
const TAG_BINARY = 0x40;
const TAG_ARRAY = 0x50;
const ARRAY_TERMINATOR = 0x00;

/** Mutable byte sink used while encoding. */
class ByteWriter {
  private buffer = new Uint8Array(64);
  private length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.buffer.length) {
      return;
    }
    let newSize = this.buffer.length * 2;
    while (newSize < this.length + extra) {
      newSize *= 2;
    }
    const newBuffer = new Uint8Array(newSize);
    newBuffer.set(this.buffer.subarray(0, this.length));
    this.buffer = newBuffer;
  }

  writeByte(b: number): void {
    this.ensure(1);
    this.buffer[this.length++] = b;
  }

  /** Writes a payload byte, escaping 0x00 as 0x00 0xFF. */
  writeEscapedByte(b: number): void {
    if (b === 0x00) {
      this.ensure(2);
      this.buffer[this.length++] = 0x00;
      this.buffer[this.length++] = 0xff;
    } else {
      this.writeByte(b);
    }
  }

  /** Writes the 0x00 0x00 terminator for string/binary payloads. */
  writeTerminator(): void {
    this.ensure(2);
    this.buffer[this.length++] = 0x00;
    this.buffer[this.length++] = 0x00;
  }

  toUint8Array(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

/** Returns true if the value is a valid IndexedDB key. */
export function isValidIdbKey(key: unknown): boolean {
  return isValidIdbKeyInternal(key, new Set());
}

function isValidIdbKeyInternal(key: unknown, seen: Set<unknown>): boolean {
  if (typeof key === 'number') {
    return !isNaN(key);
  } else if (typeof key === 'string') {
    return true;
  } else if (key instanceof Date) {
    return !isNaN(key.getTime());
  } else if (isBinary(key)) {
    return true;
  } else if (Array.isArray(key)) {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    for (const element of key) {
      if (!isValidIdbKeyInternal(element, seen)) {
        return false;
      }
    }
    seen.delete(key);
    return true;
  }
  return false;
}

function isBinary(key: unknown): key is Uint8Array | ArrayBuffer {
  return (
    key instanceof Uint8Array ||
    key instanceof ArrayBuffer ||
    ArrayBuffer.isView(key)
  );
}

function toBytes(key: Uint8Array | ArrayBuffer): Uint8Array {
  if (key instanceof Uint8Array) {
    return key;
  } else if (key instanceof ArrayBuffer) {
    return new Uint8Array(key);
  } else {
    const view = key as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
}

/**
 * Encodes an IndexedDB key into an order-preserving byte array.
 * Throws a 'DataError' DOMException for invalid keys, per the IndexedDB spec.
 */
export function encodeIdbKey(key: unknown): Uint8Array {
  if (!isValidIdbKey(key)) {
    throw newDOMException(
      'DataError',
      `The provided value (${String(key)}) is not a valid IndexedDB key.`
    );
  }
  const writer = new ByteWriter();
  encodeInto(key, writer);
  return writer.toUint8Array();
}

function encodeInto(key: unknown, writer: ByteWriter): void {
  if (typeof key === 'number') {
    writer.writeByte(TAG_NUMBER);
    encodeNumberInto(key, writer);
  } else if (key instanceof Date) {
    writer.writeByte(TAG_DATE);
    encodeNumberInto(key.getTime(), writer);
  } else if (typeof key === 'string') {
    writer.writeByte(TAG_STRING);
    for (let i = 0; i < key.length; i++) {
      const codeUnit = key.charCodeAt(i);
      writer.writeEscapedByte(codeUnit >>> 8);
      writer.writeEscapedByte(codeUnit & 0xff);
    }
    writer.writeTerminator();
  } else if (isBinary(key)) {
    writer.writeByte(TAG_BINARY);
    const bytes = toBytes(key);
    for (let i = 0; i < bytes.length; i++) {
      writer.writeEscapedByte(bytes[i]);
    }
    writer.writeTerminator();
  } else {
    // Validation guarantees this is an array.
    writer.writeByte(TAG_ARRAY);
    for (const element of key as unknown[]) {
      encodeInto(element, writer);
    }
    writer.writeByte(ARRAY_TERMINATOR);
  }
}

const numberScratch = new DataView(new ArrayBuffer(8));

function encodeNumberInto(value: number, writer: ByteWriter): void {
  // Normalize -0 to +0: IndexedDB compares them as equal, so they must
  // produce identical encodings.
  numberScratch.setFloat64(
    0,
    value === 0 ? 0 : value,
    /* littleEndian= */ false
  );
  const negative = (numberScratch.getUint8(0) & 0x80) !== 0;
  for (let i = 0; i < 8; i++) {
    let b = numberScratch.getUint8(i);
    if (negative) {
      // Negative numbers: invert all bits so that more-negative values sort
      // lower.
      b = ~b & 0xff;
    } else if (i === 0) {
      // Non-negative numbers: set the sign bit so they sort above all
      // negative numbers.
      b = b | 0x80;
    }
    writer.writeByte(b);
  }
}

/** Reads bytes while decoding. */
class ByteReader {
  position = 0;
  constructor(private readonly bytes: Uint8Array) {}

  readByte(): number {
    if (this.position >= this.bytes.length) {
      throw new Error('Unexpected end of encoded IndexedDB key');
    }
    return this.bytes[this.position++];
  }

  peekByte(): number {
    if (this.position >= this.bytes.length) {
      throw new Error('Unexpected end of encoded IndexedDB key');
    }
    return this.bytes[this.position];
  }

  /**
   * Reads an escaped payload up to (and consuming) the 0x00 0x00 terminator,
   * returning the unescaped bytes.
   */
  readEscaped(): Uint8Array {
    const out: number[] = [];
    for (;;) {
      const b = this.readByte();
      if (b === 0x00) {
        const next = this.readByte();
        if (next === 0x00) {
          return new Uint8Array(out);
        } else if (next === 0xff) {
          out.push(0x00);
        } else {
          throw new Error('Invalid escape sequence in encoded IndexedDB key');
        }
      } else {
        out.push(b);
      }
    }
  }
}

/** Decodes a key produced by {@link encodeIdbKey}. */
export function decodeIdbKey(encoded: Uint8Array): IDBValidKey {
  const reader = new ByteReader(encoded);
  const key = decodeFrom(reader);
  return key;
}

function decodeFrom(reader: ByteReader): IDBValidKey {
  const tag = reader.readByte();
  switch (tag) {
    case TAG_NUMBER:
      return decodeNumberFrom(reader);
    case TAG_DATE:
      return new Date(decodeNumberFrom(reader));
    case TAG_STRING: {
      const bytes = reader.readEscaped();
      let result = '';
      for (let i = 0; i < bytes.length; i += 2) {
        result += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return result;
    }
    case TAG_BINARY:
      // Cast: newer TypeScript DOM typings make Uint8Array generic in a way
      // that no longer structurally matches IDBValidKey's BufferSource.
      return reader.readEscaped() as unknown as IDBValidKey;
    case TAG_ARRAY: {
      const elements: IDBValidKey[] = [];
      while (reader.peekByte() !== ARRAY_TERMINATOR) {
        elements.push(decodeFrom(reader));
      }
      reader.readByte(); // consume terminator
      return elements;
    }
    default:
      throw new Error(`Invalid IndexedDB key tag: ${tag}`);
  }
}

function decodeNumberFrom(reader: ByteReader): number {
  const first = reader.readByte();
  const negative = (first & 0x80) === 0;
  numberScratch.setUint8(0, negative ? ~first & 0xff : first & 0x7f);
  for (let i = 1; i < 8; i++) {
    const b = reader.readByte();
    numberScratch.setUint8(i, negative ? ~b & 0xff : b);
  }
  return numberScratch.getFloat64(0, /* littleEndian= */ false);
}

/**
 * Compares two decoded IndexedDB keys per the spec's comparison algorithm.
 * Exposed for the adapter's higher layers (key range checks) and tests.
 */
export function compareIdbKeys(a: unknown, b: unknown): number {
  const typeA = keyTypeOrder(a);
  const typeB = keyTypeOrder(b);
  if (typeA !== typeB) {
    return typeA < typeB ? -1 : 1;
  }
  switch (typeA) {
    case 0: {
      // number
      const na = a as number;
      const nb = b as number;
      return na < nb ? -1 : na > nb ? 1 : 0;
    }
    case 1: {
      // date
      const da = (a as Date).getTime();
      const db = (b as Date).getTime();
      return da < db ? -1 : da > db ? 1 : 0;
    }
    case 2: {
      // string: JS < and > compare by UTF-16 code units, matching the spec.
      const sa = a as string;
      const sb = b as string;
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    case 3: {
      // binary
      const ba = toBytes(a as Uint8Array | ArrayBuffer);
      const bb = toBytes(b as Uint8Array | ArrayBuffer);
      const len = Math.min(ba.length, bb.length);
      for (let i = 0; i < len; i++) {
        if (ba[i] !== bb[i]) {
          return ba[i] < bb[i] ? -1 : 1;
        }
      }
      return ba.length === bb.length ? 0 : ba.length < bb.length ? -1 : 1;
    }
    default: {
      // array
      const aa = a as unknown[];
      const ab = b as unknown[];
      const len = Math.min(aa.length, ab.length);
      for (let i = 0; i < len; i++) {
        const cmp = compareIdbKeys(aa[i], ab[i]);
        if (cmp !== 0) {
          return cmp;
        }
      }
      return aa.length === ab.length ? 0 : aa.length < ab.length ? -1 : 1;
    }
  }
}

function keyTypeOrder(key: unknown): number {
  if (typeof key === 'number') {
    return 0;
  } else if (key instanceof Date) {
    return 1;
  } else if (typeof key === 'string') {
    return 2;
  } else if (isBinary(key)) {
    return 3;
  } else {
    return 4;
  }
}
