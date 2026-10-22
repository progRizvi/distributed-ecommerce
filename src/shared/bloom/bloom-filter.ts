import { createHash } from 'node:crypto';

// Bloom filter: a small bit array that answers "definitely NOT seen" or "maybe seen".
//  - "no"    is always right (no false negatives, as long as every item was added).
//  - "maybe" can be wrong sometimes (false positive), so the caller must confirm with the real source.
// It is a shortcut, never the source of truth.

// Where the bits live. Redis in production, memory in tests.
export interface BitStore {
  setBits(key: string, offsets: number[]): Promise<void>;
  getBits(key: string, offsets: number[]): Promise<boolean[]>;
}

export interface BloomOptions {
  /** Name used in the Redis key, like "email". */
  name: string;
  expectedItems: number;
  falsePositiveRate: number;
}

// Redis strings are limited to 2^32 bits (512 MB).
export const MAX_BITS = 2 ** 32;
const ADD_CHUNK = 1000;

export function bloomSizing(expectedItems: number, falsePositiveRate: number): { bits: number; hashes: number } {
  if (!Number.isFinite(expectedItems) || expectedItems < 1) throw new Error('expectedItems must be at least 1');
  if (!(falsePositiveRate > 0 && falsePositiveRate < 1)) throw new Error('falsePositiveRate must be between 0 and 1');
  const bits = Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / Math.LN2 ** 2);
  if (bits > MAX_BITS) throw new Error(`Filter would need ${bits} bits, more than the Redis limit of ${MAX_BITS}`);
  const hashes = Math.max(1, Math.round((bits / expectedItems) * Math.LN2));
  return { bits, hashes };
}

// Double hashing: two numbers from one sha256, then h1 + i*h2 gives k positions.
export function bloomOffsets(item: string, bits: number, hashes: number): number[] {
  const digest = createHash('sha256').update(item).digest();
  const h1 = digest.readUInt32BE(0);
  const h2 = digest.readUInt32BE(4) | 1; // odd, so positions spread out
  return Array.from({ length: hashes }, (_, i) => (h1 + i * h2) % bits);
}

export function createBloomFilter(store: BitStore, options: BloomOptions, keySuffix = '') {
  const { bits, hashes } = bloomSizing(options.expectedItems, options.falsePositiveRate);
  // Size is part of the key: if you change the settings you get a fresh (empty) filter, never a wrong one.
  const key = `bloom:${options.name}:m${bits}k${hashes}${keySuffix}`;

  return {
    key,
    bits,
    hashes,

    async add(item: string): Promise<void> {
      await store.setBits(key, bloomOffsets(item, bits, hashes));
    },

    async addMany(items: string[]): Promise<void> {
      for (let i = 0; i < items.length; i += ADD_CHUNK) {
        const offsets = items.slice(i, i + ADD_CHUNK).flatMap((item) => bloomOffsets(item, bits, hashes));
        await store.setBits(key, offsets);
      }
    },

    // false = definitely never added. true = maybe added, check the real source.
    async mightContain(item: string): Promise<boolean> {
      const found = await store.getBits(key, bloomOffsets(item, bits, hashes));
      return found.every(Boolean);
    },
  };
}

export type BloomFilter = ReturnType<typeof createBloomFilter>;
