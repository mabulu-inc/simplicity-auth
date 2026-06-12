import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createMethodRouter,
  InvalidInputError,
  OtpNotAllowedError,
  UnknownMethodError,
  VerificationFailedError,
} from '../src/index.js';
import type { MethodHandler, ResolvedUser } from '../src/index.js';
import { twilioVerifyHandler } from '../src/methods/twilio/index.js';
import { oidcHandler } from '../src/methods/oidc/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

const stubUser: ResolvedUser = { userId: 2, userCommunicationMethodId: 1 };

function stubHandler(): MethodHandler & { initiate: ReturnType<typeof vi.fn>; complete: ReturnType<typeof vi.fn> } {
  return {
    initiate: vi.fn(async () => ({ otpSent: true as const })),
    complete: vi.fn(async () => stubUser),
  };
}

// Fixture (see seed-test-data.sql):
//   tenant 1 'acme'    slug 'acme'    allow_otp=false  → IdPs 1 (Microsoft), 2 (Google)
//   tenant 2 'globex'  slug 'globex'  allow_otp=true   → IdP 3 (Okta)
//   tenant 3 'initech' slug 'initech' allow_otp=true   → no IdP
describe('createMethodRouter — discovery (signInOptions)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  it('multi-IdP, SSO-only tenant → all IdPs, OTP not allowed', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: { oidc: stubHandler() }, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'acme' });
    expect(opts?.tenantId).toBe(1);
    expect(opts?.authDomains.map((d) => d.displayName).sort()).toEqual(['Google', 'Microsoft']);
    expect(opts?.otpAllowed).toBe(false); // allow_otp=false
  });

  it('single-IdP tenant with OTP allowed → one IdP, OTP allowed', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: { oidc: stubHandler() }, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'globex' });
    expect(opts?.authDomains).toHaveLength(1);
    expect(opts?.authDomains[0]?.displayName).toBe('Okta');
    expect(opts?.otpAllowed).toBe(true);
  });

  it('no-IdP tenant → zero IdPs, OTP allowed', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {}, otpHandler: stubHandler() });
    const opts = await router.signInOptions({ tenantSlug: 'initech' });
    expect(opts?.authDomains).toEqual([]);
    expect(opts?.otpAllowed).toBe(true);
  });

  it('otpAllowed is false when no otpHandler is configured', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {} });
    const opts = await router.signInOptions({ tenantSlug: 'globex' });
    expect(opts?.otpAllowed).toBe(false);
  });

  it('returns null for an unknown slug', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {} });
    expect(await router.signInOptions({ tenantSlug: 'nope' })).toBeNull();
  });
});

describe('createMethodRouter — org-bound dispatch (initiate/complete)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  it('dispatches a chosen auth_domain to the handler for its integration_type', async () => {
    const oidc = stubHandler();
    const router = createMethodRouter({ db: db.pool, handlers: { oidc } });
    await router.initiate(3); // Okta
    expect(oidc.initiate).toHaveBeenCalledOnce();
    const ctx = oidc.initiate.mock.calls[0]![0];
    expect(ctx.authDomain.authDomainId).toBe(3);
    expect(ctx.authDomain.displayName).toBe('Okta');

    const user = await router.complete(3, 'an-id-token');
    expect(user).toEqual(stubUser);
    expect(oidc.complete.mock.calls[0]![0].credential).toBe('an-id-token');
  });

  it('throws UnknownMethodError for an unknown auth_domain id', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: { oidc: stubHandler() } });
    await expect(router.initiate(99999)).rejects.toBeInstanceOf(UnknownMethodError);
  });

  it('throws UnknownMethodError when no handler is registered for the type', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {} /* no 'oidc' */ });
    await expect(router.initiate(3)).rejects.toBeInstanceOf(UnknownMethodError);
  });

  it('throws InvalidInputError on empty credential / bad id', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: { oidc: stubHandler() } });
    await expect(router.complete(3, '')).rejects.toBeInstanceOf(InvalidInputError);
    await expect(router.initiate(0)).rejects.toBeInstanceOf(InvalidInputError);
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
    const router = createMethodRouter({ db: db.pool, handlers: {}, otpHandler: otp });
    await router.initiateOtp({ tenantId: 2, identifier: 'a@b.com' }); // globex
    expect(otp.initiate).toHaveBeenCalledOnce();
    expect(await router.completeOtp({ tenantId: 2, identifier: 'a@b.com', credential: '123' })).toEqual(stubUser);
  });

  it('refuses OTP for an SSO-only tenant (allow_otp=false), in both phases', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {}, otpHandler: stubHandler() });
    await expect(router.initiateOtp({ tenantId: 1, identifier: 'a@b.com' })).rejects.toBeInstanceOf(OtpNotAllowedError);
    await expect(router.completeOtp({ tenantId: 1, identifier: 'a@b.com', credential: '123' })).rejects.toBeInstanceOf(
      OtpNotAllowedError,
    );
  });

  it('refuses OTP when no otpHandler is configured', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {} });
    await expect(router.initiateOtp({ tenantId: 2, identifier: 'a@b.com' })).rejects.toBeInstanceOf(OtpNotAllowedError);
  });

  it('fails closed for an unknown tenant', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: {}, otpHandler: stubHandler() });
    await expect(router.initiateOtp({ tenantId: 99999, identifier: 'a@b.com' })).rejects.toBeInstanceOf(
      OtpNotAllowedError,
    );
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
      handlers: {},
      otpHandler: twilioVerifyHandler({ client: fakeClient(true) }),
    });
    // globex allows OTP; alice@acme.com is ucm 1 / user 2.
    const user = await router.completeOtp({ tenantId: 2, identifier: 'alice@acme.com', credential: '123456' });
    expect(user).toEqual({ userId: 2, userCommunicationMethodId: 1 });
  });

  it('throws VerificationFailedError on a rejected code', async () => {
    const router = createMethodRouter({
      db: db.pool,
      handlers: {},
      otpHandler: twilioVerifyHandler({ client: fakeClient(false) }),
    });
    await expect(
      router.completeOtp({ tenantId: 2, identifier: 'alice@acme.com', credential: '000000' }),
    ).rejects.toBeInstanceOf(VerificationFailedError);
  });
});

describe('oidcHandler via router.initiate (network-free)', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  it('builds the authorization redirect URL from the auth_domain config', async () => {
    const router = createMethodRouter({ db: db.pool, handlers: { oidc: oidcHandler() } });
    const result = await router.initiate(1); // Microsoft (acme)
    expect('redirectUrl' in result).toBe(true);
    const url = new URL((result as { redirectUrl: string }).redirectUrl);
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/acme/oauth2/v2.0/authorize');
    expect(url.searchParams.get('client_id')).toBe('acme-ms');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://acme.app.com/callback');
  });
});
