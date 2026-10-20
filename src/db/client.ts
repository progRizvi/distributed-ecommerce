import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../bootstrap/env.js';
import * as schema from './schema/index.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
export const db = drizzle(pool, { schema });
