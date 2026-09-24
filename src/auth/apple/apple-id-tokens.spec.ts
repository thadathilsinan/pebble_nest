import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { appleIdTokens } from './apple-id-tokens';

const CLIENT_ID = 'com.pebble.app';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };

function token(issuer: string, claims: Record<string, unknown> = {}): string {
  return sign(
    {
      email: 'abc123@privaterelay.appleid.com',
      email_verified: 'true',
      is_private_email: 'true',
      ...claims,
    },
    privateKey,
    {
      algorithm: 'RS256',
      keyid: 'k1',
      issuer,
      audience: CLIENT_ID,
      subject: '001234.abcd.0123',
      expiresIn: 600,
    },
  );
}

describe('appleIdTokens', () => {
  const verifier = appleIdTokens([CLIENT_ID], () =>
    Promise.resolve({ keys: [jwk], maxAgeSeconds: 3600 }),
  );

  it('verifies an Apple identity token, private relay address included', async () => {
    await expect(
      verifier.verify(token('https://appleid.apple.com')),
    ).resolves.toEqual({
      outcome: 'verified',
      account: { email: 'abc123@privaterelay.appleid.com', name: null },
      audience: CLIENT_ID,
    });
  });

  it('accepts email_verified as a boolean too', async () => {
    await expect(
      verifier.verify(
        token('https://appleid.apple.com', { email_verified: true }),
      ),
    ).resolves.toMatchObject({ outcome: 'verified' });
  });

  it('refuses Google’s issuer', async () => {
    await expect(
      verifier.verify(token('https://accounts.google.com')),
    ).resolves.toEqual({ outcome: 'invalid' });
  });
});
