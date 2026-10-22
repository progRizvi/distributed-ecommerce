import { describe, expect, it } from 'vitest';
import { bloomOffsets, bloomSizing, createBloomFilter } from '../../src/shared/bloom/bloom-filter.js';
import { createRedisBitStore, type BitPipeline } from '../../src/shared/bloom/redis-bit-store.js';
import { createMemoryBitStore } from '../helpers/memory-bit-store.js';

describe('bloomSizing', () => {
  it('10M items at 1% needs about 12 MB and 7 hashes', () => {
    const { bits, hashes } = bloomSizing(10_000_000, 0.01);
    expect(hashes).toBe(7);
    expect(bits / 8 / 1024 / 1024).toBeGreaterThan(11);
    expect(bits / 8 / 1024 / 1024).toBeLessThan(12.5);
  });

  it('rejects bad settings and sizes above the Redis limit', () => {
    expect(() => bloomSizing(0, 0.01)).toThrow();
    expect(() => bloomSizing(1000, 0)).toThrow();
    expect(() => bloomSizing(1000, 1)).toThrow();
    expect(() => bloomSizing(1_000_000_000, 0.01)).toThrow(/Redis limit/);
  });
});

describe('bloomOffsets', () => {
  it('is deterministic, in range, and gives k positions', () => {
    const a = bloomOffsets('a@x.com', 1000, 7);
    expect(a).toEqual(bloomOffsets('a@x.com', 1000, 7));
    expect(a).toHaveLength(7);
    expect(a.every((o) => Number.isInteger(o) && o >= 0 && o < 1000)).toBe(true);
    expect(bloomOffsets('b@x.com', 1000, 7)).not.toEqual(a);
  });
});

describe('bloom filter', () => {
  const options = { name: 'test', expectedItems: 5000, falsePositiveRate: 0.01 };

  it('an empty filter says "definitely not" for everything', async () => {
    const filter = createBloomFilter(createMemoryBitStore(), options);
    expect(await filter.mightContain('a@x.com')).toBe(false);
  });

  it('never forgets an added item (no false negatives)', async () => {
    const filter = createBloomFilter(createMemoryBitStore(), options);
    const items = Array.from({ length: 5000 }, (_, i) => `user${i}@example.com`);
    await filter.addMany(items);
    const missing: string[] = [];
    for (const item of items) if (!(await filter.mightContain(item))) missing.push(item);
    expect(missing).toEqual([]);
  });

  it('false positive rate stays near the target', async () => {
    const filter = createBloomFilter(createMemoryBitStore(), options);
    await filter.addMany(Array.from({ length: 5000 }, (_, i) => `user${i}@example.com`));
    let falsePositives = 0;
    const trials = 10_000;
    for (let i = 0; i < trials; i += 1) if (await filter.mightContain(`stranger${i}@other.com`)) falsePositives += 1;
    // Target is 1%. Allow up to 2% so the test is not fragile.
    expect(falsePositives / trials).toBeLessThan(0.02);
  });

  it('uses one store call per add / per check, and one per 1000 items in addMany', async () => {
    const store = createMemoryBitStore();
    const filter = createBloomFilter(store, options);
    await filter.add('a@x.com');
    await filter.mightContain('a@x.com');
    expect(store.calls).toBe(2);

    store.calls = 0;
    await filter.addMany(Array.from({ length: 2500 }, (_, i) => `u${i}@x.com`));
    expect(store.calls).toBe(3);
  });

  it('puts the settings in the key, so changed settings never reuse an old filter', () => {
    const store = createMemoryBitStore();
    const a = createBloomFilter(store, options);
    const b = createBloomFilter(store, { ...options, expectedItems: 9000 });
    expect(a.key).not.toBe(b.key);
    expect(createBloomFilter(store, options, ':building').key).toBe(`${a.key}:building`);
  });
});

describe('redis bit store', () => {
  function fakePipeline(responder: (command: string, offset: number) => unknown) {
    const commands: [string, string, number][] = [];
    let created = 0;
    // A new pipeline for every call, like ioredis.
    const create = (): BitPipeline => {
      created += 1;
      const queued: [string, number][] = [];
      const pipeline: BitPipeline = {
        setbit(key, offset) {
          commands.push(['setbit', key, offset]);
          queued.push(['setbit', offset]);
          return pipeline;
        },
        getbit(key, offset) {
          commands.push(['getbit', key, offset]);
          queued.push(['getbit', offset]);
          return pipeline;
        },
        async exec() {
          return queued.map(([command, offset]) => [null, responder(command, offset)] as [Error | null, unknown]);
        },
      };
      return pipeline;
    };
    return { create, commands, pipelinesCreated: () => created };
  }

  it('sends all bits in one pipeline and reads the answers back', async () => {
    const { create, commands, pipelinesCreated } = fakePipeline((command, offset) => (command === 'getbit' ? (offset % 2 === 0 ? 1 : 0) : 1));
    const store = createRedisBitStore({ pipeline: create, rename: async () => {} });

    await store.setBits('k', [1, 2, 3]);
    expect(commands).toEqual([
      ['setbit', 'k', 1],
      ['setbit', 'k', 2],
      ['setbit', 'k', 3],
    ]);
    expect(pipelinesCreated()).toBe(1);

    expect(await store.getBits('k', [2, 3])).toEqual([true, false]);
    expect(pipelinesCreated()).toBe(2);
  });

  it('throws when Redis reports an error for a command', async () => {
    const store = createRedisBitStore({
      pipeline: () => ({
        setbit() {
          return this;
        },
        getbit() {
          return this;
        },
        exec: async () => [[new Error('READONLY'), null]] as [Error | null, unknown][],
      }),
      rename: async () => {},
    });
    await expect(store.setBits('k', [1])).rejects.toThrow('READONLY');
  });
});
