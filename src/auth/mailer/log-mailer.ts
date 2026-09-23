import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { Mailer } from './mailer';

/**
 * Sends nothing: it writes the code to the log so sign-in works locally before
 * an email provider exists (api-plan §13).
 *
 * This is the one place that deliberately logs a request value, against
 * `docs/adding-a-feature.md` §8 — showing the code is the whole job. That is
 * why `env.schema.ts` refuses `MAILER=log` in production.
 */
@Injectable()
export class LogMailer implements Mailer {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(LogMailer.name);
  }

  sendSignInCode(email: string, code: string): Promise<void> {
    this.logger.info(
      { email, code },
      'sign-in code (log mailer: no email sent)',
    );

    return Promise.resolve();
  }
}
