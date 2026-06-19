import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServiceContext } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// The slug IS the tenant sub-domain (acme.app.com), so it must be a valid DNS
// label. Enforced by the tenants_slug_format_check CHECK in
// schema/tables/tenants.yaml (NULL-safe, since slug is optional).
describe('tenant slug format check', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  // Inserts touch the audited tenants table, so they need an actor in context.
  const insertTenant = (name: string, slug: string | null) =>
    withServiceContext(db.pool, 'transform-worker', (client) =>
      client.query(`INSERT INTO tenants (name, slug) VALUES ($1, $2)`, [name, slug]),
    );

  it('accepts a valid DNS-label slug', async () => {
    await expect(insertTenant('Valid Co', 'valid-co-123')).resolves.toBeDefined();
  });

  it('accepts a NULL slug (multitenancy is optional)', async () => {
    await expect(insertTenant('No Slug Co', null)).resolves.toBeDefined();
  });

  it.each([
    ['uppercase', 'Acme'],
    ['leading hyphen', '-acme'],
    ['trailing hyphen', 'acme-'],
    ['underscore', 'acme_corp'],
    ['dot', 'acme.corp'],
    ['space', 'acme corp'],
  ])('rejects an invalid slug (%s)', async (_label, slug) => {
    await expect(insertTenant(`Bad ${slug}`, slug)).rejects.toMatchObject({ code: '23514' });
  });
});
