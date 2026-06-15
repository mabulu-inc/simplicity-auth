import { describe, it, expect } from 'vitest';
import {
  serializeCookie,
  parseCookies,
  signLoginState,
  verifyLoginState,
  type LoginState,
} from '../src/http/cookies.js';

describe('serializeCookie', () => {
  it('defaults to HttpOnly, Secure, SameSite=Lax, Path=/', () => {
    const c = serializeCookie('sid', 'abc');
    expect(c).toBe('sid=abc; Path=/; HttpOnly; Secure; SameSite=Lax');
  });

  it('emits domain, max-age, and respects opt-outs', () => {
    const c = serializeCookie('sid', 'abc', {
      domain: '.app.example.com',
      maxAge: 600,
      secure: false,
      httpOnly: false,
      sameSite: 'none',
      path: '/auth',
    });
    expect(c).toBe('sid=abc; Path=/auth; Domain=.app.example.com; Max-Age=600; SameSite=None');
    expect(c).not.toContain('HttpOnly');
    expect(c).not.toContain('Secure');
  });

  it('Max-Age=0 expires the cookie', () => {
    expect(serializeCookie('sid', '', { maxAge: 0 })).toContain('Max-Age=0');
  });
});

describe('parseCookies', () => {
  it('parses a header into a map and round-trips a serialized name/value', () => {
    expect(parseCookies('a=1; b=two; c=')).toEqual({ a: '1', b: 'two', c: '' });
    expect(parseCookies(null)).toEqual({});
    const serialized = serializeCookie('pn_session', 'tok123');
    const name = serialized.split(';')[0];
    expect(parseCookies(name)).toEqual({ pn_session: 'tok123' });
  });
});

describe('login-state signing', () => {
  const secret = 'unit-test-secret';
  // Arbitrary payload for the sign/verify roundtrip — no DB here, so the
  // authDomainId is opaque test data, not a reference to a seeded row.
  const state: LoginState = {
    authDomainId: 7,
    state: 'state-xyz',
    nonce: 'nonce-xyz',
    codeVerifier: 'verifier-xyz',
    returnTo: '/dashboard',
  };

  it('round-trips a valid token', async () => {
    const token = await signLoginState(state, secret);
    expect(await verifyLoginState(token, secret, 600)).toEqual(state);
  });

  it('rejects a tampered payload', async () => {
    const token = await signLoginState(state, secret);
    const [body, sig] = token.split('.');
    const tampered = `${body}x.${sig}`;
    expect(await verifyLoginState(tampered, secret, 600)).toBeNull();
  });

  it('rejects the wrong secret', async () => {
    const token = await signLoginState(state, secret);
    expect(await verifyLoginState(token, 'other-secret', 600)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const issued = 1_000_000_000_000; // fixed epoch ms
    const token = await signLoginState(state, secret, issued);
    // 11 minutes later, with a 10-minute (600s) max age.
    expect(await verifyLoginState(token, secret, 600, issued + 11 * 60_000)).toBeNull();
    // Still valid at 9 minutes.
    expect(await verifyLoginState(token, secret, 600, issued + 9 * 60_000)).toEqual(state);
  });

  it('returns null on malformed/empty input', async () => {
    expect(await verifyLoginState('', secret, 600)).toBeNull();
    expect(await verifyLoginState('no-dot', secret, 600)).toBeNull();
    expect(await verifyLoginState(null, secret, 600)).toBeNull();
  });
});
