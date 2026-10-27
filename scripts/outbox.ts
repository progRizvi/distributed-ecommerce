// Look at, replay and clean up dead jobs (the dead letter queue in the outbox table).
//   pnpm outbox:dead
//   pnpm outbox:replay --id <id>          (shows what it would do; add --yes to do it)
//   pnpm outbox:purge-dead                (shows what it would do; add --yes to do it)
import { db, pool } from '../src/db/client.js';
import { runOutboxCli } from '../src/jobs/outbox-cli.js';
import { DrizzleOutboxRepository } from '../src/jobs/outbox.js';

try {
  process.exitCode = await runOutboxCli(process.argv.slice(2), new DrizzleOutboxRepository(db), console.log);
} finally {
  await pool.end();
}
