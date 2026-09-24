import { generateKeyPairSync } from 'node:crypto';
import { verify, type JwtPayload } from 'jsonwebtoken';
import {
  AppleTokenEndpoint,
  type AppleFormResponse,
} from './apple-token-endpoint';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});

const KEY = {
  teamId: 'TEAM123456',
  keyId: 'KEY1234567',
  privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};

const CLIENT_ID = 'com.pebble.app';

describe('AppleTokenEndpoint', () => {
  let post: jest.Mock<Promise<AppleFormResponse>, [string, URLSearchParams]>;
  let endpoint: AppleTokenEndpoint;

  beforeEach(() => {
    post = jest.fn<Promise<AppleFormResponse>, [string, URLSearchParams]>();
    endpoint = new AppleTokenEndpoint(KEY, post);
  });

  function sent(): URLSearchParams {
    return post.mock.calls[0]![1];
  }

  describe('exchange', () => {
    it('trades the code for Apple’s refresh token', async () => {
      post.mockResolvedValue({
        status: 200,
        body: { refresh_token: 'apple-refresh', id_token: 'x.y.z' },
      });

      await expect(endpoint.exchange('the-code', CLIENT_ID)).resolves.toEqual({
        outcome: 'exchanged',
        refreshToken: 'apple-refresh',
      });

      expect(post.mock.calls[0]![0]).toBe(
        'https://appleid.apple.com/auth/token',
      );
      expect(Object.fromEntries(sent())).toMatchObject({
        client_id: CLIENT_ID,
        code: 'the-code',
        grant_type: 'authorization_code',
      });
    });

    it('signs the client secret with our key, as Apple requires', async () => {
      post.mockResolvedValue({ status: 200, body: { refresh_token: 'r' } });

      await endpoint.exchange('the-code', CLIENT_ID);

      const secret = sent().get('client_secret')!;
      const claims = verify(secret, publicKey, {
        algorithms: ['ES256'],
        complete: true,
      });
      expect(claims.header.kid).toBe(KEY.keyId);
      expect(claims.payload as JwtPayload).toMatchObject({
        iss: KEY.teamId,
        sub: CLIENT_ID,
        aud: 'https://appleid.apple.com',
      });
    });

    it('calls a code Apple rejects invalid', async () => {
      post.mockResolvedValue({ status: 400, body: { error: 'invalid_grant' } });

      await expect(endpoint.exchange('used', CLIENT_ID)).resolves.toEqual({
        outcome: 'invalid',
      });
    });

    it.each([
      [
        'refuses our client',
        { status: 400, body: { error: 'invalid_client' } },
      ],
      ['fails', { status: 500, body: null }],
      ['sends no refresh token', { status: 200, body: {} }],
    ])(
      'is unavailable when Apple %s',
      async (_, response: AppleFormResponse) => {
        post.mockResolvedValue(response);

        await expect(
          endpoint.exchange('the-code', CLIENT_ID),
        ).resolves.toMatchObject({ outcome: 'unavailable' });
      },
    );

    it('is unavailable when Apple cannot be reached', async () => {
      post.mockRejectedValue(new Error('timeout'));

      await expect(
        endpoint.exchange('the-code', CLIENT_ID),
      ).resolves.toMatchObject({ outcome: 'unavailable' });
    });
  });

  describe('revoke', () => {
    it('revokes the refresh token under the client it was issued to', async () => {
      post.mockResolvedValue({ status: 200, body: null });

      await endpoint.revoke({ clientId: CLIENT_ID, refreshToken: 'r' });

      expect(post.mock.calls[0]![0]).toBe(
        'https://appleid.apple.com/auth/revoke',
      );
      expect(Object.fromEntries(sent())).toMatchObject({
        client_id: CLIENT_ID,
        token: 'r',
        token_type_hint: 'refresh_token',
      });
      expect(sent().get('client_secret')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('rejects when Apple does not confirm it', async () => {
      post.mockResolvedValue({
        status: 400,
        body: { error: 'invalid_client' },
      });

      await expect(
        endpoint.revoke({ clientId: CLIENT_ID, refreshToken: 'r' }),
      ).rejects.toThrow('400');
    });
  });
});
