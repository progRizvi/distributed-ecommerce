import { hash, verify } from '@node-rs/bcrypt';

// Contract the auth service depends on. Swap bcrypt for argon2 later by writing another class.
export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(plain: string, passwordHash: string): Promise<boolean>;
}

// Adapter around @node-rs/bcrypt.
export class BcryptHasher implements PasswordHasher {
  constructor(private readonly cost = 12) {}

  // bcrypt only reads 72 bytes. Refuse longer passwords instead of silently cutting them.
  hash(plain: string): Promise<string> {
    return hash(plain, { cost: this.cost, rejectLongPasswords: true });
  }

  async verify(plain: string, passwordHash: string): Promise<boolean> {
    try {
      return await verify(plain, passwordHash);
    } catch {
      return false;
    }
  }
}
