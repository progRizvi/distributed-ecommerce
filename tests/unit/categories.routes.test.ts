import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubTestEnv } from '../helpers/env.js';
import { createFakeCategoriesRepo } from '../helpers/fake-categories.js';
import { createFakeRevocations } from '../helpers/fakes.js';

// Real bootstrap pieces (jwt, error handler, zod) + real routes/controller/service + fake database.
async function buildApp() {
  stubTestEnv();
  const { setupAuth } = await import('../../src/bootstrap/auth.js');
  const { setupErrorHandler } = await import('../../src/bootstrap/error-handler.js');
  const { setupSwagger } = await import('../../src/bootstrap/swagger.js');
  const { CategoriesController } = await import('../../src/modules/categories/categories.controller.js');
  const { createCategoriesRoutes } = await import('../../src/modules/categories/categories.routes.js');
  const { CategoriesService } = await import('../../src/modules/categories/categories.service.js');

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const { revocations } = createFakeRevocations();
  await setupAuth(app, revocations);
  await setupSwagger(app);
  setupErrorHandler(app);

  const repo = createFakeCategoriesRepo();
  await app.register(createCategoriesRoutes(new CategoriesController(new CategoriesService(repo))), { prefix: '/api/categories' });
  await app.ready();

  const token = (role: 'admin' | 'customer') => `Bearer ${app.jwt.sign({ sub: '0f8fad5b-d9cb-469f-a165-70867728950e', role, sid: 'session-1' })}`;
  const as = (role: 'admin' | 'customer') => ({ authorization: token(role) });
  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: 'POST', url: '/api/categories', headers: as('admin'), payload: body });
    return { res, category: res.json().category as { id: string; slug: string } };
  };
  return { app, repo, as, create };
}

afterEach(() => vi.unstubAllEnvs());

