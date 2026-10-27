import type { Mail } from '../shared/mail/mailer.js';

// STRATEGY: the contract for background jobs. The app only knows these interfaces,
// so BullMQ can be replaced (RabbitMQ, SQS...) by writing another class.

// Every job: its name and what data it carries. Add a line here to add a job type.
export interface JobPayloads {
  'send-mail': Mail;
}

export type JobName = keyof JobPayloads;

// What really travels in the queue. `outboxId` is set for jobs that come from the outbox table,
// so the worker can mark that row as sent when the job is done.
export type JobPayload<K extends JobName> = JobPayloads[K] & { outboxId?: string };

export interface EnqueueOptions {
  /**
   * Same id twice = one job. Use it so a repeated event does not send the same mail twice.
   * (No ":" in it, BullMQ does not allow that.)
   */
  jobId?: string;
  delayMs?: number;
}

export type BulkJob = {
  [K in JobName]: { name: K; payload: JobPayload<K> } & EnqueueOptions;
}[JobName];

// Producer side: put a job in the queue.
export interface JobQueue {
  /** Resolves when the job is safely stored. Rejects if the queue is not reachable. */
  enqueue<K extends JobName>(name: K, payload: JobPayload<K>, options?: EnqueueOptions): Promise<void>;
  /** Many jobs in ONE round trip to the queue. Same rules as enqueue (jobId dedupe). */
  enqueueBulk(jobs: BulkJob[]): Promise<void>;
  close(): Promise<void>;
}

// Consumer side (the worker process): what to do for each job.
export type JobHandler<K extends JobName> = (payload: JobPayload<K>) => Promise<void>;
export type JobHandlers = { [K in JobName]: JobHandler<K> };

export interface RunningWorker {
  /** Stops taking new jobs and waits for the running ones to finish. */
  close(): Promise<void>;
}

// Throw this from a handler when trying again cannot help (bad data). The job fails at once, no retries.
// Any other error = temporary problem = the job is retried later.
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentJobError';
  }
}

export interface FailedJobInfo {
  id: string | undefined;
  name: string;
  attemptsMade: number;
  maxAttempts: number;
  /** True when no more retries will happen. */
  final: boolean;
}

export interface WorkerHooks {
  onCompleted?: (job: { id: string | undefined; name: string }) => void;
  onFailed?: (job: FailedJobInfo, error: Error) => void;
  onError?: (error: Error) => void;
}
