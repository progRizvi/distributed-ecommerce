import { randomUUID } from 'node:crypto';
import { assertValidMail, MailError, type Mail, type Mailer } from '../../src/shared/mail/mailer.js';
import type { SmtpMessage, SmtpTransport } from '../../src/shared/mail/smtp-mailer.js';
import type { Transactor } from '../../src/db/transactor.js';
import type { ClaimOptions, NewOutboxEntry, OutboxRepository, OutboxRow } from '../../src/jobs/outbox.js';
import type { BulkJob, EnqueueOptions, JobHandlers, JobName, JobPayload, JobQueue } from '../../src/jobs/queue.js';
import { RedisTokenRevocations, type RevocationStore } from '../../src/modules/auth/revocations.js';
import type { AuthRepository } from '../../src/modules/auth/auth.repository.js';
import type { NewRefreshToken, RefreshTokenRecord } from '../../src/modules/auth/auth.types.js';
import type { PasswordHasher } from '../../src/modules/auth/password.js';
import type { LoginThrottle } from '../../src/modules/auth/throttle.js';
import type { UsersRepository } from '../../src/modules/users/users.repository.js';
import type { NewUser, User } from '../../src/modules/users/users.types.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';

export function createFakeUsersRepo(): UsersRepository & { rows: User[] } {
  const rows: User[] = [];
  return {
    rows,
    async findByEmail(email) {
      return rows.find((u) => u.email.toLowerCase() === email);
    },
    async findById(id) {
      return rows.find((u) => u.id === id);
    },
    async listEmails(afterId, limit) {
      return [...rows]
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((u) => !afterId || u.id > afterId)
        .slice(0, limit)
        .map((u) => ({ id: u.id, email: u.email }));
    },
    async create(input: NewUser) {
      // Same behaviour as the real unique index.
      if (rows.some((u) => u.email.toLowerCase() === input.email.toLowerCase())) {
        throw new ConflictError('Email already registered');
      }
      const user: User = {
        id: randomUUID(),
        email: input.email,
        passwordHash: input.passwordHash,
        role: input.role ?? 'customer',
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(user);
      return user;
    },
  };
}

export function createFakeAuthRepo(): AuthRepository & { rows: RefreshTokenRecord[] } {
  const rows: RefreshTokenRecord[] = [];
  const add = (input: NewRefreshToken): RefreshTokenRecord => {
    const row: RefreshTokenRecord = {
      id: randomUUID(),
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      revokedAt: null,
      userAgent: input.userAgent ?? null,
      ip: input.ip ?? null,
      createdAt: new Date(),
    };
    rows.push(row);
    return row;
  };
  return {
    rows,
    async create(input) {
      return add(input);
    },
    async findByHash(tokenHash) {
      return rows.find((r) => r.tokenHash === tokenHash);
    },
    async rotate(oldId, next) {
      const old = rows.find((r) => r.id === oldId);
      if (!old || old.revokedAt) return false;
      old.revokedAt = new Date();
      add(next);
      return true;
    },
    async revokeFamily(familyId) {
      for (const r of rows) if (r.familyId === familyId && !r.revokedAt) r.revokedAt = new Date();
    },
    async revokeAllForUser(userId) {
      for (const r of rows) if (r.userId === userId && !r.revokedAt) r.revokedAt = new Date();
    },
  };
}

// Fast and fake. Real bcrypt is tested separately.
export function createFakeHasher(): PasswordHasher & { verifyCalls: number } {
  const hasher = {
    verifyCalls: 0,
    async hash(plain: string) {
      return `hashed:${plain}`;
    },
    async verify(plain: string, hash: string) {
      hasher.verifyCalls += 1;
      return hash === `hashed:${plain}`;
    },
  };
  return hasher;
}

export function createFakeThrottle(maxFailures = 5): LoginThrottle & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  return {
    counts,
    async isBlocked(key) {
      return (counts.get(key) ?? 0) >= maxFailures;
    },
    async recordFailure(key) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    },
    async reset(key) {
      counts.set(key, 0);
    },
  };
}

// In-memory stand-in for Redis (SET ... EX and MGET). Ignores expiry, keeps the TTL so tests can check it.
export function createFakeRevocationStore(): RevocationStore & {
  data: Map<string, { value: string; ttl: number }>;
  calls: number;
  failNext(): void;
} {
  const data = new Map<string, { value: string; ttl: number }>();
  let shouldFail = false;
  const store = {
    data,
    calls: 0,
    failNext() {
      shouldFail = true;
    },
    async set(key: string, value: string, _mode: 'EX', seconds: number) {
      store.calls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('redis down');
      }
      data.set(key, { value, ttl: seconds });
    },
    async mget(...keys: string[]) {
      store.calls += 1;
      if (shouldFail) {
        shouldFail = false;
        throw new Error('redis down');
      }
      return keys.map((key) => data.get(key)?.value ?? null);
    },
  };
  return store;
}

