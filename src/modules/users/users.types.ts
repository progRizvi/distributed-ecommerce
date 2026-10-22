import type { users } from '../../db/schema/users.js';

export type UsersId = string;
export type User = typeof users.$inferSelect;
export type NewUser = Pick<typeof users.$inferInsert, 'email' | 'passwordHash' | 'role'>;
export type Role = User['role'];

// What the outside world may see. Never contains passwordHash.
export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}
