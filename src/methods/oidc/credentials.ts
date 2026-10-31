import { createHash, webcrypto } from 'node:crypto';
import { InvalidInputError } from '../../errors.js';
import type { Queryable } from '../../types.js';

/** What a stored credential is, passed to the cipher with every call. */
export interface CredentialContext {
  authDomainId: number;
  purpose: 'client_secret' | 'private_key';
}

/**
 * Encrypts and decrypts a stored client credential. The app supplies it, for
 * example with an AWS KMS data key, so the library picks no key-management
 * vendor and the database never holds plaintext. Use the context to bind each
 * ciphertext to its row (a KMS encryption context, say), so a ciphertext copied
 * to another auth domain won't decrypt.
 */
export interface CredentialCipher {
  encrypt(plaintext: string, context: CredentialContext): Promise<string>;
  decrypt(ciphertext: string, context: CredentialContext): Promise<string>;
}

/** The public half of an auth domain's generated key, to give its IdP. */
export interface ClientPublicKey {
  /** A JWKS with the one key, carrying `kid`, `x5c` and `x5t#S256`. */
  jwks: { keys: webcrypto.JsonWebKey[] };
  /** A self-signed X.509 certificate (PEM), for IdPs that take a certificate, such as Entra. */
  certificatePem: string;
}

/** What an admin can see about an auth domain's credential: never the secret or private key. */
export interface ClientCredentialStatus {
  secretSetAt: Date | null;
  privateKeySetAt: Date | null;
  /** The public key, when one has been generated. */
  publicKey: ClientPublicKey | null;
}

const RSA: webcrypto.RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
};

// Admin writes run on the admin's session client, as app_rls, so RLS admits
// only the tenant's security or settings admin. app_rls can write these columns
// but not read the ciphertext back. Update-then-insert, since ON CONFLICT DO
// UPDATE would need SELECT on the excluded ciphertext columns.
async function writeCredential(db: Queryable, authDomainId: number, set: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(set);
  const values = Object.values(set);
  const update = await db.query(
    `UPDATE auth_domain_credentials SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}
     WHERE auth_domain_id = $1`,
    [authDomainId, ...values],
  );
  if (update.rowCount) return;
  try {
    const insert = await db.query(
      `INSERT INTO auth_domain_credentials (auth_domain_id, ${cols.join(', ')})
       SELECT $1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}
       WHERE NOT EXISTS (SELECT 1 FROM auth_domain_credentials WHERE auth_domain_id = $1)
       ON CONFLICT DO NOTHING`,
      [authDomainId, ...values],
    );
    if (insert.rowCount) return;
  } catch (err) {
    // An RLS refusal: not a live auth domain this admin may configure.
    if ((err as { code?: string }).code !== '42501') throw err;
  }
  throw new InvalidInputError(`auth domain ${authDomainId} is not a live auth domain you may configure`);
}

/**
 * Set or replace an auth domain's client secret, encrypted through `cipher`.
 * Run it on the admin's session client (e.g. inside `withSession`): only the
 * tenant's security or settings admin may. It takes effect on the next sign-in.
 */
export async function setClientSecret(
  db: Queryable,
  input: { authDomainId: number; secret: string; cipher: CredentialCipher },
): Promise<void> {
  const { authDomainId, secret, cipher } = input;
  if (typeof secret !== 'string' || secret.length === 0)
    throw new InvalidInputError('secret must be a non-empty string');
  const ciphertext = await cipher.encrypt(secret, { authDomainId, purpose: 'client_secret' });
  await writeCredential(db, authDomainId, { secret_ciphertext: ciphertext, secret_set_at: new Date() });
}

/**
 * Generate (or replace) an auth domain's RSA key pair for `private_key_jwt`.
 * The private key is stored encrypted through `cipher`; the public half comes
 * back, and stays readable through {@link getClientCredentialStatus}, for the
 * admin to upload to their IdP. Run it on the admin's session client.
 *
 * Needs the optional peers `@peculiar/x509` and `reflect-metadata` (for the
 * certificate), loaded only here, so apps that never generate a key needn't
 * install them.
 */
export async function generateClientKey(
  db: Queryable,
  input: { authDomainId: number; cipher: CredentialCipher; subject?: string; validityDays?: number },
): Promise<ClientPublicKey> {
  const { authDomainId, cipher } = input;
  const validityDays = input.validityDays ?? 730;
  await import('reflect-metadata');
  const x509 = await import('@peculiar/x509');
  x509.cryptoProvider.set(webcrypto as Crypto);

  const keys = await webcrypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  const notBefore = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: Buffer.from(webcrypto.getRandomValues(new Uint8Array(16)))
      .toString('hex')
      .replace(/^[89a-f]/, '1'),
    name: `CN=${input.subject ?? `auth-domain-${authDomainId}`}`,
    notBefore,
    notAfter: new Date(notBefore.getTime() + validityDays * 86_400_000),
    keys: keys as webcrypto.CryptoKeyPair,
    signingAlgorithm: RSA,
  });
  const der = Buffer.from(cert.rawData);
  const thumbprint = createHash('sha256').update(der).digest('base64url');
  const jwk: webcrypto.JsonWebKey & Record<string, unknown> = {
    ...(await webcrypto.subtle.exportKey('jwk', keys.publicKey)),
    kid: thumbprint,
    alg: 'RS256',
    use: 'sig',
    x5c: [der.toString('base64')],
    'x5t#S256': thumbprint,
  };
  delete jwk.key_ops;
  delete jwk.ext;

  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey)).toString('base64');
  const ciphertext = await cipher.encrypt(pkcs8, { authDomainId, purpose: 'private_key' });
  const certificatePem = cert.toString('pem');
  await writeCredential(db, authDomainId, {
    private_key_ciphertext: ciphertext,
    private_key_set_at: notBefore,
    public_jwk: JSON.stringify(jwk),
    certificate: certificatePem,
  });
  return { jwks: { keys: [jwk] }, certificatePem };
}

