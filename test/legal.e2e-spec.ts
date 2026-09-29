import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/core/bootstrap/configure-app';
import { ENV } from '../src/core/config/config.module';
import type { Env } from '../src/core/config/env.schema';

describe('Legal pages (e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // Mirrors `main.ts`; see the note in auth.e2e-spec.ts.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  function http() {
    return request(app.getHttpServer());
  }

  it('serves the privacy policy as HTML, unenveloped and without a token', async () => {
    const res = await http()
      .get('/legal/privacy')
      .expect(200)
      .expect('Content-Type', /^text\/html; charset=utf-8/);

    expect(res.text).toMatch(/^<!doctype html>/);
    expect(res.text).toContain('PRIVACY POLICY');
  });

  it('is not under the API prefix or version', async () => {
    await http().get('/api/v1/legal/privacy').expect(404);
    await http().get('/v1/legal/privacy').expect(404);
  });
});
