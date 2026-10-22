import { asc, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { isUniqueViolation } from '../../db/errors.js';
import { users } from '../../db/schema/users.js';
import { ConflictError } from '../../shared/errors/app-error.js';
import type { NewUser, User } from './users.types.js';

export interface UsersRepository {
  findByEmail(normalizedEmail: string): Promise<User | undefined>;
  findById(id: string): Promise<User | undefined>;
  create(input: NewUser): Promise<User>;
  /** Keyset pagination (stable and fast on a huge table). Used to rebuild the email Bloom filter. */
  listEmails(afterId: string | undefined, limit: number): Promise<{ id: string; email: string }[]>;
}

// Only this file talks to the users table.
export function createUsersRepository(db: Database): UsersRepository {
  return {
    async findByEmail(normalizedEmail) {
      // Matches the lower(email) unique index, so this is an index lookup.
      const [row] = await db.select().from(users).where(sql`lower(${users.email}) = ${normalizedEmail}`).limit(1);
      return row;
    },

    async findById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return row;
    },

    async listEmails(afterId, limit) {
      return db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(afterId ? gt(users.id, afterId) : undefined)
        .orderBy(asc(users.id))
        .limit(limit);
    },

    async create(input) {
      try {
        // No "does it exist?" query first: two parallel requests would both pass it.
        // The unique index decides, and we turn its error into a clean 409.
        const [row] = await db.insert(users).values(input).returning();
        if (!row) throw new Error('Insert returned no row');
        return row;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictError('Email already registered');
        throw error;
      }
    },
  };
}
