import type { FastifyInstance } from 'fastify';
import { pool } from '../db/client.js';

export async function setupDatabase(app: FastifyInstance): Promise<void> {
  await pool.query('select 1');
  app.addHook('onClose', async () => {
    await pool.end();
  });
}
