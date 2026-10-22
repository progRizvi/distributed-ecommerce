import { describe, expect, it } from 'vitest';
import { registerAuthListeners } from '../../src/modules/auth/auth.listeners.js';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { TokenService } from '../../src/modules/auth/tokens.js';
import { UsersService } from '../../src/modules/users/users.service.js';
import { InMemoryEventBus } from '../../src/shared/events/event-bus.js';
import {
  createFakeAuthRepo,
  createFakeHasher,
  createFakeRevocations,
  createFakeThrottle,
  createFakeUsersRepo,
  FakeMailer,
} from '../helpers/fakes.js';

function setup() {
  const errors: unknown[] = [];
  const events = new InMemoryEventBus((e) => errors.push(e));
  const mailer = new FakeMailer();
  registerAuthListeners(events, mailer);
  const service = new AuthService({
    users: new UsersService({ repo: createFakeUsersRepo() }),
    repo: createFakeAuthRepo(),
    hasher: createFakeHasher(),
    tokens: new TokenService({ signAccess: (p) => p.sub, accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
    throttle: createFakeThrottle(),
    revocations: createFakeRevocations().revocations,
    events,
  });
  return { service, mailer, errors };
}

const ctx = { ip: '203.0.113.9' };
const tick = () => new Promise((r) => setImmediate(r));

describe('welcome mail on registration', () => {
  it('sends one welcome mail to the normalized email', async () => {
    const { service, mailer } = setup();
    await service.register({ email: '  Bob@X.COM ', password: 'password123' }, ctx);
    await tick();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.to).toBe('bob@x.com');
    expect(mailer.sent[0]?.subject).toMatch(/welcome/i);
  });

  it('sends nothing when registration fails (duplicate email)', async () => {
    const { service, mailer } = setup();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();
    await service.register({ email: 'a@x.com', password: 'password123' }, ctx).catch(() => {});
    await tick();
    expect(mailer.sent).toHaveLength(1);
  });

  it('if the mail server is down, registration still succeeds and the error is reported', async () => {
    const { service, mailer, errors } = setup();
    mailer.failNext();
    const session = await service.register({ email: 'a@x.com', password: 'password123' }, ctx);
    await tick();
    expect(session.user.email).toBe('a@x.com');
    expect(mailer.sent).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });
});
