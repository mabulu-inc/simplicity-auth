import { X509Certificate, createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as jose from 'jose';
import pg from 'pg';
import { InvalidInputError, VerificationFailedError } from '../src/index.js';
import {
  generateClientKey,
  getClientCredentialStatus,
  oidcHandler,
  setClientSecret,
  type CredentialCipher,
  type OidcHandlerOptions,
  type OidcParams,
  type TokenEndpointAuthMethod,
} from '../src/methods/oidc/index.js';
import type { AuthDomain } from '../src/index.js';
import { seedVerifiedDomain } from './helpers/email-domains.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// Per-auth-domain client credentials (#25): who may set them, that nobody
// reachable from a tenant session reads them back, that the database never
// holds plaintext, and that each auth domain authenticates with exactly the
// method it declares.

let db: TestDb;
let appRls: pg.Pool;
let appPrivileged: pg.Pool;
let globexSecurity: number; // security admin of globex only
let globexSettings: number; // settings admin of globex only

// A stand-in for the app's KMS: reversible, bound to its row, and never equal to the plaintext.
const cipher: CredentialCipher = {
  async encrypt(plaintext, { authDomainId, purpose }) {
    return `enc:${authDomainId}:${purpose}:${Buffer.from(plaintext).reverse().toString('base64')}`;
  },
  async decrypt(ciphertext, { authDomainId, purpose }) {
    const prefix = `enc:${authDomainId}:${purpose}:`;
    if (!ciphertext.startsWith(prefix)) throw new Error(`wrong context for ${ciphertext}`);
    return Buffer.from(ciphertext.slice(prefix.length), 'base64').reverse().toString();
  },
};

// ── A mock IdP that records every token request ──
const issuer = 'https://idp.credentials.test';
const tokenEndpoint = `${issuer}/token`;
let signIdToken: (claims: jose.JWTPayload) => Promise<void>;
let tokenStatus = 200;
const tokenRequests: { headers: Headers; body: URLSearchParams }[] = [];
let fetchImpl: typeof fetch;

async function asAppInit<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.actor_id', $1, true)`, [String(db.ids.appInit)]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Run fn as app_rls impersonating `actorId`, committed. */
async function asUser<T>(actorId: number, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appRls.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.actor_id', $1, true)`, [String(actorId)]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function admin(tenantRole: 'security' | 'settings', name: string): Promise<number> {
  return asAppInit(async (c) => {
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (name, kind) VALUES ($1, 'human') RETURNING user_id AS id`,
      [name],
    );
    const id = Number(u.rows[0]!.id);
    await c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [
      id,
      db.ids.roles[tenantRole],
      db.ids.tenants.globex,
    ]);
    return id;
  });
}

/** A globex auth domain at the mock IdP, declaring `method`. */
async function authDomain(method?: TokenEndpointAuthMethod): Promise<AuthDomain<OidcParams>> {
  const integrationParams: OidcParams = {
    issuer,
    clientId: 'globex-client',
    redirectUri: 'https://globex.app.test/auth/oidc/callback',
    ...(method ? { tokenEndpointAuthMethod: method } : {}),
  };
  const id = await asAppInit(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO auth_domains (tenant_id, display_name, integration_type, integration_params)
       VALUES ($1, 'Credentials IdP', 'oidc', $2::jsonb) RETURNING auth_domain_id AS id`,
      [db.ids.tenants.globex, JSON.stringify(integrationParams)],
    );
    return Number(rows[0]!.id);
  });
  return {
    authDomainId: id,
    tenantId: db.ids.tenants.globex,
    displayName: 'Credentials IdP',
    integrationType: 'oidc',
    integrationParams,
  };
}

