import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describeDriverError, uniqueViolation } from './driver-error';

/** What `pg` throws for a statement the server rejected, reduced to its fields. */
function pgError(code: string, constraint?: string): Error {
  return Object.assign(new Error('rejected'), {
    code,
    severity: 'ERROR',
    constraint,
  });
}

/** What Drizzle rethrows it as. */
function wrapped(cause: unknown): DrizzleQueryError {
  return new DrizzleQueryError('insert into "t" ...', [], cause as Error);
}

describe('describeDriverError', () => {
  it('maps a bare pg error', () => {
    expect(describeDriverError(pgError('23503'))).toMatchObject({
      status: 409,
      code: 'CONFLICT',
      context: { sqlstate: '23503' },
    });
  });

  it('reads the SQLSTATE through a DrizzleQueryError', () => {
    expect(describeDriverError(wrapped(pgError('23514')))).toMatchObject({
      status: 422,
      code: 'UNPROCESSABLE_ENTITY',
      context: { sqlstate: '23514' },
    });
  });

  it('reads a connection failure through a DrizzleQueryError', () => {
    const refused = Object.assign(new Error('connect'), {
      code: 'ECONNREFUSED',
    });

    expect(describeDriverError(wrapped(refused))).toMatchObject({
      status: 503,
      context: { driverCode: 'ECONNREFUSED' },
    });
  });

  it('leaves a wrapper with no driver error inside unmapped', () => {
    expect(describeDriverError(wrapped(new Error('other')))).toBeUndefined();
    expect(describeDriverError(new Error('plain'))).toBeUndefined();
  });
});

describe('uniqueViolation', () => {
  it('names the constraint through a DrizzleQueryError', () => {
    expect(uniqueViolation(wrapped(pgError('23505', 'uq_x')))).toEqual({
      constraint: 'uq_x',
    });
  });

  it('is undefined for other SQLSTATEs', () => {
    expect(uniqueViolation(wrapped(pgError('23503')))).toBeUndefined();
  });
});
