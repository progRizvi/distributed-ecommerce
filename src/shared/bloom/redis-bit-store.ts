import type { BitStore } from './bloom-filter.js';

// The parts of ioredis we use.
export interface BitPipeline {
  setbit(key: string, offset: number, value: number): unknown;
  getbit(key: string, offset: number): unknown;
  exec(): Promise<[Error | null, unknown][] | null>;
}

export interface BitRedis {
  pipeline(): BitPipeline;
  rename(from: string, to: string): Promise<unknown>;
}

// One pipeline = one network round trip, however many bits (keeps to the "no chatty calls" rule).
export function createRedisBitStore(redis: BitRedis): BitStore & { rename(from: string, to: string): Promise<void> } {
  async function run(pipeline: BitPipeline): Promise<unknown[]> {
    const results = await pipeline.exec();
    if (!results) throw new Error('Redis pipeline returned nothing');
    return results.map(([error, value]) => {
      if (error) throw error;
      return value;
    });
  }

  return {
    async setBits(key, offsets) {
      const pipeline = redis.pipeline();
      for (const offset of offsets) pipeline.setbit(key, offset, 1);
      await run(pipeline);
    },

    async getBits(key, offsets) {
      const pipeline = redis.pipeline();
      for (const offset of offsets) pipeline.getbit(key, offset);
      return (await run(pipeline)).map((value) => value === 1);
    },

    async rename(from, to) {
      await redis.rename(from, to);
    },
  };
}