/** One full sign-in against the mock IdP; returns the token request it made. */
async function signIn(ad: AuthDomain<OidcParams>, options: OidcHandlerOptions = { cipher }) {
  const oidc = oidcHandler({ fetch: fetchImpl, ...options });
  const { redirectUrl, loginState } = await oidc.initiate(ad);
  const state = new URL(redirectUrl).searchParams.get('state')!;
  await signIdToken({ sub: 'bob', nonce: loginState.nonce, email: 'bob@globex.com' });
  const before = tokenRequests.length;
  const user = await oidc
    .complete({
      db: appPrivileged,
      authDomain: ad,
      callbackUrl: `${ad.integrationParams.redirectUri}?code=c&state=${state}`,
      loginState,
    })
    .catch((err: unknown) => err);
  return { user, requests: tokenRequests.slice(before) };
}

beforeAll(async () => {
  db = await startTestDb();
  appRls = new pg.Pool({ connectionString: db.appRlsConnectionString, max: 2 });
  appPrivileged = new pg.Pool({ connectionString: db.appPrivilegedConnectionString, max: 2 });
  globexSecurity = await admin('security', 'GlobexSecurity');
  globexSettings = await admin('settings', 'GlobexSettings');
  await seedVerifiedDomain(db, db.ids.tenants.globex, 'globex.com');

  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'idp', alg: 'ES256', use: 'sig' };
  let idToken = '';
  signIdToken = async (claims) => {
    idToken = await new jose.SignJWT({ aud: 'globex-client', iss: issuer, ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: 'idp' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  };
  fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['ES256'],
      });
    }
    if (url === `${issuer}/jwks`) return Response.json({ keys: [jwk] });
    if (url === tokenEndpoint) {
      tokenRequests.push({ headers: new Headers(init?.headers), body: new URLSearchParams(String(init?.body)) });
      if (tokenStatus !== 200) return Response.json({ error: 'invalid_client' }, { status: tokenStatus });
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});

afterAll(async () => {
  await appRls.end();
  await appPrivileged.end();
  await db.shutdown();
});

