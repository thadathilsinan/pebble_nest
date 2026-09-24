import {
  BadRequestException,
  ConflictException,
  type ArgumentsHost,
} from '@nestjs/common';
import type { PinoLogger } from 'nestjs-pino';
import { AllExceptionsFilter } from './all-exceptions.filter';
import type { ApiFailure } from './envelope';

/** Runs one exception through the filter and returns the body it rendered. */
function render(exception: unknown): ApiFailure {
  const logger = {
    setContext: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as PinoLogger;
  const filter = new AllExceptionsFilter(logger);

  let body: unknown;
  const response = {
    headersSent: false,
    setHeader: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn((value: unknown) => {
      body = value;
    }),
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ headers: {} }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  filter.catch(exception, host);

  return body as ApiFailure;
}

describe('AllExceptionsFilter meta', () => {
  it('passes scalar meta through', () => {
    const body = render(
      new BadRequestException({
        code: 'CODE_INVALID',
        message: 'Wrong code.',
        meta: { attemptsLeft: 2, nested: { no: true } },
      }),
    );

    expect(body.error.meta).toEqual({ attemptsLeft: 2 });
  });

  it('passes meta.current through on STALE_VERSION', () => {
    const current = { id: 'u1', version: 3, name: 'Sinan' };

    const body = render(
      new ConflictException({
        code: 'STALE_VERSION',
        message: 'Stale.',
        meta: { current },
      }),
    );

    expect(body.error).toEqual({
      code: 'STALE_VERSION',
      message: 'Stale.',
      meta: { current },
    });
  });

  it('drops an object under current on any other code', () => {
    const body = render(
      new ConflictException({
        code: 'CONFLICT',
        message: 'Nope.',
        meta: { current: { id: 'u1' } },
      }),
    );

    expect(body.error.meta).toBeUndefined();
  });

  it('drops any other object key on STALE_VERSION', () => {
    const body = render(
      new ConflictException({
        code: 'STALE_VERSION',
        message: 'Stale.',
        meta: { current: { id: 'u1' }, row: { secret: 'x' } },
      }),
    );

    expect(body.error.meta).toEqual({ current: { id: 'u1' } });
  });
});
