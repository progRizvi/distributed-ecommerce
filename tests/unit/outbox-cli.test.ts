import { describe, expect, it } from 'vitest';
import { DEAD_RETENTION_DAYS, MAX_REPLAYS, runOutboxCli } from '../../src/jobs/outbox-cli.js';
import type { DeadRow, OutboxAdmin, ReplayTarget } from '../../src/jobs/outbox.js';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const deadRow = (extra: Partial<DeadRow> = {}): DeadRow => ({
  id: ID,
  name: 'send-mail',
  attempts: 8,
  replays: 1,
  lastError: '550 <email> rejected',
  failedAt: new Date('2026-01-02T03:04:05.000Z'),
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...extra,
});

function fakeAdmin(options: { dead?: DeadRow[]; replayable?: number; old?: number } = {}) {
  const calls: string[] = [];
  const admin: OutboxAdmin = {
    async listDead(limit) {
      calls.push(`list:${limit}`);
      return options.dead ?? [];
    },
    async countReplayable(target: ReplayTarget, max) {
      calls.push(`countReplayable:${target === 'all' ? 'all' : target.id}:${max}`);
      return options.replayable ?? 0;
    },
    async replay(target: ReplayTarget, max) {
      calls.push(`replay:${target === 'all' ? 'all' : target.id}:${max}`);
      return options.replayable ?? 0;
    },
    async countDeadOlderThan(days) {
      calls.push(`countOld:${days}`);
      return options.old ?? 0;
    },
    async deleteDeadOlderThan(days) {
      calls.push(`delete:${days}`);
      return options.old ?? 0;
    },
  };
  return { admin, calls };
}

async function run(argv: string[], admin: OutboxAdmin) {
  const lines: string[] = [];
  const code = await runOutboxCli(argv, admin, (line) => lines.push(line));
  return { code, text: lines.join('\n') };
}

describe('outbox:dead', () => {
  it('says so when there is nothing', async () => {
    const { admin } = fakeAdmin();
    expect(await run(['dead'], admin)).toEqual({ code: 0, text: 'No dead jobs.' });
  });

  it('lists id, job, tries, replays, time and error, and hints at old rows', async () => {
    const { admin } = fakeAdmin({ dead: [deadRow()], old: 2 });
    const { code, text } = await run(['dead', '--limit', '10'], admin);
    expect(code).toBe(0);
    expect(text).toContain(ID);
    expect(text).toContain('tries=8');
    expect(text).toContain(`replays=1/${MAX_REPLAYS}`);
    expect(text).toContain('2026-01-02T03:04:05.000Z');
    expect(text).toContain('550 <email> rejected');
    expect(text).toContain(`2 are older than ${DEAD_RETENTION_DAYS} days`);
  });

  it('rejects a bad --limit', async () => {
    const { admin, calls } = fakeAdmin();
    expect((await run(['dead', '--limit', '0'], admin)).code).toBe(1);
    expect((await run(['dead', '--limit', 'abc'], admin)).code).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('outbox:replay', () => {
  it('without --yes it only shows what it would do', async () => {
    const { admin, calls } = fakeAdmin({ replayable: 3 });
    const { code, text } = await run(['replay', '--all'], admin);
    expect(code).toBe(0);
    expect(text).toContain('Would put 3 dead job(s) back');
    expect(calls.some((c) => c.startsWith('replay:'))).toBe(false);
  });

  it('with --yes it replays', async () => {
    const { admin, calls } = fakeAdmin({ replayable: 3 });
    const { text } = await run(['replay', '--all', '--yes'], admin);
    expect(text).toContain('3 job(s) are pending again');
    expect(calls).toContain(`replay:all:${MAX_REPLAYS}`);
  });

  it('can replay one job by id', async () => {
    const { admin, calls } = fakeAdmin({ replayable: 1 });
    await run(['replay', '--id', ID, '--yes'], admin);
    expect(calls).toContain(`replay:${ID}:${MAX_REPLAYS}`);
  });

  it('says why when nothing can be replayed', async () => {
    const { admin, calls } = fakeAdmin({ replayable: 0 });
    const { code, text } = await run(['replay', '--all', '--yes'], admin);
    expect(code).toBe(0);
    expect(text).toContain('Nothing to replay');
    expect(calls.some((c) => c.startsWith('replay:'))).toBe(false);
  });

  it.each([
    [['replay']],
    [['replay', '--all', '--id', ID]],
    [['replay', '--id', 'not-an-id']],
    [['replay', '--id']],
    [['replay', '--everything']],
  ])('refuses wrong arguments: %j', async (argv) => {
    const { admin, calls } = fakeAdmin({ replayable: 5 });
    const { code, text } = await run(argv, admin);
    expect(code).toBe(1);
    expect(text).toContain('Usage:');
    expect(calls).toEqual([]);
  });
});

describe('outbox:purge-dead', () => {
  it('without --yes it deletes nothing, and uses 7 days by default', async () => {
    const { admin, calls } = fakeAdmin({ old: 4 });
    const { text } = await run(['purge-dead'], admin);
    expect(text).toContain(`Would delete 4 dead row(s) older than ${DEAD_RETENTION_DAYS} days`);
    expect(calls).toEqual([`countOld:${DEAD_RETENTION_DAYS}`]);
  });

  it('with --yes it deletes', async () => {
    const { admin, calls } = fakeAdmin({ old: 4 });
    const { text } = await run(['purge-dead', '--days', '14', '--yes'], admin);
    expect(text).toContain('Deleted 4 dead row(s) older than 14 days');
    expect(calls).toContain('delete:14');
  });

  it('does nothing when there is nothing old', async () => {
    const { admin, calls } = fakeAdmin({ old: 0 });
    const { text } = await run(['purge-dead', '--yes'], admin);
    expect(text).toContain('No dead rows older than');
    expect(calls.some((c) => c.startsWith('delete:'))).toBe(false);
  });

  it('refuses a bad --days', async () => {
    const { admin, calls } = fakeAdmin({ old: 4 });
    expect((await run(['purge-dead', '--days', '0', '--yes'], admin)).code).toBe(1);
    expect((await run(['purge-dead', '--days', '-3', '--yes'], admin)).code).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('usage', () => {
  it('unknown or missing command shows the usage and fails', async () => {
    const { admin } = fakeAdmin();
    for (const argv of [[], ['nope']]) {
      const { code, text } = await run(argv, admin);
      expect(code).toBe(1);
      expect(text).toContain('Usage:');
    }
  });
});
