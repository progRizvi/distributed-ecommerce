// Rebuilds the email Bloom filter from the users table.
// Run after: first deploy, changing BLOOM_* settings, or if Redis lost its data.
//   pnpm bloom:rebuild
//
// It builds a new filter next to the live one, then swaps it in, so the live filter is never half-empty.
// Reads users in pages (keyset), so memory stays small even with a billion rows.
import { redis } from '../src/bootstrap/cache.js';
import { env } from '../src/bootstrap/env.js';
import { db, pool } from '../src/db/client.js';
import { createUsersRepository } from '../src/modules/users/users.repository.js';
import { createBloomFilter, createRedisBitStore } from '../src/shared/bloom/index.js';

const PAGE_SIZE = 5000;
const options = { name: 'email', expectedItems: env.BLOOM_EXPECTED_ITEMS, falsePositiveRate: env.BLOOM_FALSE_POSITIVE_RATE };

await redis.connect();
const store = createRedisBitStore(redis);
const live = createBloomFilter(store, options);
const building = createBloomFilter(store, options, ':building');
const repo = createUsersRepository(db);

console.log(`rebuilding ${live.key} (${live.bits} bits, ${live.hashes} hashes)`);

let total = 0;
let cursor: string | undefined;
for (;;) {
  const page = await repo.listEmails(cursor, PAGE_SIZE);
  if (page.length === 0) break;
  await building.addMany(page.map((row) => row.email.toLowerCase()));
  total += page.length;
  cursor = page[page.length - 1]?.id;
  if (total % (PAGE_SIZE * 20) === 0) console.log(`  ${total} emails`);
}

if (total > 0) await store.rename(building.key, live.key);
console.log(total > 0 ? `done: ${total} emails in the filter` : 'no users yet, nothing to build');

await redis.quit();
await pool.end();
