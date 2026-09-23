import { HttpException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env.schema';
import { AccessTokensService } from './access-tokens.service';
import { AuthGuard } from './auth.guard';
import type { CallerRequest } from './caller';
import { IS_PUBLIC } from './public.decorator';

const SECRET = 's'.repeat(32);

// The same options `AuthModule` registers.
const jwt = new JwtService({
  secret: SECRET,
  signOptions: { algorithm: 'HS256' },
  verifyOptions: { algorithms: ['HS256'] },
});
const accessTokens = new AccessTokensService(jwt, {
  ACCESS_TOKEN_TTL_SECONDS: 900,
} as Env);

function contextFor(
  authorization: string | undefined,
  isPublic = false,
): { context: ExecutionContext; request: CallerRequest } {
  const request = { headers: { authorization } } as CallerRequest;
  const handler = () => undefined;
  if (isPublic) Reflect.defineMetadata(IS_PUBLIC, true, handler);
  const context = {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  expect(http.getStatus()).toBe(401);
  return http.getResponse();
}

describe('AuthGuard', () => {
  const guard = new AuthGuard(new Reflector(), accessTokens);

  it('attaches the caller for a valid bearer token', async () => {
    const { token } = await accessTokens.issue('user-1', 'session-1');
    const { context, request } = contextFor(`Bearer ${token}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.caller).toEqual({
      userId: 'user-1',
      sessionId: 'session-1',
    });
  });

  it('lets a public route through with no token', async () => {
    const { context, request } = contextFor(undefined, true);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.caller).toBeUndefined();
  });

  it.each([
    ['no header', undefined],
    ['an empty bearer', 'Bearer '],
    ['another scheme', 'Basic dXNlcjpwYXNz'],
    ['a token that is not a JWT', 'Bearer not-a-jwt'],
  ])('refuses %s with TOKEN_INVALID', async (_, header) => {
    await expect(
      rejection(guard.canActivate(contextFor(header).context)),
    ).resolves.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('refuses an expired token', async () => {
    const token = await jwt.signAsync(
      { sid: 'session-1', exp: Math.floor(Date.now() / 1000) - 1 },
      { subject: 'user-1' },
    );

    await rejection(guard.canActivate(contextFor(`Bearer ${token}`).context));
  });

  it('refuses a token signed with another secret', async () => {
    const token = await jwt.signAsync(
      { sid: 'session-1' },
      { subject: 'user-1', expiresIn: 60, secret: 'o'.repeat(32) },
    );

    await rejection(guard.canActivate(contextFor(`Bearer ${token}`).context));
  });

  it('refuses a token signed with another algorithm, even with the right secret', async () => {
    const token = await jwt.signAsync(
      { sid: 'session-1' },
      { subject: 'user-1', expiresIn: 60, algorithm: 'HS512' },
    );

    await rejection(guard.canActivate(contextFor(`Bearer ${token}`).context));
  });

  it('refuses a correctly signed token without the claims issue() writes', async () => {
    const noSid = await jwt.signAsync({}, { subject: 'user-1', expiresIn: 60 });
    const noExp = await jwt.signAsync(
      { sid: 'session-1' },
      { subject: 'user-1' },
    );

    await rejection(guard.canActivate(contextFor(`Bearer ${noSid}`).context));
    await rejection(guard.canActivate(contextFor(`Bearer ${noExp}`).context));
  });
});
