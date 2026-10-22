import type { UsersRepository } from './users.repository.js';
import type { Role, User } from './users.types.js';

export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

export interface UsersServiceDeps {
  repo: UsersRepository;
}

// Other modules (auth, orders...) use this service, never the users table.
export function createUsersService({ repo }: UsersServiceDeps) {
  return {
    findByEmail: (email: string): Promise<User | undefined> => repo.findByEmail(normalizeEmail(email)),
    findById: (id: string): Promise<User | undefined> => repo.findById(id),
    create: (input: { email: string; passwordHash: string; role?: Role }): Promise<User> =>
      repo.create({ email: normalizeEmail(input.email), passwordHash: input.passwordHash, role: input.role ?? 'customer' }),
  };
}

export type UsersService = ReturnType<typeof createUsersService>;
