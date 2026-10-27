import { UnrecoverableError, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createRedisRetryStrategy } from '../shared/redis/retry-strategy.js';
import { QUEUE_NAME } from './bullmq-queue.js';
import { PermanentJobError, type JobHandlers, type JobName, type RunningWorker, type WorkerHooks } from './queue.js';

export interface BullMqWorkerOptions {
  queueName?: string;
  concurrency?: number;
}

// ADAPTER (consumer side): runs our handlers for jobs that BullMQ gives us.
export class BullMqWorker implements RunningWorker {
  private readonly connection: Redis;
  private readonly worker: Worker;

  constructor(redisUrl: string, handlers: JobHandlers, hooks: WorkerHooks = {}, options: BullMqWorkerOptions = {}) {
    // A worker waits for jobs with blocking commands, so BullMQ requires maxRetriesPerRequest: null.
    this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null, retryStrategy: createRedisRetryStrategy() });

    this.worker = new Worker(
      options.queueName ?? QUEUE_NAME,
      async (job) => {
        const handler = handlers[job.name as JobName] as ((payload: unknown) => Promise<void>) | undefined;
        if (!handler) throw new UnrecoverableError(`Unknown job type: ${job.name}`);
        try {
          await handler(job.data);
        } catch (error) {
          // "Trying again cannot help" -> tell BullMQ not to retry.
          if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message);
          throw error;
        }
      },
      { connection: this.connection, concurrency: options.concurrency ?? 5 },
    );

    this.worker.on('completed', (job) => hooks.onCompleted?.({ id: job.id, name: job.name }));
    this.worker.on('failed', (job, error) => {
      if (!job) return;
      const maxAttempts = job.opts.attempts ?? 1;
      const outboxId = (job.data as { outboxId?: unknown } | null)?.outboxId;
      hooks.onFailed?.(
        {
          id: job.id,
          name: job.name,
          attemptsMade: job.attemptsMade,
          maxAttempts,
          final: error instanceof UnrecoverableError || job.attemptsMade >= maxAttempts,
          ...(typeof outboxId === 'string' ? { outboxId } : {}),
        },
        error,
      );
    });
    const onError = hooks.onError ?? (() => {});
    this.worker.on('error', onError);
    this.connection.on('error', onError);
  }

  async close(): Promise<void> {
    await this.worker.close(); // waits for running jobs
    this.connection.disconnect();
  }
}