describe('POST /api/categories (admin)', () => {
  it('201 with the new category', async () => {
    const { create } = await buildApp();
    const { res, category } = await create({ name: 'Home & Kitchen', description: 'Pots and pans' });
    expect(res.statusCode).toBe(201);
    expect(category).toMatchObject({ name: 'Home & Kitchen', slug: 'home-kitchen', description: 'Pots and pans', status: 'active', parentId: null });
    expect(Object.keys(category).sort()).toEqual(['createdAt', 'description', 'id', 'name', 'parentId', 'position', 'slug', 'status', 'updatedAt']);
  });

  it('401 without a token, 403 for a customer', async () => {
    const { app, as } = await buildApp();
    expect((await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'A' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/categories', headers: as('customer'), payload: { name: 'A' } })).statusCode).toBe(403);
  });

  it.each([
    ['no name', {}],
    ['empty name', { name: '   ' }],
    ['name too long', { name: 'x'.repeat(101) }],
    ['bad slug', { name: 'A', slug: 'Not A Slug' }],
    ['slug with double dash', { name: 'A', slug: 'a--b' }],
    ['unknown field', { name: 'A', positon: 1 }],
    ['parent is not a uuid', { name: 'A', parentId: 'abc' }],
    ['negative position', { name: 'A', position: -1 }],
    ['position not whole', { name: 'A', position: 1.5 }],
    ['description too long', { name: 'A', description: 'x'.repeat(1001) }],
  ])('400 for %s', async (_label, payload) => {
    const { app, as } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/categories', headers: as('admin'), payload });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('VALIDATION_ERROR');
  });

  it('409 for a taken slug, 400 for an unknown parent', async () => {
    const { app, as, create } = await buildApp();
    await create({ name: 'Phones' });
    expect((await create({ name: 'Phones' })).res.statusCode).toBe(409);
    const res = await app.inject({
      method: 'POST',
      url: '/api/categories',
      headers: as('admin'),
      payload: { name: 'X', parentId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/categories (public)', () => {
  it('works without a token and shows only active categories', async () => {
    const { app, as, create } = await buildApp();
    await create({ name: 'Visible' });
    const { category: hidden } = await create({ name: 'Hidden' });
    await app.inject({ method: 'DELETE', url: `/api/categories/${hidden.id}`, headers: as('admin') });

    const res = await app.inject({ method: 'GET', url: '/api/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((c: { name: string }) => c.name)).toEqual(['Visible']);
    expect(res.json().nextCursor).toBeNull();
  });

  it('403 when a visitor or customer asks for archived ones; an admin may', async () => {
    const { app, as, create } = await buildApp();
    const { category } = await create({ name: 'Hidden' });
    await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: as('admin') });

    expect((await app.inject({ method: 'GET', url: '/api/categories?status=archived' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/categories?status=all', headers: as('customer') })).statusCode).toBe(403);
    const admin = await app.inject({ method: 'GET', url: '/api/categories?status=archived', headers: as('admin') });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().items).toHaveLength(1);
  });

  it('a bad token is a 401, not silently treated as a visitor', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/categories', headers: { authorization: 'Bearer not-a-token' } });
    expect(res.statusCode).toBe(401);
  });

  it('pages with nextCursor', async () => {
    const { app, create } = await buildApp();
    for (let i = 0; i < 5; i += 1) await create({ name: `Cat ${i}`, position: i });

    const first = (await app.inject({ method: 'GET', url: '/api/categories?limit=2' })).json();
    expect(first.items.map((c: { name: string }) => c.name)).toEqual(['Cat 0', 'Cat 1']);
    const second = (await app.inject({ method: 'GET', url: `/api/categories?limit=2&cursor=${first.nextCursor}` })).json();
    expect(second.items.map((c: { name: string }) => c.name)).toEqual(['Cat 2', 'Cat 3']);
    const third = (await app.inject({ method: 'GET', url: `/api/categories?limit=2&cursor=${second.nextCursor}` })).json();
    expect(third.items.map((c: { name: string }) => c.name)).toEqual(['Cat 4']);
    expect(third.nextCursor).toBeNull();
  });

  it.each(['?limit=0', '?limit=101', '?limit=abc', '?status=deleted', '?parentId=abc', '?cursor=garbage'])('400 for %s', async (query) => {
    const { app } = await buildApp();
    expect((await app.inject({ method: 'GET', url: `/api/categories${query}` })).statusCode).toBe(400);
  });

  it('parentId=root and parentId=<id> filter the levels', async () => {
    const { app, create } = await buildApp();
    const { category: parent } = await create({ name: 'Parent' });
    await create({ name: 'Child', parentId: parent.id });

    const roots = (await app.inject({ method: 'GET', url: '/api/categories?parentId=root' })).json();
    expect(roots.items.map((c: { name: string }) => c.name)).toEqual(['Parent']);
    const kids = (await app.inject({ method: 'GET', url: `/api/categories?parentId=${parent.id}` })).json();
    expect(kids.items.map((c: { name: string }) => c.name)).toEqual(['Child']);
  });
});

describe('GET one category', () => {
  it('by id and by slug', async () => {
    const { app, create } = await buildApp();
    const { category } = await create({ name: 'Phones' });
    const byId = await app.inject({ method: 'GET', url: `/api/categories/${category.id}` });
    const bySlug = await app.inject({ method: 'GET', url: '/api/categories/slug/phones' });
    expect(byId.statusCode).toBe(200);
    expect(bySlug.json()).toEqual(byId.json());
  });

  it('404 when missing, 404 for a visitor when archived, 200 for an admin', async () => {
    const { app, as, create } = await buildApp();
    const { category } = await create({ name: 'Old' });
    await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: as('admin') });

    expect((await app.inject({ method: 'GET', url: '/api/categories/0f8fad5b-d9cb-469f-a165-70867728950e' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/categories/${category.id}` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/categories/slug/old' })).statusCode).toBe(404);
    const admin = await app.inject({ method: 'GET', url: `/api/categories/${category.id}`, headers: as('admin') });
    expect(admin.statusCode).toBe(200);
    expect(admin.json().category.status).toBe('archived');
  });

  it('400 for an id that is not a uuid or a slug that is not valid', async () => {
    const { app } = await buildApp();
    expect((await app.inject({ method: 'GET', url: '/api/categories/123' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/categories/slug/Not%20Valid' })).statusCode).toBe(400);
  });
});

describe('PATCH /api/categories/:id (admin)', () => {
  it('changes the fields that were sent', async () => {
    const { app, as, create } = await buildApp();
    const { category } = await create({ name: 'Phones' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${category.id}`,
      headers: as('admin'),
      payload: { name: 'Mobile Phones', position: 3 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().category).toMatchObject({ name: 'Mobile Phones', slug: 'phones', position: 3 });
  });

  it('401 / 403 / 404 / 400 / 409', async () => {
    const { app, as, create } = await buildApp();
    const { category } = await create({ name: 'A' });
    await create({ name: 'B' });
    const patch = (id: string, payload: unknown, headers?: Record<string, string>) =>
      app.inject({ method: 'PATCH', url: `/api/categories/${id}`, ...(headers ? { headers } : {}), payload: payload as object });

    expect((await patch(category.id, { name: 'X' })).statusCode).toBe(401);
    expect((await patch(category.id, { name: 'X' }, as('customer'))).statusCode).toBe(403);
    expect((await patch('0f8fad5b-d9cb-469f-a165-70867728950e', { name: 'X' }, as('admin'))).statusCode).toBe(404);
    expect((await patch(category.id, {}, as('admin'))).statusCode).toBe(400); // nothing to change
    expect((await patch(category.id, { id: 'x' }, as('admin'))).statusCode).toBe(400); // unknown field
    expect((await patch(category.id, { status: 'deleted' }, as('admin'))).statusCode).toBe(400);
    expect((await patch(category.id, { slug: 'b' }, as('admin'))).statusCode).toBe(409);
  });

  it('can restore an archived category', async () => {
    const { app, as, create } = await buildApp();
    const { category } = await create({ name: 'A' });
    await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: as('admin') });
    const res = await app.inject({ method: 'PATCH', url: `/api/categories/${category.id}`, headers: as('admin'), payload: { status: 'active' } });
    expect(res.json().category.status).toBe('active');
    expect((await app.inject({ method: 'GET', url: `/api/categories/${category.id}` })).statusCode).toBe(200);
  });
});

describe('DELETE /api/categories/:id (admin) archives', () => {
  it('204, the category disappears for visitors but the row is kept', async () => {
    const { app, as, create, repo } = await buildApp();
    const { category } = await create({ name: 'A' });
    const res = await app.inject({ method: 'DELETE', url: `/api/categories/${category.id}`, headers: as('admin') });
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.status).toBe('archived');
    expect((await app.inject({ method: 'GET', url: '/api/categories' })).json().items).toEqual([]);
  });

  it('401 / 403 / 404 / 409 (active subcategories)', async () => {
    const { app, as, create } = await buildApp();
    const { category: parent } = await create({ name: 'Parent' });
    await create({ name: 'Child', parentId: parent.id });
    const del = (id: string, headers?: Record<string, string>) =>
      app.inject({ method: 'DELETE', url: `/api/categories/${id}`, ...(headers ? { headers } : {}) });

    expect((await del(parent.id)).statusCode).toBe(401);
    expect((await del(parent.id, as('customer'))).statusCode).toBe(403);
    expect((await del('0f8fad5b-d9cb-469f-a165-70867728950e', as('admin'))).statusCode).toBe(404);
    expect((await del(parent.id, as('admin'))).statusCode).toBe(409);
    expect((await del('123', as('admin'))).statusCode).toBe(400);
  });
});

describe('API documentation', () => {
  it('lists every categories route; reads are open, changes need a token', async () => {
    const { app } = await buildApp();
    const doc = (await app.inject('/docs/json')).json();
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/categories/', '/api/categories/slug/{slug}', '/api/categories/{id}']),
    );
    expect(doc.paths['/api/categories/'].post.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/categories/{id}'].delete.security).toEqual([{ bearerAuth: [] }]);
    expect(doc.paths['/api/categories/'].get.security).toEqual([{}, { bearerAuth: [] }]);
    expect(doc.paths['/api/categories/'].post.requestBody.content['application/json'].schema.properties.name).toBeDefined();
  });
});
