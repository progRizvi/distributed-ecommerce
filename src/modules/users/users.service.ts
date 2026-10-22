import type { UsersRepository } from './users.repository.js';
import type { Role, User } from './users.types.js';

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

// A Bloom filter of registered emails. Only a shortcut: "maybe" must always be confirmed in the database.
export interface EmailFilter {
  add(email: string): Promise<void>;
  mightContain(email: string): Promise<boolean>;
}

export interface UsersServiceDeps {
  repo: UsersRepository;
  emailFilter?: EmailFilter;
  /** Called when the filter fails. The request still works (we fall back to the database). */
  onFilterError?: (error: unknown) => void;
}

// Other modules (auth, orders...) use this service, never the users table.
export function createUsersService({ repo, emailFilter, onFilterError = () => {} }: UsersServiceDeps) {
  return {
    findByEmail: (email: string): Promise<User | undefined> => repo.findByEmail(normalizeEmail(email)),
    findById: (id: string): Promise<User | undefined> => repo.findById(id),

    async create(input: { email: string; passwordHash: string; role?: Role }): Promise<User> {
      const user = await repo.create({
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        role: input.role ?? 'customer',
      });
      // Best effort. If this fails the user still exists; the filter just misses one email,
      // which is harmless here (see isEmailAvailable) and fixed by the next rebuild.
      try {
        await emailFilter?.add(user.email);
      } catch (error) {
        onFilterError(error);
      }
      return user;
    },

    async isEmailAvailable(email: string): Promise<boolean> {
      const normalized = normalizeEmail(email);
      if (emailFilter) {
        try {
          // "Definitely not registered" -> answer without touching the database.
          if (!(await emailFilter.mightContain(normalized))) return true;
        } catch (error) {
          onFilterError(error); // filter down: just ask the database
        }
      }
      // "Maybe registered" (or no filter): the database decides. It also fixes filter false positives.
      return (await repo.findByEmail(normalized)) === undefined;
    },
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
