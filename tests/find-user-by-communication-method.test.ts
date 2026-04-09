import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findUserByCommunicationMethod,
  InvalidInputError,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('findUserByCommunicationMethod', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('returns the user attached to a known email', async () => {
    const result = await findUserByCommunicationMethod(db.pool, {
      channel: 'email',
      code: 'alice@acme.com',
    });
    expect(result).toEqual({ userId: 1, userCommunicationMethodId: 1 });
  });

  it('returns null for an unknown email', async () => {
    const result = await findUserByCommunicationMethod(db.pool, {
      channel: 'email',
      code: 'nope@nowhere.com',
    });
    expect(result).toBeNull();
  });

  it('returns null when channel does not match', async () => {
    // alice@acme.com exists as 'email', but not as 'phone'
    const result = await findUserByCommunicationMethod(db.pool, {
      channel: 'phone',
      code: 'alice@acme.com',
    });
    expect(result).toBeNull();
  });

  it('throws InvalidInputError on empty channel', async () => {
    await expect(
      findUserByCommunicationMethod(db.pool, { channel: '', code: 'x' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('throws InvalidInputError on empty code', async () => {
    await expect(
      findUserByCommunicationMethod(db.pool, { channel: 'email', code: '' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('parameterizes inputs and is immune to injection attempts', async () => {
    const result = await findUserByCommunicationMethod(db.pool, {
      channel: "email' OR 1=1; --",
      code: "anything' OR 1=1; --",
    });
    expect(result).toBeNull();
  });
});