describe('who can configure SSO', () => {
  it.each([
    ['security', () => globexSecurity],
    ['settings', () => globexSettings],
  ])('a %s admin can set up the tenant’s auth domains, email domains and credentials', async (_role, who) => {
    const ad = await authDomain('client_secret_post');
    await asUser(who(), async (c) => {
      await c.query(
        `INSERT INTO auth_domains (tenant_id, display_name, integration_type, integration_params)
         VALUES ($1, 'Another IdP', 'oidc', '{}'::jsonb)`,
        [db.ids.tenants.globex],
      );
      await c.query(`INSERT INTO tenant_email_domains (tenant_id, domain, sso_required) VALUES ($1, $2, true)`, [
        db.ids.tenants.globex,
        `${_role}.globex.test`,
      ]);
      await setClientSecret(c, { authDomainId: ad.authDomainId, secret: 's3cret', cipher });
    });
    const status = await asUser(who(), (c) => getClientCredentialStatus(c, ad.authDomainId));
    expect(status?.secretSetAt).toBeInstanceOf(Date);
  });

  it('nobody else can: not another tenant’s admin, not a plain user', async () => {
    const ad = await authDomain('client_secret_post');
    const acmeSecurity = await asAppInit(async (c) => {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (name, kind) VALUES ('AcmeSecurity', 'human') RETURNING user_id AS id`,
      );
      const id = Number(u.rows[0]!.id);
      await c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [
        id,
        db.ids.roles.security,
        db.ids.tenants.acme,
      ]);
      return id;
    });
    for (const who of [acmeSecurity, db.ids.users.bob]) {
      await expect(
        asUser(who, (c) => setClientSecret(c, { authDomainId: ad.authDomainId, secret: 'x', cipher })),
      ).rejects.toBeInstanceOf(InvalidInputError);
      expect(await asUser(who, (c) => getClientCredentialStatus(c, ad.authDomainId))).toBeNull();
    }
  });

  it('nobody reachable from a tenant session reads a secret or private key back, including the admin who set it', async () => {
    const ad = await authDomain('private_key_jwt');
    await asUser(globexSecurity, async (c) => {
      await setClientSecret(c, { authDomainId: ad.authDomainId, secret: 's3cret', cipher });
      await generateClientKey(c, { authDomainId: ad.authDomainId, cipher });
    });
    for (const sql of [
      'SELECT secret_ciphertext FROM auth_domain_credentials',
      'SELECT private_key_ciphertext FROM auth_domain_credentials',
      'SELECT * FROM auth_domain_credentials',
      // A WHERE clause reads the column too, so it can't be probed through UPDATE.
      `UPDATE auth_domain_credentials SET certificate = certificate WHERE secret_ciphertext LIKE 'enc%'`,
    ]) {
      await expect(asUser(globexSecurity, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('storage', () => {
  it('the database holds only what the cipher produced, never the plaintext', async () => {
    const ad = await authDomain('client_secret_basic');
    await asUser(globexSecurity, (c) =>
      setClientSecret(c, { authDomainId: ad.authDomainId, secret: 'plain-text-secret', cipher }),
    );
    const { rows } = await db.pool.query<{ ct: string }>(
      'SELECT secret_ciphertext AS ct FROM auth_domain_credentials WHERE auth_domain_id = $1',
      [ad.authDomainId],
    );
    expect(rows[0]!.ct).toBe(
      await cipher.encrypt('plain-text-secret', { authDomainId: ad.authDomainId, purpose: 'client_secret' }),
    );
    expect(rows[0]!.ct).not.toContain('plain-text-secret');
  });

  it('generates a key pair whose certificate and JWK match, and shows the admin only the public half', async () => {
    const ad = await authDomain('private_key_jwt');
    const generated = await asUser(globexSecurity, (c) =>
      generateClientKey(c, { authDomainId: ad.authDomainId, cipher }),
    );

    const cert = new X509Certificate(generated.certificatePem);
    const [jwk] = generated.jwks.keys as (Record<string, unknown> & { x5c: string[] })[];
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(jwk!['x5t#S256']).toBe(createHash('sha256').update(cert.raw).digest('base64url'));
    expect(jwk!.kid).toBe(jwk!['x5t#S256']);
    expect(Buffer.from(jwk!.x5c[0]!, 'base64').equals(cert.raw)).toBe(true);
    expect(jwk).not.toHaveProperty('d');

    const status = await asUser(globexSettings, (c) => getClientCredentialStatus(c, ad.authDomainId));
    expect(status).toMatchObject({ secretSetAt: null, privateKeySetAt: expect.any(Date), publicKey: generated });
  });
});

describe('client authentication at the token endpoint', () => {
  async function withSecret(method: TokenEndpointAuthMethod) {
    const ad = await authDomain(method);
    await asUser(globexSecurity, (c) =>
      setClientSecret(c, { authDomainId: ad.authDomainId, secret: 'stored-secret', cipher }),
    );
    return ad;
  }

  it('client_secret_basic sends the secret only in the Authorization header', async () => {
    const { user, requests } = await signIn(await withSecret('client_secret_basic'));

    expect(user).toMatchObject({ userId: db.ids.users.bob });
    expect(requests).toHaveLength(1);
    // RFC 6749 §2.3.1: id and secret are form-url-encoded before base64, so
    // decode as a spec-compliant server does.
    const [scheme, encoded] = requests[0]!.headers.get('authorization')!.split(' ');
    const [id, secret] = Buffer.from(encoded!, 'base64').toString().split(':').map(decodeURIComponent);
    expect([scheme, id, secret]).toEqual(['Basic', 'globex-client', 'stored-secret']);
    expect(requests[0]!.body.has('client_secret')).toBe(false);
  });

  it('client_secret_post sends the secret only in the body', async () => {
    const { user, requests } = await signIn(await withSecret('client_secret_post'));

    expect(user).toMatchObject({ userId: db.ids.users.bob });
    expect(requests[0]!.headers.get('authorization')).toBeNull();
    expect(requests[0]!.body.get('client_secret')).toBe('stored-secret');
  });

  it('none sends no credential, even with one stored', async () => {
    const { user, requests } = await signIn(await withSecret('none'));

    expect(user).toMatchObject({ userId: db.ids.users.bob });
    expect(requests[0]!.headers.get('authorization')).toBeNull();
    expect(requests[0]!.body.has('client_secret')).toBe(false);
    expect(requests[0]!.body.has('client_assertion')).toBe(false);
  });

  it('private_key_jwt signs an assertion Entra accepts: thumbprint header, token-endpoint audience', async () => {
    const ad = await authDomain('private_key_jwt');
    const { jwks } = await asUser(globexSecurity, (c) =>
      generateClientKey(c, { authDomainId: ad.authDomainId, cipher }),
    );

    const { user, requests } = await signIn(ad);

    expect(user).toMatchObject({ userId: db.ids.users.bob });
    const body = requests[0]!.body;
    expect(requests[0]!.headers.get('authorization')).toBeNull();
    expect(body.has('client_secret')).toBe(false);
    expect(body.get('client_assertion_type')).toBe('urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const publicKey = await jose.importJWK(jwks.keys[0] as jose.JWK, 'RS256');
    const { payload, protectedHeader } = await jose.jwtVerify(body.get('client_assertion')!, publicKey, {
      audience: tokenEndpoint,
      issuer: 'globex-client',
      subject: 'globex-client',
    });
    expect(payload.aud).toBe(tokenEndpoint);
    expect(protectedHeader).toMatchObject({
      alg: 'RS256',
      'x5t#S256': (jwks.keys[0] as Record<string, unknown>)['x5t#S256'],
    });
    expect(protectedHeader.x5t).toBeTruthy();
  });

  it('a rejected credential is not retried with another method, and the error carries no secret', async () => {
    const ad = await withSecret('client_secret_basic');
    tokenStatus = 401;
    try {
      const { user, requests } = await signIn(ad);

      expect(requests).toHaveLength(1);
      expect(user).toBeInstanceOf(VerificationFailedError);
      expect(JSON.stringify(user, Object.getOwnPropertyNames(user))).not.toContain('stored-secret');
    } finally {
      tokenStatus = 200;
    }
  });

  it('a replaced secret is used on the very next sign-in', async () => {
    const ad = await withSecret('client_secret_post');
    const oidcOptions = { cipher };
    expect((await signIn(ad, oidcOptions)).requests[0]!.body.get('client_secret')).toBe('stored-secret');

    await asUser(globexSettings, (c) =>
      setClientSecret(c, { authDomainId: ad.authDomainId, secret: 'rotated', cipher }),
    );

    expect((await signIn(ad, oidcOptions)).requests[0]!.body.get('client_secret')).toBe('rotated');
  });

  it('a soft-deleted auth domain’s credential is never used', async () => {
    const ad = await withSecret('client_secret_post');
    await asAppInit((c) =>
      c.query('UPDATE auth_domains SET deleted_at = now() WHERE auth_domain_id = $1', [ad.authDomainId]),
    );

    const { user, requests } = await signIn(ad);

    expect(user).toBeInstanceOf(InvalidInputError);
    expect(requests).toHaveLength(0);
  });

  it('the app’s own clientSecret resolver wins over a stored secret', async () => {
    const ad = await withSecret('client_secret_post');

    const { requests } = await signIn(ad, { cipher, clientSecret: () => 'from-the-app' });

    expect(requests[0]!.body.get('client_secret')).toBe('from-the-app');
  });

  it('an auth domain that declares no method keeps the old behavior', async () => {
    const ad = await authDomain();

    const withResolver = await signIn(ad, { clientSecret: () => 'legacy' });
    const without = await signIn(ad, {});

    expect(withResolver.requests[0]!.body.get('client_secret')).toBe('legacy');
    expect(without.requests[0]!.body.has('client_secret')).toBe(false);
    expect(without.requests[0]!.headers.get('authorization')).toBeNull();
  });

  it('refuses an unknown method before contacting the IdP', async () => {
    const ad = await authDomain('client_secret_jwt' as TokenEndpointAuthMethod);

    await expect(oidcHandler({ fetch: fetchImpl, cipher }).initiate(ad)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
