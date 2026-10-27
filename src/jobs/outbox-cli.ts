import type { OutboxAdmin, ReplayTarget } from './outbox.js';

// The commands behind `pnpm outbox:dead`, `pnpm outbox:replay` and `pnpm outbox:purge-dead`.
// They only talk to OutboxAdmin, so tests can run them on a test database.

/** Dead rows are kept this long, then `purge-dead` may remove them. */
export const DEAD_RETENTION_DAYS = 7;
/** A dead row can be put back this many times. A job that keeps dying needs a fix, not another replay. */
export const MAX_REPLAYS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const USAGE = [
  'Usage:',
  '  pnpm outbox:dead [--limit 50]                 list jobs that gave up (no email addresses shown)',
  '  pnpm outbox:replay --id <id> | --all [--yes]  put dead jobs back in the queue',
  `  pnpm outbox:purge-dead [--days ${DEAD_RETENTION_DAYS}] [--yes]      delete dead rows older than N days`,
  '',
  'replay and purge-dead only show what they WOULD do, until you add --yes.',
];

interface Flags {
  values: Map<string, string>;
  switches: Set<string>;
}

// Flags that take a value, and flags that do not. Anything else is a mistake worth stopping for.
function parseFlags(args: string[], withValue: string[], switches: string[]): Flags | string {
  const parsed: Flags = { values: new Map(), switches: new Set() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? '';
    if (withValue.includes(arg)) {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} needs a value`;
      parsed.values.set(arg, value);
      i += 1;
    } else if (switches.includes(arg)) {
      parsed.switches.add(arg);
    } else {
      return `Unknown argument: ${arg}`;
    }
  }
  return parsed;
}

function positiveInt(text: string | undefined, fallback: number, name: string): number | string {
  if (text === undefined) return fallback;
  return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : `${name} must be a whole number of 1 or more`;
}

/** Returns the exit code (0 = fine). */
export async function runOutboxCli(argv: string[], admin: OutboxAdmin, out: (line: string) => void): Promise<number> {
  const [command, ...args] = argv;
  const fail = (message: string): number => {
    out(`Error: ${message}`);
    out('');
    for (const line of USAGE) out(line);
    return 1;
  };

  if (command === 'dead') {
    const flags = parseFlags(args, ['--limit'], []);
    if (typeof flags === 'string') return fail(flags);
    const limit = positiveInt(flags.values.get('--limit'), 50, '--limit');
    if (typeof limit === 'string') return fail(limit);

    const rows = await admin.listDead(limit);
    if (rows.length === 0) {
      out('No dead jobs.');
      return 0;
    }
    for (const row of rows) {
      out(
        [
          row.id,
          row.name,
          `tries=${row.attempts}`,
          `replays=${row.replays}/${MAX_REPLAYS}`,
          `failed=${row.failedAt?.toISOString() ?? '?'}`,
          row.lastError ?? '(no error saved)',
        ].join('  '),
      );
    }
    out('');
    out(`${rows.length} dead job(s) shown.`);
    const old = await admin.countDeadOlderThan(DEAD_RETENTION_DAYS);
    if (old > 0) out(`${old} are older than ${DEAD_RETENTION_DAYS} days: pnpm outbox:purge-dead`);
    return 0;
  }

  if (command === 'replay') {
    const flags = parseFlags(args, ['--id'], ['--all', '--yes']);
    if (typeof flags === 'string') return fail(flags);
    const id = flags.values.get('--id');
    const all = flags.switches.has('--all');
    if (all === (id !== undefined)) return fail('Use either --id <id> or --all');
    if (id !== undefined && !UUID.test(id)) return fail('--id must be a job id from `pnpm outbox:dead`');

    const target: ReplayTarget = id !== undefined ? { id } : 'all';
    const count = await admin.countReplayable(target, MAX_REPLAYS);
    if (count === 0) {
      out(`Nothing to replay (rows replayed ${MAX_REPLAYS} times already are skipped: fix the cause first).`);
      return 0;
    }
    if (!flags.switches.has('--yes')) {
      out(`Would put ${count} dead job(s) back in the queue. Run again with --yes to do it.`);
      return 0;
    }
    const done = await admin.replay(target, MAX_REPLAYS);
    out(`${done} job(s) are pending again. The worker delivers them within a few seconds.`);
    return 0;
  }

  if (command === 'purge-dead') {
    const flags = parseFlags(args, ['--days'], ['--yes']);
    if (typeof flags === 'string') return fail(flags);
    const days = positiveInt(flags.values.get('--days'), DEAD_RETENTION_DAYS, '--days');
    if (typeof days === 'string') return fail(days);

    const count = await admin.countDeadOlderThan(days);
    if (count === 0) {
      out(`No dead rows older than ${days} days.`);
      return 0;
    }
    if (!flags.switches.has('--yes')) {
      out(`Would delete ${count} dead row(s) older than ${days} days. Run again with --yes to do it.`);
      return 0;
    }
    out(`Deleted ${await admin.deleteDeadOlderThan(days)} dead row(s) older than ${days} days.`);
    return 0;
  }

  return fail(command === undefined ? 'Missing command' : `Unknown command: ${command}`);
}
