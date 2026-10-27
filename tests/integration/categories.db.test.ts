import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/client.js';
import * as schema from '../../src/db/schema/index.js';
import { DrizzleCategoriesRepository } from '../../src/modules/categories/categories.repository.js';
import { CategoriesService, MAX_DEPTH } from '../../src/modules/categories/categories.service.js';
import { BadRequestError, ConflictError } from '../../src/shared/errors/app-error.js';
import { stubTestEnv } from '../helpers/env.js';

// Real SQL on PGlite (in memory, no Docker, no real database touched). Uses our real migration files.
describe('categories on real SQL', () => {
  const client = new PGlite();
  const db = drizzle(client, { schema }) as unknown as Database;
  const repo = new DrizzleCategoriesRepository(db);
  const service = new CategoriesService(repo);
  let seq = 0;
  const name = () => `Category ${(seq += 1)}`;
  const make = (extra: { parentId?: string | null; position?: number; slug?: string } = {}) =>
    repo.create({ name: name(), slug: extra.slug ?? `cat-${seq}`, description: null, parentId: extra.parentId ?? null, position: extra.position ?? 0 });

  beforeAll(async () => {
    await migrate(drizzle(client), { migrationsFolder: 'src/db/migrations' });
  });
  afterAll(async () => {
    await client.close();
  });

  describe('repository', () => {
    it('creates and finds by id and by slug', async () => {
      const created = await make({ slug: 'find-me' });
      expect(created).toMatchObject({ slug: 'find-me', status: 'active', position: 0, parentId: null });
      expect((await repo.findById(created.id))?.slug).toBe('find-me');
      expect((await repo.findBySlug('find-me'))?.id).toBe(created.id);
      expect(await repo.findBySlug('nope')).toBeUndefined();
      expect(await repo.findById('0f8fad5b-d9cb-469f-a165-70867728950e')).toBeUndefined();
    });

    it('a taken slug is a ConflictError, also for parallel requests (the unique index decides)', async () => {
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => make({ slug: 'race-slug' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) {
        expect(r.reason).toBeInstanceOf(ConflictError);
      }
    });

    it('the database refuses a parent that does not exist (foreign key)', async () => {
      await expect(make({ parentId: '0f8fad5b-d9cb-469f-a165-70867728950e' })).rejects.toThrow();
    });

    it('update changes the given fields, moves updated_at, and reports unknown ids and taken slugs', async () => {
      const created = await make({ slug: 'to-update' });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await repo.update(created.id, { name: 'New name', position: 9 });
      expect(updated).toMatchObject({ name: 'New name', position: 9, slug: 'to-update' });
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());

      expect(await repo.update('0f8fad5b-d9cb-469f-a165-70867728950e', { name: 'x' })).toBeUndefined();
      await make({ slug: 'taken' });
      await expect(repo.update(created.id, { slug: 'taken' })).rejects.toBeInstanceOf(ConflictError);
    });

    it('list: ordered by position then id, filtered by status and parent, with keyset pages', async () => {
      const parent = await make({ position: 100 });
      const ids: string[] = [];
      for (const position of [2, 1, 2, 1, 3]) ids.push((await make({ parentId: parent.id, position })).id);
      const archived = await make({ parentId: parent.id, position: 0 });
      await repo.update(archived.id, { status: 'archived' });

      const all = await repo.list({ status: 'active', parentId: parent.id, limit: 100 });
      expect(all).toHaveLength(5);
      expect(all.map((c) => c.position)).toEqual([1, 1, 2, 2, 3]);
      const sameDay = all.filter((c) => c.position === 1).map((c) => c.id);
      expect(sameDay).toEqual([...sameDay].sort());

      expect(await repo.list({ status: 'all', parentId: parent.id, limit: 100 })).toHaveLength(6);
      expect((await repo.list({ status: 'archived', parentId: parent.id, limit: 100 })).map((c) => c.id)).toEqual([archived.id]);

      const seen: string[] = [];
      let after: { position: number; id: string } | undefined;
      for (;;) {
        const page = await repo.list({ status: 'active', parentId: parent.id, limit: 2, after });
        if (page.length === 0) break;
        seen.push(...page.map((c) => c.id));
        const last = page[page.length - 1]!;
        after = { position: last.position, id: last.id };
      }
      expect(seen).toEqual(all.map((c) => c.id));
    });

    it('list: parentId null means top level only', async () => {
      const top = await make();
      const child = await make({ parentId: top.id });
      const roots = await repo.list({ status: 'active', parentId: null, limit: 1000 });
      expect(roots.map((c) => c.id)).toContain(top.id);
      expect(roots.map((c) => c.id)).not.toContain(child.id);
    });

    it('hasActiveChildren ignores archived children', async () => {
      const parent = await make();
      expect(await repo.hasActiveChildren(parent.id)).toBe(false);
      const child = await make({ parentId: parent.id });
      expect(await repo.hasActiveChildren(parent.id)).toBe(true);
      await repo.update(child.id, { status: 'archived' });
      expect(await repo.hasActiveChildren(parent.id)).toBe(false);
    });

    it('depthOf, subtreeHeight and isInSubtree walk the tree', async () => {
      const a = await make();
      const b = await make({ parentId: a.id });
      const c = await make({ parentId: b.id });
      const sibling = await make({ parentId: a.id });

      expect([await repo.depthOf(a.id), await repo.depthOf(b.id), await repo.depthOf(c.id)]).toEqual([1, 2, 3]);
      expect([await repo.subtreeHeight(a.id), await repo.subtreeHeight(b.id), await repo.subtreeHeight(c.id)]).toEqual([3, 2, 1]);
      expect(await repo.isInSubtree(a.id, c.id)).toBe(true);
      expect(await repo.isInSubtree(a.id, a.id)).toBe(true);
      expect(await repo.isInSubtree(b.id, sibling.id)).toBe(false);
      expect(await repo.isInSubtree(c.id, a.id)).toBe(false);
      expect(await repo.depthOf('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(0);
      expect(await repo.subtreeHeight('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(0);
    });

    it('a loop in bad data cannot hang the tree walks', async () => {
      const x = await make();
      const y = await make({ parentId: x.id });
      await db.update(schema.categories).set({ parentId: y.id }).where(eq(schema.categories.id, x.id)); // x -> y -> x
      expect(await repo.depthOf(x.id)).toBeGreaterThan(0);
      expect(await repo.subtreeHeight(x.id)).toBeGreaterThan(0);
      expect(await repo.isInSubtree(x.id, y.id)).toBe(true);
    });
  });

  describe('service on top of the real repository', () => {
    it('create a tree, move, archive, restore: the rules hold on real data', async () => {
      const electronics = await service.create({ name: `Electronics ${seq}` });
      const phones = await service.create({ name: `Phones ${seq}`, parentId: electronics.id });
      const cases = await service.create({ name: `Cases ${seq}`, parentId: phones.id });
      await expect(service.create({ name: 'Too deep', parentId: cases.id })).rejects.toBeInstanceOf(BadRequestError);

      await expect(service.update(electronics.id, { parentId: cases.id })).rejects.toBeInstanceOf(BadRequestError); // loop
      await expect(service.archive(phones.id)).rejects.toBeInstanceOf(ConflictError); // has an active child

      await service.archive(cases.id);
      await service.archive(phones.id);
      expect((await service.getById(phones.id, true)).status).toBe('archived');
      await expect(service.getById(phones.id, false)).rejects.toThrow('not found');

      await expect(service.update(cases.id, { status: 'active' })).rejects.toBeInstanceOf(BadRequestError); // parent archived
      await service.update(phones.id, { status: 'active' });
      await service.update(cases.id, { status: 'active' });
      expect((await service.getById(cases.id, false)).status).toBe('active');
      expect(MAX_DEPTH).toBe(3);

      // Nothing was removed along the way.
      const rows = await db.select().from(schema.categories).where(sql`${schema.categories.id} in (${electronics.id}, ${phones.id}, ${cases.id})`);
      expect(rows).toHaveLength(3);
    });

    it('listing in pages gives every category once', async () => {
      for (let i = 0; i < 7; i += 1) await service.create({ name: `Paged ${seq}-${i}`, position: 5000 + (i % 3) });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.list({ status: 'active', limit: 3, parentId: 'root', ...(cursor ? { cursor } : {}) }, false);
        seen.push(...page.items.map((c) => c.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(seen).size).toBe(seen.length);
      const total = (await db.select({ n: sql<number>`count(*)::int` }).from(schema.categories).where(sql`parent_id is null and status = 'active'`))[0]!.n;
      expect(seen.length).toBe(total);
    });
  });

  describe('seeder', () => {
    it('inserts the tree from the data file, and running it again changes nothing', async () => {
      stubTestEnv();
      const { insertCategoryTree } = await import('../../src/db/seeds/seeders/02-categories.seeder.js');
      const data = (await import('../../src/db/seeds/data/categories.json', { with: { type: 'json' } })).default;

      const first = await insertCategoryTree(db, data);
      expect(first).toBeGreaterThan(8);
      const before = await db.select().from(schema.categories);

      expect(await insertCategoryTree(db, data)).toBe(0);
      expect(await db.select().from(schema.categories)).toHaveLength(before.length);

      const phones = await repo.findBySlug('phones');
      const cases = await repo.findBySlug('phone-cases');
      expect((await repo.findBySlug('electronics'))?.parentId).toBeNull();
      expect(phones?.parentId).toBe((await repo.findBySlug('electronics'))?.id);
      expect(cases?.parentId).toBe(phones?.id);
      expect(await repo.depthOf(cases!.id)).toBe(MAX_DEPTH);
    });
  });
});
