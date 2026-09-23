import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from 'nestjs-pino';
import pino from 'pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap/configure-app';
import { ENV } from './config/config.module';
import type { Env } from './config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffered so the lines Nest writes while it builds the module graph are held
    // until pino exists, rather than escaping as unstructured text. Without this
    // the first several lines of every boot are the only ones an aggregator
    // cannot parse.
    bufferLogs: true,
    // Suppresses the `json` and `urlencoded` parsers Nest would otherwise
    // register here, so the ones in `configureApp` are the only ones. Not
    // tidiness: body-parser marks a request once it has consumed the stream and
    // every later parser skips it, so Nest's would do the parsing and ours would
    // be dead code — a limit that reads as configured and enforces nothing.
    bodyParser: false,
  });

  // Replaces Nest's own logger, so route mapping, shutdown notices and anything
  // logged through `@nestjs/common`'s `Logger` become JSON too.
  app.useLogger(app.get(Logger));
  app.flushLogs();

  const env = app.get<Env>(ENV);

  // A separate function rather than statements here, because an e2e builds its
  // app without ever running this file and must apply the same setup.
  configureApp(app, env);

  // Makes SIGTERM run Nest's shutdown sequence — close the HTTP server, then
  // call every `onModuleDestroy` — instead of killing the process outright. That
  // is what gives `DatabaseModule` the chance to drain its pool, and the
  // ordering matters: no new request can arrive by the time connections are
  // being closed.
  //
  // Here rather than in `configureApp`, which is otherwise the rule for anything
  // an e2e must mirror. Two reasons it is the exception. Nest already runs
  // `onModuleDestroy` on `app.close()`, which is what a test does, so a test
  // gains nothing from it. And it registers process-level signal listeners —
  // one set per application instance, which across a suite that builds an app
  // per test accumulates into Node's max-listeners warning.
  app.enableShutdownHooks();

  await app.listen(env.PORT);
}

bootstrap().catch((error) => {
  // The app never came up, so its configured logger does not exist. A bare pino
  // instance keeps even this line structured — it is the one line you cannot
  // afford to have to eyeball in a crash loop.
  pino().fatal({ err: error }, 'bootstrap failed');

  process.exit(1);
});