/**
 * Whether an auth domain has a secret and a key, when each was last set, and
 * the public key. Never the secret or private key. Run it on the admin's
 * session client; returns null for an auth domain they can't see or that has
 * no credential.
 */
export async function getClientCredentialStatus(
  db: Queryable,
  authDomainId: number,
): Promise<ClientCredentialStatus | null> {
  const { rows } = await db.query<{
    secretSetAt: Date | null;
    privateKeySetAt: Date | null;
    publicJwk: webcrypto.JsonWebKey | null;
    certificate: string | null;
  }>(
    `SELECT secret_set_at AS "secretSetAt", private_key_set_at AS "privateKeySetAt",
            public_jwk AS "publicJwk", certificate
     FROM auth_domain_credentials WHERE auth_domain_id = $1`,
    [authDomainId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    secretSetAt: row.secretSetAt,
    privateKeySetAt: row.privateKeySetAt,
    publicKey:
      row.publicJwk && row.certificate ? { jwks: { keys: [row.publicJwk] }, certificatePem: row.certificate } : null,
  };
}

// ─── Read for the token exchange (privileged, pre-session) ─────────────────

// Joined to a live auth domain, so a soft-deleted one's credential is never used.
const SELECT_CREDENTIAL = `
  SELECT c.secret_ciphertext AS "secretCiphertext", c.private_key_ciphertext AS "privateKeyCiphertext",
         c.public_jwk AS "publicJwk"
  FROM auth_domain_credentials c
  JOIN auth_domains ad ON ad.auth_domain_id = c.auth_domain_id AND ad.deleted_at IS NULL
  WHERE c.auth_domain_id = $1
`;

interface StoredCredential {
  secretCiphertext: string | null;
  privateKeyCiphertext: string | null;
  publicJwk: Record<string, unknown> | null;
}

async function storedCredential(db: Queryable, authDomainId: number): Promise<StoredCredential | undefined> {
  const { rows } = await db.query<StoredCredential>(SELECT_CREDENTIAL, [authDomainId]);
  return rows[0];
}

async function decrypt(
  cipher: CredentialCipher | undefined,
  ciphertext: string,
  context: CredentialContext,
): Promise<string> {
  if (!cipher) {
    throw new InvalidInputError(
      `auth domain ${context.authDomainId} has a stored credential but no cipher is configured`,
    );
  }
  try {
    return await cipher.decrypt(ciphertext, context);
  } catch {
    // The plaintext never existed here, but keep the hook's error (which may
    // echo its input) out of anything that gets logged or returned.
    throw new Error(
      `could not decrypt the ${context.purpose.replace('_', ' ')} for auth domain ${context.authDomainId}`,
    );
  }
}

/** The decrypted client secret, read fresh for this exchange; undefined when none is stored. */
export async function loadClientSecret(
  db: Queryable,
  authDomainId: number,
  cipher: CredentialCipher | undefined,
): Promise<string | undefined> {
  const stored = await storedCredential(db, authDomainId);
  if (!stored?.secretCiphertext) return undefined;
  return decrypt(cipher, stored.secretCiphertext, { authDomainId, purpose: 'client_secret' });
}

/** The private key and its certificate thumbprints, read fresh for this exchange; undefined when none is stored. */
export async function loadClientKey(
  db: Queryable,
  authDomainId: number,
  cipher: CredentialCipher | undefined,
): Promise<{ key: CryptoKey; x5tS256: string; x5t: string } | undefined> {
  const stored = await storedCredential(db, authDomainId);
  if (!stored?.privateKeyCiphertext || !stored.publicJwk) return undefined;
  const pkcs8 = await decrypt(cipher, stored.privateKeyCiphertext, { authDomainId, purpose: 'private_key' });
  const key = await webcrypto.subtle.importKey('pkcs8', Buffer.from(pkcs8, 'base64'), RSA, false, ['sign']);
  const der = Buffer.from((stored.publicJwk.x5c as string[])[0]!, 'base64');
  return {
    key: key as CryptoKey,
    x5tS256: stored.publicJwk['x5t#S256'] as string,
    x5t: createHash('sha1').update(der).digest('base64url'),
  };
}
