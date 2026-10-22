import { db } from '../../client.js';
import { users } from '../../schema/users.js';
import { BcryptHasher } from '../../../modules/auth/password.js';
import { normalizeEmail } from '../../../modules/users/users.service.js';
import type { SeedOptions } from '../index.js';

// Creates one admin from SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD. Safe to run many times.
// The password comes from the environment, never from code.
export async function seedUsers(_options: SeedOptions): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('  skipped admin: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one');
    return;
  }
  if (password.length < 12) throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');

  const passwordHash = await new BcryptHasher(12).hash(password);
  const inserted = await db
    .insert(users)
    .values({ email: normalizeEmail(email), passwordHash, role: 'admin' })
    .onConflictDoNothing()
    .returning({ id: users.id });

  console.log(inserted.length > 0 ? '  admin created' : '  admin already exists, left unchanged');
}
