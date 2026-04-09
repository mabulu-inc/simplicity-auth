import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateSync, verifySync } from 'otplib';
import {
  generateDevOtpSecret,
  getDevOtpEnrollmentUri,
  InvalidInputError,
  isDevOtpEnrolled,
  verifyDevOtp,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

const ALICE_UCM_ID = 1; // matches seed-test-data.sql
const BOB_UCM_ID = 2; // not enrolled

// One TestDb shared by every describe block in this file. Two TestDb
// instances per file caused a CI flake: schema-flow's cleanup() calls
// pg_terminate_backend on the test db, which races against the other
// describe block's pool teardown. Sharing one db avoids the race
// entirely.
let db: TestDb;
let aliceSecret: string;

beforeAll(async () => {
  db = await startTestDb();
  aliceSecret = generateDevOtpSecret();
  await db.pool.query(
    `INSERT INTO dev_otp_enrollments (user_communication_method_id, totp_secret, label)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_communication_method_id) DO UPDATE
       SET totp_secret = EXCLUDED.totp_secret`,
    [ALICE_UCM_ID, aliceSecret, "Alice's test enrollment"],
  );
});

afterAll(async () => {
  await db.shutdown();
});

describe('verifyDevOtp', () => {
  beforeEach(async () => {
    // Reset usage counters between tests so assertions are reliable.
    await db.pool.query(
      `UPDATE dev_otp_enrollments
       SET last_used_at = NULL, used_count = 0
       WHERE user_communication_method_id = $1`,
      [ALICE_UCM_ID],
    );
  });

  it('returns true and updates audit fields for a valid current code', async () => {
    const code = generateSync({ secret: aliceSecret });
    const ok = await verifyDevOtp(db.pool, ALICE_UCM_ID, code);
    expect(ok).toBe(true);

    const { rows } = await db.pool.query(
      `SELECT used_count, last_used_at
       FROM dev_otp_enrollments
       WHERE user_communication_method_id = $1`,
      [ALICE_UCM_ID],
    );
    expect(rows[0].used_count).toBe(1);
    expect(rows[0].last_used_at).toBeInstanceOf(Date);
  });

  it('returns false for a wrong code without updating audit fields', async () => {
    const ok = await verifyDevOtp(db.pool, ALICE_UCM_ID, '000000');
    expect(ok).toBe(false);

    const { rows } = await db.pool.query(
      `SELECT used_count, last_used_at
       FROM dev_otp_enrollments
       WHERE user_communication_method_id = $1`,
      [ALICE_UCM_ID],
    );
    expect(rows[0].used_count).toBe(0);
    expect(rows[0].last_used_at).toBeNull();
  });

  it('returns false (not throws) when no enrollment exists', async () => {
    const code = generateSync({ secret: aliceSecret });
    const ok = await verifyDevOtp(db.pool, BOB_UCM_ID, code);
    expect(ok).toBe(false);
  });

  it('increments used_count across multiple successful verifies', async () => {
    const code1 = generateSync({ secret: aliceSecret });
    await verifyDevOtp(db.pool, ALICE_UCM_ID, code1);
    // generate again — TOTP returns the same code within the same window
    const code2 = generateSync({ secret: aliceSecret });
    await verifyDevOtp(db.pool, ALICE_UCM_ID, code2);

    const { rows } = await db.pool.query(
      `SELECT used_count
       FROM dev_otp_enrollments
       WHERE user_communication_method_id = $1`,
      [ALICE_UCM_ID],
    );
    expect(rows[0].used_count).toBe(2);
  });

  it('throws InvalidInputError on bad userCommunicationMethodId', async () => {
    await expect(
      verifyDevOtp(db.pool, -1, '123456'),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      // @ts-expect-error testing runtime validation
      verifyDevOtp(db.pool, 'one', '123456'),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('throws InvalidInputError on empty/non-string code', async () => {
    await expect(
      verifyDevOtp(db.pool, ALICE_UCM_ID, ''),
    ).rejects.toBeInstanceOf(InvalidInputError);
    await expect(
      // @ts-expect-error testing runtime validation
      verifyDevOtp(db.pool, ALICE_UCM_ID, 123456),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('returns false on a malformed (non-base32) stored secret without crashing', async () => {
    // Temporarily corrupt Alice's secret
    await db.pool.query(
      `UPDATE dev_otp_enrollments
       SET totp_secret = 'not a valid base32 secret!!'
       WHERE user_communication_method_id = $1`,
      [ALICE_UCM_ID],
    );
    try {
      const ok = await verifyDevOtp(db.pool, ALICE_UCM_ID, '123456');
      expect(ok).toBe(false);
    } finally {
      // Restore
      await db.pool.query(
        `UPDATE dev_otp_enrollments
         SET totp_secret = $2
         WHERE user_communication_method_id = $1`,
        [ALICE_UCM_ID, aliceSecret],
      );
    }
  });

  it('rejects SQL-injection-shaped codes via parameterization', async () => {
    const malicious = "'; DROP TABLE dev_otp_enrollments; --";
    const ok = await verifyDevOtp(db.pool, ALICE_UCM_ID, malicious);
    expect(ok).toBe(false);
    // Confirm table still exists
    const { rows } = await db.pool.query(
      `SELECT to_regclass('dev_otp_enrollments') AS exists`,
    );
    expect(rows[0]?.exists).toBe('dev_otp_enrollments');
  });
});

describe('generateDevOtpSecret', () => {
  it('returns a non-empty base32 string each call', () => {
    const a = generateDevOtpSecret();
    const b = generateDevOtpSecret();
    expect(a).toMatch(/^[A-Z2-7]+$/);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });

  it('produces secrets that round-trip with the verify path', () => {
    const secret = generateDevOtpSecret();
    const code = generateSync({ secret });
    expect(verifySync({ secret, token: code }).valid).toBe(true);
  });
});

describe('isDevOtpEnrolled', () => {
  it('returns true for an enrolled user', async () => {
    // Alice is enrolled by the file-level beforeAll above.
    expect(await isDevOtpEnrolled(db.pool, ALICE_UCM_ID)).toBe(true);
  });

  it('returns false for a user with no enrollment', async () => {
    expect(await isDevOtpEnrolled(db.pool, BOB_UCM_ID)).toBe(false);
  });

  it('throws InvalidInputError on bad userCommunicationMethodId', async () => {
    await expect(isDevOtpEnrolled(db.pool, -1)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      // @ts-expect-error testing runtime validation
      isDevOtpEnrolled(db.pool, 'one'),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('getDevOtpEnrollmentUri', () => {
  it('builds an otpauth:// URI for an authenticator app', () => {
    const uri = getDevOtpEnrollmentUri({
      secret: 'JBSWY3DPEHPK3PXP',
      label: 'sam@salez1.com',
      issuer: 'Salez1',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Salez1');
    expect(uri).toContain('sam%40salez1.com');
  });

  it('throws InvalidInputError on missing fields', () => {
    expect(() =>
      getDevOtpEnrollmentUri({ secret: '', label: 'x', issuer: 'y' }),
    ).toThrow(InvalidInputError);
    expect(() =>
      getDevOtpEnrollmentUri({ secret: 'x', label: '', issuer: 'y' }),
    ).toThrow(InvalidInputError);
    expect(() =>
      getDevOtpEnrollmentUri({ secret: 'x', label: 'y', issuer: '' }),
    ).toThrow(InvalidInputError);
  });
});
