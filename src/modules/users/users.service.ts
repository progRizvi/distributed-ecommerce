import type { Tx } from '../../db/transactor.js';
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
export class UsersService {
  private readonly repo: UsersRepository;
  private readonly emailFilter: EmailFilter | undefined;
  private readonly onFilterError: (error: unknown) => void;

  constructor({ repo, emailFilter, onFilterError = () => {} }: UsersServiceDeps) {
    this.repo = repo;
    this.emailFilter = emailFilter;
    this.onFilterError = onFilterError;
  }

  findByEmail(email: string): Promise<User | undefined> {
    return this.repo.findByEmail(normalizeEmail(email));
  }

  findById(id: string): Promise<User | undefined> {
    return this.repo.findById(id);
  }

  async create(input: { email: string; passwordHash: string; role?: Role }, tx?: Tx): Promise<User> {
    const user = await this.repo.create(
      {
        email: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        role: input.role ?? 'customer',
      },
      tx,
    );
    // Best effort. If this fails the user still exists; the filter just misses one email,
    // which is harmless here (see isEmailAvailable) and fixed by the next rebuild.
    // (Inside a transaction that later rolls back, the filter keeps the email: also harmless, it only
    // means "maybe registered", and the database answers.)
    try {
      await this.emailFilter?.add(user.email);
    } catch (error) {
      this.onFilterError(error);
    }
    return user;
  }

  async isEmailAvailable(email: string): Promise<boolean> {
    const normalized = normalizeEmail(email);
    if (this.emailFilter) {
      try {
        // "Definitely not registered" -> answer without touching the database.
        if (!(await this.emailFilter.mightContain(normalized))) return true;
      } catch (error) {
        this.onFilterError(error); // filter down: just ask the database
      }
    }
    // "Maybe registered" (or no filter): the database decides. It also fixes filter false positives.
    return (await this.repo.findByEmail(normalized)) === undefined;
  }
}
