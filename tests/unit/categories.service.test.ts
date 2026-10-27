import { describe, expect, it } from 'vitest';
import {
  CategoriesService,
  decodeCursor,
  encodeCursor,
  MAX_DEPTH,
} from '../../src/modules/categories/categories.service.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../src/shared/errors/app-error.js';
import { slugify } from '../../src/shared/utils/slug.js';
import { createFakeCategoriesRepo } from '../helpers/fake-categories.js';

function setup() {
  const repo = createFakeCategoriesRepo();
  const service = new CategoriesService(repo);
  const query = { status: 'active' as const, limit: 50 };
  return { repo, service, query };
}

describe('slugify', () => {
  it.each([
    ['Men\'s Shoes & Boots', 'mens-shoes-boots'],
    ['  Électronique  ', 'electronique'],
    ['Home   &   Kitchen', 'home-kitchen'],
    ['Phones (2024)', 'phones-2024'],
    ['---weird---', 'weird'],
  ])('%s -> %s', (text, slug) => {
    expect(slugify(text)).toBe(slug);
  });

  it('gives an empty text when nothing usable is left (for example only Bangla letters)', () => {
    expect(slugify('ইলেকট্রনিক্স')).toBe('');
    expect(slugify('!!!')).toBe('');
  });

  it('cuts long text without leaving a dash at the end', () => {
    const slug = slugify(`${'a'.repeat(99)} b`);
    expect(slug.length).toBeLessThanOrEqual(100);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('cursor', () => {
  it('round trips', () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    expect(decodeCursor(encodeCursor({ position: 7, id }))).toEqual({ position: 7, id });
  });

  it.each(['', 'not base64 at all!!', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('[1,"x"]').toString('base64url'), Buffer.from('["1","0f8fad5b-d9cb-469f-a165-70867728950e"]').toString('base64url')])(
    'refuses a bad cursor: %s',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(BadRequestError);
    },
  );
});

describe('create', () => {
  it('makes the slug from the name, trims, and starts active at position 0', async () => {
    const { service } = setup();
    const category = await service.create({ name: 'Home & Kitchen' });
    expect(category).toMatchObject({ name: 'Home & Kitchen', slug: 'home-kitchen', status: 'active', position: 0, parentId: null, description: null });
  });

  it('uses the slug the admin sent', async () => {
    const { service } = setup();
    expect((await service.create({ name: 'Phones', slug: 'mobile-phones' })).slug).toBe('mobile-phones');
  });

  it('asks for a slug when the name has no usable letters', async () => {
    const { service } = setup();
    await expect(service.create({ name: 'ইলেকট্রনিক্স' })).rejects.toBeInstanceOf(BadRequestError);
    expect((await service.create({ name: 'ইলেকট্রনিক্স', slug: 'electronics' })).slug).toBe('electronics');
  });

  it('a taken slug is a 409', async () => {
    const { service } = setup();
    await service.create({ name: 'Phones' });
    await expect(service.create({ name: 'Phones' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('an empty description is stored as null', async () => {
    const { service } = setup();
    expect((await service.create({ name: 'A', description: '   ' })).description).toBeNull();
  });

  it('needs an existing, active parent', async () => {
    const { service } = setup();
    await expect(service.create({ name: 'X', parentId: '0f8fad5b-d9cb-469f-a165-70867728950e' })).rejects.toBeInstanceOf(BadRequestError);

    const parent = await service.create({ name: 'Parent' });
    await service.archive(parent.id);
    await expect(service.create({ name: 'Child', parentId: parent.id })).rejects.toBeInstanceOf(BadRequestError);
  });

  it(`stops at ${MAX_DEPTH} levels`, async () => {
    const { service } = setup();
    const one = await service.create({ name: 'One' });
    const two = await service.create({ name: 'Two', parentId: one.id });
    const three = await service.create({ name: 'Three', parentId: two.id });
    await expect(service.create({ name: 'Four', parentId: three.id })).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('read and visibility', () => {
  it('visitors see active ones; archived look like they do not exist', async () => {
    const { service } = setup();
    const category = await service.create({ name: 'Old' });
    await service.archive(category.id);

    await expect(service.getById(category.id, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getBySlug('old', false)).rejects.toBeInstanceOf(NotFoundError);
    expect((await service.getById(category.id, true)).status).toBe('archived');
    expect((await service.getBySlug('old', true)).id).toBe(category.id);
  });

  it('a missing category is a 404', async () => {
    const { service } = setup();
    await expect(service.getById('0f8fad5b-d9cb-469f-a165-70867728950e', true)).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.getBySlug('nope', true)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('list', () => {
  it('only admins may ask for archived or all', async () => {
    const { service, query } = setup();
    await expect(service.list({ ...query, status: 'archived' }, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.list({ ...query, status: 'all' }, false)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.list({ ...query, status: 'all' }, true)).resolves.toBeDefined();
  });

  it('orders by position, filters by parent, and "root" means the top level', async () => {
    const { service, query } = setup();
    const b = await service.create({ name: 'B', position: 2 });
    const a = await service.create({ name: 'A', position: 1 });
    const child = await service.create({ name: 'Child', parentId: a.id });

    expect((await service.list(query, false)).items.map((c) => c.name)).toEqual(['Child', 'A', 'B']);
    expect((await service.list({ ...query, parentId: 'root' }, false)).items.map((c) => c.name)).toEqual(['A', 'B']);
    expect((await service.list({ ...query, parentId: a.id }, false)).items.map((c) => c.id)).toEqual([child.id]);
    expect(b.position).toBe(2);
  });

  it('pages with a cursor: no gaps, no repeats, last page has nextCursor null', async () => {
    const { service, query } = setup();
    for (let i = 0; i < 7; i += 1) await service.create({ name: `Cat ${i}`, position: i % 3 });

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await service.list({ ...query, limit: 3, ...(cursor ? { cursor } : {}) }, false);
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);
    expect((await service.list({ ...query, limit: 7 }, false)).nextCursor).toBeNull(); // exactly one full page
  });

  it('a broken cursor is a 400', async () => {
    const { service, query } = setup();
    await expect(service.list({ ...query, cursor: 'garbage' }, false)).rejects.toBeInstanceOf(BadRequestError);
  });
});

describe('update', () => {
  it('changes only what was sent; a rename does NOT change the slug', async () => {
    const { service } = setup();
    const category = await service.create({ name: 'Phones', description: 'old', position: 4 });
    const updated = await service.update(category.id, { name: 'Mobile Phones' });
    expect(updated).toMatchObject({ name: 'Mobile Phones', slug: 'phones', description: 'old', position: 4 });
  });

  it('can clear the description and change the slug', async () => {
    const { service } = setup();
    const category = await service.create({ name: 'Phones', description: 'old' });
    const updated = await service.update(category.id, { description: null, slug: 'smartphones' });
    expect(updated).toMatchObject({ description: null, slug: 'smartphones' });
  });

  it('sending the same values changes nothing (no write)', async () => {
    const { service, repo } = setup();
    const category = await service.create({ name: 'Phones' });
    const before = category.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    const same = await service.update(category.id, { name: 'Phones', slug: 'phones', position: 0 });
    expect(same.updatedAt).toBe(before);
    expect(repo.rows).toHaveLength(1);
  });

  it('404 for an unknown id, 409 for a taken slug', async () => {
    const { service } = setup();
    await expect(service.update('0f8fad5b-d9cb-469f-a165-70867728950e', { name: 'X' })).rejects.toBeInstanceOf(NotFoundError);
    await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    await expect(service.update(b.id, { slug: 'a' })).rejects.toBeInstanceOf(ConflictError);
  });

  describe('moving', () => {
    it('can move under another category and back to the top (parentId null)', async () => {
      const { service } = setup();
      const a = await service.create({ name: 'A' });
      const b = await service.create({ name: 'B' });
      expect((await service.update(b.id, { parentId: a.id })).parentId).toBe(a.id);
      expect((await service.update(b.id, { parentId: null })).parentId).toBeNull();
    });

    it('not under itself, not under its own subcategory (no loops)', async () => {
      const { service } = setup();
      const a = await service.create({ name: 'A' });
      const b = await service.create({ name: 'B', parentId: a.id });
      const c = await service.create({ name: 'C', parentId: b.id });
      await expect(service.update(a.id, { parentId: a.id })).rejects.toBeInstanceOf(BadRequestError);
      await expect(service.update(a.id, { parentId: b.id })).rejects.toBeInstanceOf(BadRequestError);
      await expect(service.update(a.id, { parentId: c.id })).rejects.toBeInstanceOf(BadRequestError);
    });

    it(`keeps the whole tree within ${MAX_DEPTH} levels (counts the levels under the moved one too)`, async () => {
      const { service } = setup();
      const a = await service.create({ name: 'A' });
      const a2 = await service.create({ name: 'A2', parentId: a.id });
      const x = await service.create({ name: 'X' });
      await service.create({ name: 'X2', parentId: x.id });
      // X (with X2 under it) is 2 levels. Under A2 (depth 2) it would reach depth 4.
      await expect(service.update(x.id, { parentId: a2.id })).rejects.toBeInstanceOf(BadRequestError);
      // Under A (depth 1) it reaches depth 3: allowed.
      expect((await service.update(x.id, { parentId: a.id })).parentId).toBe(a.id);
    });

    it('not under an archived or unknown parent', async () => {
      const { service } = setup();
      const a = await service.create({ name: 'A' });
      const b = await service.create({ name: 'B' });
      await service.archive(b.id);
      await expect(service.update(a.id, { parentId: b.id })).rejects.toBeInstanceOf(BadRequestError);
      await expect(service.update(a.id, { parentId: '0f8fad5b-d9cb-469f-a165-70867728950e' })).rejects.toBeInstanceOf(BadRequestError);
    });
  });
});

describe('archive ("delete") and restore', () => {
  it('hides the category but keeps the row', async () => {
    const { service, repo } = setup();
    const category = await service.create({ name: 'A' });
    await service.archive(category.id);
    expect(repo.rows).toHaveLength(1);
    expect(repo.rows[0]?.status).toBe('archived');
  });

  it('doing it twice is fine', async () => {
    const { service } = setup();
    const category = await service.create({ name: 'A' });
    await service.archive(category.id);
    await expect(service.archive(category.id)).resolves.toBeUndefined();
  });

  it('404 for an unknown id', async () => {
    const { service } = setup();
    await expect(service.archive('0f8fad5b-d9cb-469f-a165-70867728950e')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('is refused while it still has active subcategories (409); fine once they are archived', async () => {
    const { service } = setup();
    const parent = await service.create({ name: 'Parent' });
    const child = await service.create({ name: 'Child', parentId: parent.id });
    await expect(service.archive(parent.id)).rejects.toBeInstanceOf(ConflictError);
    await service.archive(child.id);
    await expect(service.archive(parent.id)).resolves.toBeUndefined();
  });

  it('restore works, but not under an archived parent', async () => {
    const { service } = setup();
    const parent = await service.create({ name: 'Parent' });
    const child = await service.create({ name: 'Child', parentId: parent.id });
    await service.archive(child.id);
    await service.archive(parent.id);

    await expect(service.update(child.id, { status: 'active' })).rejects.toBeInstanceOf(BadRequestError);
    expect((await service.update(parent.id, { status: 'active' })).status).toBe('active');
    expect((await service.update(child.id, { status: 'active' })).status).toBe('active');
  });

  it('restoring while moving to the top level works even if the old parent is archived', async () => {
    const { service } = setup();
    const parent = await service.create({ name: 'Parent' });
    const child = await service.create({ name: 'Child', parentId: parent.id });
    await service.archive(child.id);
    await service.archive(parent.id);
    const restored = await service.update(child.id, { status: 'active', parentId: null });
    expect(restored).toMatchObject({ status: 'active', parentId: null });
  });
});
