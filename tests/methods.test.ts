import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMethodRouter, InvalidInputError, OtpNotAllowedError, VerificationFailedError } from '../src/index.js';
import type { MethodHandler, ResolvedUser } from '../src/index.js';
import { twilioVerifyHandler } from '../src/methods/twilio/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// An arbitrary resolved user returned by the stub OTP handler below. Its ids
// are synthetic — not seeded rows — since the gating tests only assert that the
// router passes the handler's result straight through.
const stubUser: ResolvedUser = { userId: 9001, userCommunicationMethodId: 9002 };

function stubHandler(): MethodHandler & { initiate: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } {
  return {
    initiate: vi.fn(async () => ({ otpSent: true as const })),
    complete: vi.fn(async () => stubUser),
  };
}

// Fixture (see seed-test-data.sql):
//   acme    (slug 'acme')    allow_otp=false  → IdPs Microsoft + Google
//   globex  (slug 'globex')  allow_otp=true   → IdP Okta
//   initech (slug 'initech') allow_otp=true   → no IdP
describe('createMethodRouter — discovery (signInOptions)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  it('multi-IdP, SSO-only tenant → all IdPs, OTP not allowed', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'acme' });
    expect(opts?.tenantId).toBe(db.ids.tenants.acme);
    expect(opts?.authDomains.map((d) => d.displayName).sort()).toEqual(['Google', 'Microsoft']);
    expect(opts?.otpAllowed).toBe(false); // allow_otp=false
  });

  it('single-IdP tenant with OTP allowed → one IdP, OTP allowed', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'globex' });
    expect(opts?.authDomains).toHaveLength(1);
    expect(opts?.authDomains[0]?.displayName).toBe('Okta');
    expect(opts?.authDomains[0]?.integrationType).toBe('oidc');
    expect(opts?.otpAllowed).toBe(true);
  });

  it('no-IdP tenant → zero IdPs, OTP allowed', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'initech' });
    expect(opts?.authDomains).toEqual([]);
    expect(opts?.otpAllowed).toBe(true);
  });

  it('otpAllowed is false when no otpHandler is configured', async () => {
    const router = createMethodRouter({ db: db.pool });
    const opts = await router.signInOptions({ tenantSlug: 'globex' });
    expect(opts?.otpAllowed).toBe(false);
  });

  it('returns null for an unknown slug', async () => {
    const router = createMethodRouter({ db: db.pool });
    expect(await router.signInOptions({ tenantSlug: 'nope' })).toBeNull();
  });
});

describe('createMethodRouter — OTP gating', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  it('allows OTP for a tenant with allow_otp=true', async () => {
    const otp = stubHandler();
    const router = createMethodRouter({ db: db.pool, otpHandler: otp });
    await router.initiateOtp({ tenantId: db.ids.tenants.globex, identifier: 'a@b.com' }); // globex
    expect(otp.initiate).toHaveBeenCalledOnce();
    expect(
      await router.completeOtp({ tenantId: db.ids.tenants.globex, identifier: 'a@b.com', credential: '123' }),
    ).toEqual(stubUser);
  });

  it('refuses OTP for an SSO-only tenant (allow_otp=false), in both phases', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    await expect(router.initiateOtp({ tenantId: db.ids.tenants.acme, identifier: 'a@b.com' })).rejects.toBeInstanceOf(
      OtpNotAllowedError,
    );
    await expect(
      router.completeOtp({ tenantId: db.ids.tenants.acme, identifier: 'a@b.com', credential: '123' }),
    ).rejects.toBeInstanceOf(OtpNotAllowedError);
  });

  it('refuses OTP when no otpHandler is configured', async () => {
    const router = createMethodRouter({ db: db.pool });
    await expect(router.initiateOtp({ tenantId: db.ids.tenants.globex, identifier: 'a@b.com' })).rejects.toBeInstanceOf(
      OtpNotAllowedError,
    );
  });

  it('fails closed for an unknown tenant', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    await expect(router.initiateOtp({ tenantId: 99999, identifier: 'a@b.com' })).rejects.toBeInstanceOf(
      OtpNotAllowedError,
    );
  });

  it('throws InvalidInputError on bad inputs', async () => {
    const router = createMethodRouter({ db: db.pool, otpHandler: stubHandler() });
    await expect(router.initiateOtp({ tenantId: db.ids.tenants.globex, identifier: '' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    await expect(
      router.completeOtp({ tenantId: db.ids.tenants.globex, identifier: 'a@b.com', credential: '' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('twilioVerifyHandler via router.completeOtp', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  function fakeClient(approve: boolean) {
    return {
      sendVerificationCode: vi.fn(async () => true),
      verifyVerificationCode: vi.fn(async () => approve),
    };
  }

  it('resolves the user on an approved code (tenant allows OTP)', async () => {
    const router = createMethodRouter({
      db: db.pool,
      otpHandler: twilioVerifyHandler({ client: fakeClient(true) }),
    });
    // globex allows OTP; alice@acme.com resolves to Alice.
    const user = await router.completeOtp({
      tenantId: db.ids.tenants.globex,
      identifier: 'alice@acme.com',
      credential: '123456',
    });
    expect(user).toEqual({ userId: db.ids.users.alice, userCommunicationMethodId: db.ids.ucm.alice });
  });

  it('throws VerificationFailedError on a rejected code', async () => {
    const router = createMethodRouter({
      db: db.pool,
      otpHandler: twilioVerifyHandler({ client: fakeClient(false) }),
    });
    await expect(
      router.completeOtp({ tenantId: db.ids.tenants.globex, identifier: 'alice@acme.com', credential: '000000' }),
    ).rejects.toBeInstanceOf(VerificationFailedError);
  });
});
