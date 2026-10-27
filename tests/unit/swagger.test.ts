import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeAuthRepo, createFakeHasher, createFakeOutbox, createFakeTransactor, createFakeRevocations, createFakeThrottle, createFakeUsersRepo } from '../helpers/fakes.js';
import { stubTestEnv } from '../helpers/env.js';

afterEach(() => vi.unstubAllEnvs());

describe('OpenAPI document', () => {
  it('is generated from the Zod schemas without errors', async () => {
    stubTestEnv();
    const { setupAuth } = await import('../../src/bootstrap/auth.js');
    const { setupCookie } = await import('../../src/bootstrap/cookie.js');
    const { setupSwagger } = await import('../../src/bootstrap/swagger.js');
    const { AuthController } = await import('../../src/modules/auth/auth.controller.js');
    const { createAuthRoutes } = await import('../../src/modules/auth/auth.routes.js');
    const { AuthService } = await import('../../src/modules/auth/auth.service.js');
    const { TokenService } = await import('../../src/modules/auth/tokens.js');
    const { UsersService } = await import('../../src/modules/users/users.service.js');
    const { InMemoryEventBus } = await import('../../src/shared/events/event-bus.js');

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await setupCookie(app);
    const { revocations } = createFakeRevocations();
    await setupAuth(app, revocations);
    await setupSwagger(app);
    const service = new AuthService({
      users: new UsersService({ repo: createFakeUsersRepo() }),
      repo: createFakeAuthRepo(),
      hasher: createFakeHasher(),
      tokens: new TokenService({ signAccess: (p) => app.jwt.sign(p), accessTtlSeconds: 900, refreshTtlSeconds: 3600 }),
      throttle: createFakeThrottle(),
      revocations,
      events: new InMemoryEventBus(),
      transactor: createFakeTransactor(),
      outbox: createFakeOutbox(),
    });
    await app.register(createAuthRoutes(new AuthController({ service, secureCookies: false })), { prefix: '/api/auth' });
    await app.ready();

    const res = await app.inject('/docs/json');
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/auth/register',
        '/api/auth/login',
        '/api/auth/refresh',
        '/api/auth/logout',
        '/api/auth/logout-all',
        '/api/auth/me',
      ]),
    );
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe('bearer');
    expect(doc.paths['/api/auth/me'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/auth/register'].post.requestBody.content['application/json'].schema.properties.email).toBeDefined();
    expect((await app.inject('/docs')).statusCode).toBeLessThan(400);
  });
});
