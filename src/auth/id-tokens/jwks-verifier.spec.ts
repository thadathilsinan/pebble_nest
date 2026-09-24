import {
  generateKeyPairSync,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import { sign, type SignOptions } from 'jsonwebtoken';
import { JwksVerifier, maxAgeOf, type KeySet } from './jwks-verifier';

const CLIENT_ID = 'ios-client';
const ISSUER = 'https://issuer.example.com';

function rsaKey(kid: string): { privateKey: KeyObject; jwk: JsonWebKey } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  return {
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256' },
  };
}

// Generated once: RSA key generation is the slow part of this file.
const provider = rsaKey('k1');
const stranger = rsaKey('k1');
const rotatedIn = rsaKey('k2');

const CLAIMS = {
  email: 'Me@Example.com',
  email_verified: true,
  name: '  Ada Lovelace ',
};

function token(
  claims: Record<string, unknown> = CLAIMS,
  options: Partial<SignOptions> = {},
  key: KeyObject = provider.privateKey,
): string {
  return sign(claims, key, {
    algorithm: 'RS256',
    keyid: 'k1',
    issuer: ISSUER,
    audience: CLIENT_ID,
    expiresIn: 3600,
    ...options,
  });
}

describe('JwksVerifier', () => {
  let keySet: KeySet;
  let fetchKeys: jest.Mock<Promise<KeySet>, []>;
  let now: number;
  let verifier: JwksVerifier;

  beforeEach(() => {
    keySet = { keys: [provider.jwk], maxAgeSeconds: 3600 };
    fetchKeys = jest.fn(() => Promise.resolve(keySet));
    now = Date.now();
    verifier = new JwksVerifier(
      {
        issuers: [ISSUER, 'issuer.example.com'],
        audiences: ['web-client', CLIENT_ID],
        fetchKeys,
      },
      () => now,
    );
  });

  it('verifies a token and returns the account as Pebble stores it', async () => {
    await expect(verifier.verify(token())).resolves.toEqual({
      outcome: 'verified',
      account: { email: 'me@example.com', name: 'Ada Lovelace' },
      audience: CLIENT_ID,
    });
  });

  it('names our client ID a multi-audience token was issued to', async () => {
    await expect(
      verifier.verify(token(CLAIMS, { audience: ['someone-else', CLIENT_ID] })),
    ).resolves.toMatchObject({ outcome: 'verified', audience: CLIENT_ID });
  });

  it('accepts every spelling of the issuer', async () => {
    await expect(
      verifier.verify(token(CLAIMS, { issuer: 'issuer.example.com' })),
    ).resolves.toMatchObject({ outcome: 'verified' });
  });

  it.each([
    ['another app’s audience', { audience: 'someone-else' }],
    ['another issuer', { issuer: 'https://evil.example.com' }],
    ['an expired token', { expiresIn: -10 }],
  ])('refuses %s', async (_, options: Partial<SignOptions>) => {
    await expect(verifier.verify(token(CLAIMS, options))).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('refuses a token signed by another key with the same kid', async () => {
    await expect(
      verifier.verify(token(CLAIMS, {}, stranger.privateKey)),
    ).resolves.toEqual({ outcome: 'invalid' });
  });

  it('refuses an HS256 token keyed with the public key', async () => {
    const forged = sign(CLAIMS, JSON.stringify(provider.jwk), {
      algorithm: 'HS256',
      keyid: 'k1',
      issuer: ISSUER,
      audience: CLIENT_ID,
    });

    await expect(verifier.verify(forged)).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('refuses garbage without fetching keys', async () => {
    await expect(verifier.verify('not.a.jwt')).resolves.toEqual({
      outcome: 'invalid',
    });
    expect(fetchKeys).not.toHaveBeenCalled();
  });

  it.each([
    ['an unverified email', { ...CLAIMS, email_verified: false }],
    ['no email', { email_verified: true }],
    ['an email sign-in would refuse', { ...CLAIMS, email: 'not-an-email' }],
  ])('refuses %s', async (_, claims: Record<string, unknown>) => {
    await expect(verifier.verify(token(claims))).resolves.toEqual({
      outcome: 'invalid',
    });
  });

  it('accepts email_verified as a string', async () => {
    await expect(
      verifier.verify(token({ ...CLAIMS, email_verified: 'true' })),
    ).resolves.toMatchObject({ outcome: 'verified' });
  });

  it.each([
    ['no name', { email: 'a@b.co', email_verified: true }, null],
    ['a blank name', { ...CLAIMS, name: '   ' }, null],
    ['a long name', { ...CLAIMS, name: 'x'.repeat(100) }, 'x'.repeat(80)],
    [
      'a name cut through an emoji',
      { ...CLAIMS, name: `${'x'.repeat(79)}😀` },
      'x'.repeat(79),
    ],
  ])('returns %s as it fits PATCH /me', async (_, claims, name) => {
    await expect(verifier.verify(token(claims))).resolves.toMatchObject({
      account: { name },
    });
  });

  describe('key cache', () => {
    it('fetches once for concurrent and later tokens while fresh', async () => {
      await Promise.all([verifier.verify(token()), verifier.verify(token())]);
      await verifier.verify(token());

      expect(fetchKeys).toHaveBeenCalledTimes(1);
    });

    it('refetches once the max-age has passed', async () => {
      await verifier.verify(token());
      now += 3601 * 1000;
      await verifier.verify(token());

      expect(fetchKeys).toHaveBeenCalledTimes(2);
    });

    it('refetches for a new kid, but not within five minutes of the last fetch', async () => {
      await verifier.verify(token());
      keySet = { keys: [provider.jwk, rotatedIn.jwk], maxAgeSeconds: 3600 };
      const k2 = token(CLAIMS, { keyid: 'k2' }, rotatedIn.privateKey);

      await expect(verifier.verify(k2)).resolves.toEqual({
        outcome: 'invalid',
      });
      expect(fetchKeys).toHaveBeenCalledTimes(1);

      now += 5 * 60 * 1000;
      await expect(verifier.verify(k2)).resolves.toMatchObject({
        outcome: 'verified',
      });
      expect(fetchKeys).toHaveBeenCalledTimes(2);
    });

    it('is unavailable when the keys cannot be fetched', async () => {
      fetchKeys.mockRejectedValue(new Error('down'));

      await expect(verifier.verify(token())).resolves.toEqual({
        outcome: 'unavailable',
      });
    });

    it('keeps using a cached key when a refetch fails', async () => {
      await verifier.verify(token());
      now += 3601 * 1000;
      fetchKeys.mockRejectedValue(new Error('down'));

      await expect(verifier.verify(token())).resolves.toMatchObject({
        outcome: 'verified',
      });
    });
  });
});

describe('maxAgeOf', () => {
  it.each([
    ['public, max-age=19645, must-revalidate', 19645],
    ['no-cache', 3600],
    [null, 3600],
  ])('reads %p as %p seconds', (header, seconds) => {
    expect(maxAgeOf(header)).toBe(seconds);
  });
});
