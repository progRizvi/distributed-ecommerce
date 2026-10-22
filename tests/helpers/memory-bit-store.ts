import type { BitStore } from '../../src/shared/bloom/bloom-filter.js';

// In-memory bit store that also counts calls (each call = one Redis round trip).
export function createMemoryBitStore(): BitStore & { calls: number; failNext(): void; keys(): string[] } {
  const bitsets = new Map<string, Set<number>>();
  let shouldFail = false;
  const store = {
    calls: 0,
    failNext() {
      shouldFail = true;
    },
    keys: () => [...bitsets.keys()],
    async setBits(key: string, offsets: number[]) {
      store.calls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('redis down');
      }
      const set = bitsets.get(key) ?? new Set<number>();
      for (const offset of offsets) set.add(offset);
      bitsets.set(key, set);
    },
    async getBits(key: string, offsets: number[]) {
      store.calls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('redis down');
      }
      const set = bitsets.get(key);
      return offsets.map((offset) => set?.has(offset) ?? false);
    },
  };
  return store;
}
