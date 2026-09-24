import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { MAILER, type Mailer } from '../src/auth/mailer/mailer';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';
import { POOL } from '../src/core/database/database.module';

/** `expect.any` is typed `any`; this names what it matches once. */
const anyString: unknown = expect.any(String);

/** Captures what would have been emailed, instead of logging it. */
class FakeMailer implements Mailer {
  readonly sent: { email: string; code: string }[] = [];

  sendSignInCode(email: string, code: string): Promise<void> {
    this.sent.push({ email, code });
    return Promise.resolve();
  }

  lastCodeFor(email: string): string {
    const code = this.sent.filter((m) => m.email === email).at(-1)?.code;
    if (code === undefined) throw new Error(`no code sent to ${email}`);
    return code;
  }
}

type Occurrence = { name: string; trace: string | null };
type Day = { blocks: Occurrence[] };

describe('/block-names (e2e)', () => {
  let app: NestExpressApplication;
  let pool: Pool;
  let mailer: FakeMailer;
  let accessToken: string;

  beforeEach(async () => {
    mailer = new FakeMailer();
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MAILER)
      .useValue(mailer)
      .compile();

    // Mirrors `main.ts`; see the note in auth.e2e-spec.ts.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();

    pool = moduleFixture.get<Pool>(POOL);
    await pool.query(
      'TRUNCATE users, sessions, session_refresh_tokens, email_sign_in_codes, block_series, block_name_traces RESTART IDENTITY CASCADE',
    );
    accessToken = await signIn('me@example.com');
  });

  afterEach(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  async function signIn(email: string): Promise<string> {
    await http().post('/api/v1/auth/email/code').send({ email }).expect(204);
    const res = await http()
      .post('/api/v1/auth/email/verify')
      .send({ email, code: mailer.lastCodeFor(email) })
      .expect(200);
    return (res.body as { data: { accessToken: string } }).data.accessToken;
  }

  async function postBlock(name: string, token = accessToken) {
    const res = await http()
      .post('/api/v1/blocks')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name,
        date: '2026-09-24',
        startMin: 540,
        endMin: 600,
        alert: false,
      })
      .expect(201);
    return (res.body as { data: Occurrence }).data;
  }

  function getNames(query = '', token = accessToken) {
    return http()
      .get(`/api/v1/block-names${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function names(query = ''): Promise<string[]> {
    const res = await getNames(query).expect(200);
    return (res.body as { data: { items: string[] } }).data.items;
  }

  function putTrace(name: string, body: object, token = accessToken) {
    return http()
      .put(`/api/v1/block-names/${encodeURIComponent(name)}/trace`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function tracesOn(date: string): Promise<Record<string, unknown>> {
    const res = await http()
      .get(`/api/v1/days/${date}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    return Object.fromEntries(
      (res.body as { data: Day }).data.blocks.map((b) => [b.name, b.trace]),
    );
  }

  describe('GET /block-names', () => {
    it('lists names once each, most recently used first, in their latest spelling', async () => {
      for (const name of ['gym', 'Deep work', 'Family', 'Gym']) {
        await postBlock(name);
      }
      await postBlock('Theirs', await signIn('them@example.com'));

      const res = await getNames().expect(200);
      expect(res.body).toEqual({
        data: { items: ['Gym', 'Family', 'Deep work'] },
      });
    });

    it('offers at most 6', async () => {
      for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        await postBlock(name);
      }

      expect(await names()).toEqual(['G', 'F', 'E', 'D', 'C', 'B']);
    });

    it('matches what is typed anywhere in the name, ignoring capitals and spaces', async () => {
      for (const name of ['Deep work', 'Homework', 'Gym', 'Work']) {
        await postBlock(name);
      }

      // The name typed exactly is not offered back.
      expect(await names('?q=%20WORK%20')).toEqual(['Homework', 'Deep work']);
      expect(await names('?q=gym')).toEqual([]);
      expect(await names('?q=')).toEqual([
        'Work',
        'Gym',
        'Homework',
        'Deep work',
      ]);
    });

    it('is empty with no blocks', async () => {
      expect(await names()).toEqual([]);
    });

    it('refuses a query longer than a name can be', async () => {
      const res = await getNames(`?q=${'x'.repeat(61)}`).expect(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('needs an access token', async () => {
      const res = await http().get('/api/v1/block-names').expect(401);
      expect(res.body).toEqual({
        error: { code: 'TOKEN_INVALID', message: anyString },
      });
    });
  });

  describe('PUT /block-names/{name}/trace', () => {
    it('draws every block of the name in the chosen trace', async () => {
      await postBlock('Family');
      await postBlock(' family ');
      await postBlock('Gym');

      const res = await putTrace(' FAMILY', { trace: 'grid' }).expect(204);

      expect(res.body).toEqual({});
      expect(await tracesOn('2026-09-24')).toEqual({
        Family: 'grid',
        family: 'grid',
        Gym: null,
      });
    });

    it('is carried by a block created after the choice', async () => {
      await putTrace('Reading', { trace: 'dotted' }).expect(204);

      expect((await postBlock('reading')).trace).toBe('dotted');
    });

    it('replaces an earlier choice, and choosing the name’s default clears it', async () => {
      await postBlock('Family');

      await putTrace('Family', { trace: 'grid' }).expect(204);
      await putTrace('Family', { trace: 'checker' }).expect(204);
      expect(await tracesOn('2026-09-24')).toEqual({ Family: 'checker' });

      // "family" hashes to solid in the app.
      await putTrace('Family', { trace: 'solid' }).expect(204);
      expect(await tracesOn('2026-09-24')).toEqual({ Family: null });
      const { rows } = await pool.query('SELECT 1 FROM block_name_traces');
      expect(rows).toHaveLength(0);
    });

    it('accepts a name with a slash in it', async () => {
      await postBlock('Work/Study');

      await putTrace('Work/Study', { trace: 'stipple' }).expect(204);

      expect(await tracesOn('2026-09-24')).toEqual({ 'Work/Study': 'stipple' });
    });

    it('keeps each user’s choices apart', async () => {
      const theirToken = await signIn('them@example.com');
      await postBlock('Family');

      await putTrace('Family', { trace: 'grid' }, theirToken).expect(204);

      expect(await tracesOn('2026-09-24')).toEqual({ Family: null });
    });

    it.each([
      ['open, which is never chosen', 'Family', { trace: 'open' }],
      ['an unknown trace', 'Family', { trace: 'plaid' }],
      ['no trace', 'Family', {}],
      ['an unknown field', 'Family', { trace: 'grid', colour: 'red' }],
      ['a blank name', '   ', { trace: 'grid' }],
      ['a name over 60 characters', 'x'.repeat(61), { trace: 'grid' }],
    ])('refuses %s', async (_, name, body) => {
      const res = await putTrace(name, body).expect(400);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'VALIDATION_FAILED',
      );
    });

    it('needs an access token', async () => {
      const res = await http()
        .put('/api/v1/block-names/Family/trace')
        .send({ trace: 'grid' })
        .expect(401);
      expect(res.body).toEqual({
        error: { code: 'TOKEN_INVALID', message: anyString },
      });
    });

    it('refuses the token of a deleted account', async () => {
      await http()
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const res = await putTrace('Family', { trace: 'grid' }).expect(401);
      expect((res.body as { error: { code: string } }).error.code).toBe(
        'TOKEN_INVALID',
      );
    });

    it('is removed with the account', async () => {
      await putTrace('Family', { trace: 'grid' }).expect(204);

      await http()
        .delete('/api/v1/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(204);

      const { rows } = await pool.query('SELECT 1 FROM block_name_traces');
      expect(rows).toHaveLength(0);
    });
  });
});
