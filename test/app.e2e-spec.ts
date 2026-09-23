import { Test, TestingModule } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/bootstrap/configure-app';
import { ENV } from './../src/config/config.module';
import type { Env } from './../src/config/env.schema';

describe('AppController (e2e)', () => {
  let app: NestExpressApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    // These three lines mirror `main.ts`, and the mirroring is the point:
    // nothing here executes `main.ts`, so anything applied only there is absent
    // under test. That is not hypothetical — before this, the spec asserted
    // `GET /` while the running service answered 404 there and served
    // `/api/v1`, and it passed.
    //
    // `bodyParser: false` matters for the same reason it does in production:
    // without it Nest registers its own parsers first and the ones in
    // `configureApp` never see a request. `configureApp` runs before `init()`
    // because that is when routes are registered.
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app, moduleFixture.get<Env>(ENV));
    await app.init();
  });

  // The path is written out rather than built from `API_PREFIX` and
  // `DEFAULT_VERSION`. Deriving it from the same constants the implementation
  // uses would make this assertion tautological — both sides would move
  // together and it would pass for any prefix. The URL is the client contract,
  // so changing it should turn this red.
  it('/api/v1 (GET)', () => {
    // The handler returns a bare string; the envelope is what wraps it. The
    // request id is a header only, so the body stays byte-stable.
    return request(app.getHttpServer() as App)
      .get('/api/v1')
      .expect(200)
      .expect('X-Request-Id', /./)
      .expect({ data: 'Hello World!' });
  });

  afterEach(async () => {
    await app.close();
  });
});
