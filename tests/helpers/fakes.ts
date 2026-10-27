import { randomUUID } from 'node:crypto';
import { assertValidMail, MailError, type Mail, type Mailer } from '../../src/shared/mail/mailer.js';
import type { SmtpMessage, SmtpTransport } from '../../src/shared/mail/smtp-mailer.js';
import type { EnqueueOptions, JobHandlers, JobName, JobPayloads, JobQueue } from '../../src/jobs/queue.js';
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
  private readonly ids = new Set<string>();
  private shouldFail = false;

  failNext(): void {
    this.shouldFail = true;
  }

  async enqueue<K extends JobName>(name: K, payload: JobPayloads[K], options: EnqueueOptions = {}): Promise<void> {
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

  // Plays the worker: runs every stored job through its handler.
  async runAll(handlers: JobHandlers): Promise<void> {
    for (const job of this.jobs) await (handlers[job.name] as (payload: unknown) => Promise<void>)(job.payload);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
