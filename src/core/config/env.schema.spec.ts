import { generateKeyPairSync } from 'node:crypto';
import { envSchema } from './env.schema';

const P8 = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  .privateKey.export({ format: 'pem', type: 'pkcs8' })
  .toString();

const BASE = {
  DATABASE_URL:
    'postgres://pebble:pebble@localhost:5432/pebble?sslmode=disable',
  JWT_SECRET: 'j'.repeat(32),
  SIGN_IN_CODE_SECRET: 's'.repeat(32),
};

const APPLE = {
  APPLE_CLIENT_IDS: 'com.pebble.app, com.pebble.app.dev',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  APPLE_PRIVATE_KEY: P8,
};

function issuesFor(raw: Record<string, string>): string[] {
  const result = envSchema.safeParse({ ...BASE, ...raw });
  return result.success
    ? []
    : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('envSchema: Sign in with Apple', () => {
  it('leaves Apple off by default outside production', () => {
    expect(envSchema.parse(BASE)).toMatchObject({
      APPLE_CLIENT_IDS: [],
      APPLE_TEAM_ID: '',
    });
  });

  it('reads all four settings', () => {
    expect(envSchema.parse({ ...BASE, ...APPLE })).toMatchObject({
      APPLE_CLIENT_IDS: ['com.pebble.app', 'com.pebble.app.dev'],
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_KEY_ID: 'KEY1234567',
      APPLE_PRIVATE_KEY: P8,
    });
  });

  it('reads a key written on one line with \\n escapes', () => {
    const oneLine = P8.replace(/\n/g, '\\n');

    expect(
      envSchema.parse({ ...BASE, ...APPLE, APPLE_PRIVATE_KEY: oneLine })
        .APPLE_PRIVATE_KEY,
    ).toBe(P8);
  });

  it.each([
    'APPLE_CLIENT_IDS',
    'APPLE_TEAM_ID',
    'APPLE_KEY_ID',
    'APPLE_PRIVATE_KEY',
  ])('refuses to start with %s missing from the other three', (missing) => {
    expect(issuesFor({ ...APPLE, [missing]: '' })).toContain(missing);
  });

  it('refuses a private key that is not a P-256 PEM', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();

    expect(issuesFor({ ...APPLE, APPLE_PRIVATE_KEY: 'not a key' })).toEqual([
      'APPLE_PRIVATE_KEY',
    ]);
    expect(issuesFor({ ...APPLE, APPLE_PRIVATE_KEY: rsa })).toEqual([
      'APPLE_PRIVATE_KEY',
    ]);
  });

  it('starts in production without Apple', () => {
    const production = {
      NODE_ENV: 'production',
      GOOGLE_CLIENT_IDS: 'ios-client',
      CORS_ORIGINS: 'https://app.example.com',
    };

    expect(issuesFor(production)).not.toContain('APPLE_CLIENT_IDS');
  });
});

describe('envSchema: mailer', () => {
  const RESEND = {
    MAILER: 'resend',
    RESEND_API_KEY: 're_key',
    MAIL_FROM: 'Pebble <signin@pebble.app>',
  };

  it('reads the Resend settings', () => {
    expect(envSchema.parse({ ...BASE, ...RESEND })).toMatchObject(RESEND);
  });

  it.each(['RESEND_API_KEY', 'MAIL_FROM'])(
    'refuses MAILER=resend without %s',
    (missing) => {
      expect(issuesFor({ ...RESEND, [missing]: '' })).toEqual([missing]);
    },
  );

  it('refuses the log mailer in production, and accepts Resend there', () => {
    const production = {
      NODE_ENV: 'production',
      GOOGLE_CLIENT_IDS: 'ios-client',
    };

    expect(issuesFor(production)).toEqual(['MAILER']);
    expect(issuesFor({ ...production, ...RESEND })).toEqual([]);
  });
});
