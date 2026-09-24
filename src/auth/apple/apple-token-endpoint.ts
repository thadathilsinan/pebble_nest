import { sign } from 'jsonwebtoken';
import type { AppleGrant } from './apple-grants.repository';
import type { AppleCodeExchange, AppleTokens } from './apple-tokens';

const APPLE = 'https://appleid.apple.com';

/**
 * How long a client secret is good for. Apple allows six months; a fresh one
 * per call costs one ES256 signature, so there is nothing worth caching.
 */
const CLIENT_SECRET_TTL_SECONDS = 5 * 60;

/** The Sign in with Apple key from the developer account (api-plan §13). */
export interface AppleSigningKey {
  teamId: string;
  keyId: string;
  /** The `.p8` file's contents: a PKCS #8 PEM for a P-256 key. */
  privateKey: string;
}

/** A status and parsed JSON body, or `null` for a body that isn't JSON. */
export interface AppleFormResponse {
  status: number;
  body: unknown;
}

/** POSTs a form to Apple. Rejects when Apple can't be reached. */
export type PostForm = (
  url: string,
  form: URLSearchParams,
) => Promise<AppleFormResponse>;

/**
 * Apple's token endpoint, authenticated as Apple requires: a client secret
 * that is a JWT signed with our Sign in with Apple key, naming the client ID
 * it acts for.
 */
export class AppleTokenEndpoint implements AppleTokens {
  constructor(
    private readonly key: AppleSigningKey,
    private readonly post: PostForm = postForm,
  ) {}

  async exchange(code: string, clientId: string): Promise<AppleCodeExchange> {
    let res: AppleFormResponse;
    try {
      res = await this.post(
        `${APPLE}/auth/token`,
        this.form(clientId, { code, grant_type: 'authorization_code' }),
      );
    } catch (error) {
      return { outcome: 'unavailable', reason: String(error) };
    }

    const body = (res.body ?? {}) as Record<string, unknown>;

    if (res.status === 200 && typeof body.refresh_token === 'string') {
      return { outcome: 'exchanged', refreshToken: body.refresh_token };
    }
    // The one error that is about the code: used, expired, or issued to
    // another client. Any other means our own credentials or Apple are wrong.
    if (res.status === 400 && body.error === 'invalid_grant') {
      return { outcome: 'invalid' };
    }

    return {
      outcome: 'unavailable',
      reason: `Apple's token endpoint answered ${res.status} ${JSON.stringify(res.body)}`,
    };
  }

  async revoke({ clientId, refreshToken }: AppleGrant): Promise<void> {
    const res = await this.post(
      `${APPLE}/auth/revoke`,
      this.form(clientId, {
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    );

    if (res.status !== 200) {
      throw new Error(
        `Apple's revoke endpoint answered ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
  }

  private form(
    clientId: string,
    fields: Record<string, string>,
  ): URLSearchParams {
    return new URLSearchParams({
      client_id: clientId,
      client_secret: this.clientSecret(clientId),
      ...fields,
    });
  }

  private clientSecret(clientId: string): string {
    return sign({}, this.key.privateKey, {
      algorithm: 'ES256',
      keyid: this.key.keyId,
      issuer: this.key.teamId,
      subject: clientId,
      audience: APPLE,
      expiresIn: CLIENT_SECRET_TTL_SECONDS,
    });
  }
}

/** The five-second limit keeps sign-in and account deletion from hanging. */
async function postForm(
  url: string,
  form: URLSearchParams,
): Promise<AppleFormResponse> {
  const res = await fetch(url, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(5000),
  });
  const text = await res.text();

  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Left null: Apple's revoke answers 200 with an empty body.
  }

  return { status: res.status, body };
}
