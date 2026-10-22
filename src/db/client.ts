import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../bootstrap/env.js';
import * as schema from './schema/index.js';

export const pool = new Pool({ connectionString: env.DATABASE_URL, max: 10 });
export const db = drizzle(pool, { schema });

// Repositories receive this type (not the client itself), so tests can pass their own connection.
export type Database = typeof db;
