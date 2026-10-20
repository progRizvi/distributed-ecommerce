import { runSeeders } from './index.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Seeding is disabled in production.');
  process.exit(1);
}

const only = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const count = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 0) || undefined;

await runSeeders({ only, count });
process.exit(0);
