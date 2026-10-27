import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisRetryStrategy } from '../shared/redis/retry-strategy.js';
import type { BulkJob, EnqueueOptions, JobName, JobPayload, JobQueue } from './queue.js';

export const QUEUE_NAME = 'ecommerce-jobs';

// Retry plan for a failed job: 5s, 10s, 20s, 40s ... (x2 each time, plus up to 50% random jitter),
// 8 tries in total = about 10 minutes of mail server trouble survived.
export const DEFAULT_ATTEMPTS = 8;
export const DEFAULT_BACKOFF_MS = 5_000;
export const BACKOFF_JITTER = 0.5;

export interface BullMqQueueOptions {
  queueName?: string;
  attempts?: number;
  backoffMs?: number;
  /** enqueue() gives up after this long, so a Redis outage cannot hang the caller. */
  enqueueTimeoutMs?: number;
  onError?: (error: Error) => void;
}

// ADAPTER: translates our JobQueue contract into the BullMQ API.
export class BullMqQueue implements JobQueue {
  private readonly connection: Redis;
  private readonly queue: Queue;
  private readonly enqueueTimeoutMs: number;

  constructor(redisUrl: string, options: BullMqQueueOptions = {}) {
    this.enqueueTimeoutMs = options.enqueueTimeoutMs ?? 3_000;
    this.connection = new Redis(redisUrl, {
      // Fail at once when Redis is down (BullMQ advice for producers), instead of piling up commands.
      enableOfflineQueue: false,
      retryStrategy: createRedisRetryStrategy(),
    });
    this.queue = new Queue(options.queueName ?? QUEUE_NAME, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: options.attempts ?? DEFAULT_ATTEMPTS,
        backoff: { type: 'exponential', delay: options.backoffMs ?? DEFAULT_BACKOFF_MS, jitter: BACKOFF_JITTER },
        // Keep finished jobs a short time, failed ones longer so someone can look at them.
        // The payload (an email address) lives in Redis for that time.
        removeOnComplete: { age: 60 * 60, count: 1_000 },
        removeOnFail: { age: 3 * 24 * 60 * 60 },
      },
    });
    const onError = options.onError ?? (() => {});
    this.queue.on('error', onError);
    this.connection.on('error', onError);
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayload<K>, options: EnqueueOptions = {}): Promise<void> {
    await this.withTimeout(this.queue.add(name, payload, toJobOptions(options)));
  }

  async enqueueBulk(jobs: BulkJob[]): Promise<void> {
    if (jobs.length === 0) return;
    // One round trip for all of them, not one per job.
    await this.withTimeout(
      this.queue.addBulk(jobs.map((job) => ({ name: job.name, data: job.payload, opts: toJobOptions(job) }))),
    );
  }

  // Give up after enqueueTimeoutMs, so a Redis outage cannot hang the caller.
  private async withTimeout(work: Promise<unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Job queue is not reachable')), this.enqueueTimeoutMs);
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      work.catch(() => {}); // if the timeout won, do not leave an unhandled rejection behind
    }
  }

  async close(): Promise<void> {
    await this.queue.close().catch(() => {});
    this.connection.disconnect();
  }
}

function toJobOptions(options: EnqueueOptions): { jobId?: string; delay?: number } {
  return {
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
  };
}
