import type { Mailer } from './mailer';

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** Resend's account settings (`MAILER=resend`). */
export interface ResendSettings {
  apiKey: string;
  /** The sender, on a domain verified in Resend: `Pebble <hi@example.com>`. */
  from: string;
}

/** A status and the raw body, which is only read to explain a failure. */
export interface ResendResponse {
  status: number;
  body: string;
}

/** POSTs JSON to Resend. Rejects when Resend can't be reached. */
export type PostJson = (
  url: string,
  headers: Record<string, string>,
  body: unknown,
) => Promise<ResendResponse>;

/**
 * Sends sign-in codes through Resend's HTTP API. Over `fetch` rather than
 * Resend's SDK, as Apple's token endpoint is: one request needs no dependency.
 */
export class ResendMailer implements Mailer {
  constructor(
    private readonly settings: ResendSettings,
    private readonly post: PostJson = postJson,
  ) {}

  async sendSignInCode(email: string, code: string): Promise<void> {
    const res = await this.post(
      RESEND_EMAILS_URL,
      { Authorization: `Bearer ${this.settings.apiKey}` },
      {
        from: this.settings.from,
        to: [email],
        subject: `${code} is your Pebble sign-in code`,
        // Ten minutes is ACC-02's code lifetime, `SEND_LIMITS.ttlSeconds`.
        text: [
          `Your Pebble sign-in code is ${code}.`,
          '',
          'It expires in 10 minutes. If you didn’t ask for it, you can ignore this email.',
        ].join('\n'),
      },
    );

    // The body names the problem (a bad key, an unverified domain); the
    // recipient and code are not in it.
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Resend answered ${res.status} ${res.body}`);
    }
  }
}

/** The five-second limit keeps `POST /auth/email/code` from hanging. */
async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<ResendResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  return { status: res.status, body: await res.text() };
}