// Real revocation logic on top of the fake store. `now` can be shifted to place "logout-all" after tokens
// that were issued in the same second (JWT iat has one-second precision).
export function createFakeRevocations(now: () => number = () => Date.now()) {
  const store = createFakeRevocationStore();
  return { store, revocations: new RedisTokenRevocations(store, now) };
}

// Test strategy for Mailer: keeps the mails in memory. Validates like the real ones do.
export class FakeMailer implements Mailer {
  readonly sent: Mail[] = [];
  private shouldFail = false;

  failNext(): void {
    this.shouldFail = true;
  }

  async send(mail: Mail): Promise<void> {
    assertValidMail(mail);
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new MailError('mail server down');
    }
    this.sent.push(mail);
  }
}

// Stand-in for the nodemailer transport (what SmtpMailer talks to).
export class FakeSmtpTransport implements SmtpTransport {
  readonly sent: SmtpMessage[] = [];
  closed = false;
  error: Error | undefined;

  async sendMail(message: SmtpMessage): Promise<unknown> {
    if (this.error) throw this.error;
    this.sent.push(message);
    return {};
  }

  close(): void {
    this.closed = true;
  }
}

// Test double for JobQueue: keeps jobs in memory. Same jobId = one job (like BullMQ).
export class InMemoryQueue implements JobQueue {
  readonly jobs: { name: JobName; payload: unknown; options: EnqueueOptions }[] = [];
  closed = false;
  bulkCalls = 0;
  private readonly ids = new Set<string>();
  private shouldFail = false;

  failNext(): void {
    this.shouldFail = true;
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayload<K>, options: EnqueueOptions = {}): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('queue down');
    }
    if (options.jobId !== undefined) {
      if (this.ids.has(options.jobId)) return;
      this.ids.add(options.jobId);
    }
    this.jobs.push({ name, payload, options });
  }

  async enqueueBulk(jobs: BulkJob[]): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      throw new Error('queue down');
    }
    this.bulkCalls += 1;
    for (const { name, payload, ...options } of jobs) await this.enqueue(name, payload, options);
  }

  // Plays the worker: runs every stored job through its handler.
  async runAll(handlers: JobHandlers): Promise<void> {
    for (const job of this.jobs) await (handlers[job.name] as (payload: unknown) => Promise<void>)(job.payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

// No real transaction: it just runs the work. Tests that need real rollback use Postgres (outbox.db.test.ts).
export function createFakeTransactor(): Transactor & { runs: number } {
  const transactor = {
    runs: 0,
    async run<T>(work: (tx: never) => Promise<T>): Promise<T> {
      transactor.runs += 1;
      return work(undefined as never);
    },
  };
  return transactor as Transactor & { runs: number };
}

// In-memory outbox table with the same rules as the real one (lease, max attempts, dedupe key).
export function createFakeOutbox(now: () => number = () => Date.now()): OutboxRepository & {
  rows: { id: string; name: JobName; payload: Record<string, unknown>; dedupeKey: string | null; status: 'pending' | 'sent'; attempts: number; enqueuedAt: number | null }[];
} {
  const rows: {
    id: string;
    name: JobName;
    payload: Record<string, unknown>;
    dedupeKey: string | null;
    status: 'pending' | 'sent';
    attempts: number;
    enqueuedAt: number | null;
  }[] = [];
  return {
    rows,
    async add(entry: NewOutboxEntry) {
      if (entry.dedupeKey !== undefined && rows.some((r) => r.dedupeKey === entry.dedupeKey)) return;
      rows.push({
        id: randomUUID(),
        name: entry.name,
        payload: { ...entry.payload },
        dedupeKey: entry.dedupeKey ?? null,
        status: 'pending',
        attempts: 0,
        enqueuedAt: null,
      });
    },
    async claim({ limit, leaseMs, maxAttempts }: ClaimOptions): Promise<OutboxRow[]> {
      const due = rows
        .filter((r) => r.status === 'pending' && r.attempts < maxAttempts && (r.enqueuedAt === null || r.enqueuedAt < now() - leaseMs))
        .slice(0, limit);
      for (const r of due) {
        r.enqueuedAt = now();
        r.attempts += 1;
      }
      return due.map((r) => ({ id: r.id, name: r.name, payload: r.payload, attempts: r.attempts }));
    },
    async release(ids) {
      for (const r of rows) {
        if (ids.includes(r.id) && r.status === 'pending') {
          r.enqueuedAt = null;
          r.attempts = Math.max(r.attempts - 1, 0);
        }
      }
    },
    async isPending(id) {
      return rows.find((r) => r.id === id)?.status === 'pending';
    },
    async markSent(id) {
      const row = rows.find((r) => r.id === id);
      if (row && row.status === 'pending') row.status = 'sent';
    },
  };
}
