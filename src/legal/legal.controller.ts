import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller, Get, Header, VERSION_NEUTRAL } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { NoEnvelope } from '../core/http/response.interceptor';

/** Base path for the legal pages. */
export const LEGAL_PATH = 'legal';

/**
 * The legal routes as `setGlobalPrefix`'s `exclude` wants them, exported for the
 * same reason as `HEALTH_ROUTES`: one list of strings, so the exclusion cannot
 * drift from the routes it exempts.
 */
export const LEGAL_ROUTES = [`${LEGAL_PATH}/privacy`, `${LEGAL_PATH}/terms`];

/**
 * Relative to the working directory, which is the repo root locally and under
 * test, and `/app` in the image. `nest build` compiles only TypeScript, so these
 * files live outside `src/` and the Dockerfile copies `public/` alongside
 * `dist/`.
 */
const PAGES_DIR = join(process.cwd(), 'public', LEGAL_PATH);

/** Reads one page from `PAGES_DIR`. */
function readPage(file: string): string {
  return readFileSync(join(PAGES_DIR, file), 'utf8');
}

/**
 * The privacy policy and terms of service, served as HTML at URLs outside
 * `/api/v1`.
 *
 * Outside the API because these URLs are printed in places that cannot be edited
 * on a deploy: App Store and Play listings, and the Google and Apple sign-in
 * consent screens. Bumping the API version must not move them — which, as with
 * the health probes, takes both the prefix exclusion and `VERSION_NEUTRAL`.
 *
 * Read once at construction rather than per request: the content only changes
 * with a deploy, and a missing file then fails the boot instead of the first
 * reviewer who clicks the link.
 */
@Public()
@NoEnvelope()
@Controller({ path: LEGAL_PATH, version: VERSION_NEUTRAL })
export class LegalController {
  private readonly privacyHtml = readPage('privacy.html');
  private readonly termsHtml = readPage('terms.html');

  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  privacy(): string {
    return this.privacyHtml;
  }

  @Get('terms')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'public, max-age=3600')
  terms(): string {
    return this.termsHtml;
  }
}
