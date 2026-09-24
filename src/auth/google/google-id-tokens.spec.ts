import { generateKeyPairSync } from 'node:crypto';
import { sign } from 'jsonwebtoken';
import { googleIdTokens } from './google-id-tokens';

const CLIENT_ID = 'ios-client.apps.googleusercontent.com';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1' };

function token(issuer: string): string {
  return sign({ email: 'me@example.com', email_verified: true }, privateKey, {
    algorithm: 'RS256',
    keyid: 'k1',
    issuer,
    audience: CLIENT_ID,
    expiresIn: 3600,
  });
}

describe('googleIdTokens', () => {
  const verifier = googleIdTokens([CLIENT_ID], () =>
    Promise.resolve({ keys: [jwk], maxAgeSeconds: 3600 }),
  );

  it.each(['accounts.google.com', 'https://accounts.google.com'])(
    'accepts the issuer %s',
    async (issuer) => {
      await expect(verifier.verify(token(issuer))).resolves.toMatchObject({
        outcome: 'verified',
      });
    },
  );

  it('refuses Apple’s issuer', async () => {
    await expect(
      verifier.verify(token('https://appleid.apple.com')),
    ).resolves.toEqual({ outcome: 'invalid' });
  });
});
