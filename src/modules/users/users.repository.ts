import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import type { Tx } from '../../db/transactor.js';
import { users } from '../../db/schema/users.js';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { NewUser, User } from './users.types.js';

// The contract other code depends on. Tests use fakes of it.
export interface UsersRepository {
  findByEmail(normalizedEmail: string): Promise<User | undefined>;
  findById(id: string): Promise<User | undefined>;
  /** Pass `tx` to make the insert part of a bigger transaction. */
  create(input: NewUser, tx?: Tx): Promise<User>;
  /** Keyset pagination (stable and fast on a huge table). Used to rebuild the email Bloom filter. */
  listEmails(afterId: string | undefined, limit: number): Promise<{ id: string; email: string }[]>;
}

// Only this class talks to the users table.
export class DrizzleUsersRepository implements UsersRepository {
  constructor(private readonly db: Database) {}

  async findByEmail(normalizedEmail: string): Promise<User | undefined> {
    // Matches the lower(email) unique index, so this is an index lookup.
    const [row] = await this.db.select().from(users).where(sql`lower(${users.email}) = ${normalizedEmail}`).limit(1);
    return row;
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  async listEmails(afterId: string | undefined, limit: number): Promise<{ id: string; email: string }[]> {
    return this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(afterId ? gt(users.id, afterId) : undefined)
      .orderBy(asc(users.id))
      .limit(limit);
  }

  async create(input: NewUser, tx?: Tx): Promise<User> {
    try {
      // No "does it exist?" query first: two parallel requests would both pass it.
      // The unique index decides, and we turn its error into a clean 409.
      const [row] = await (tx ?? this.db).insert(users).values(input).returning();
      if (!row) throw new Error('Insert returned no row');
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('Email already registered');
      throw error;
    }
  }
}
