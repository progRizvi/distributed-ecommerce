import { hash, verify } from '@node-rs/bcrypt';

// Contract the auth service depends on. Swap bcrypt for argon2 later by writing another implementation.
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, passwordHash: string): Promise<boolean>;
}

// Adapter around @node-rs/bcrypt.
export function createBcryptHasher(cost = 12): PasswordHasher {
  return {
    // bcrypt only reads 72 bytes. Refuse longer passwords instead of silently cutting them.
    hash: (plain) => hash(plain, { cost, rejectLongPasswords: true }),
    verify: async (plain, passwordHash) => {
      try {
        return await verify(plain, passwordHash);
      } catch {
        return false;
      }
    },
  };
}
