import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '../core/config/config.module';
import type { Env } from '../core/config/env.schema';
import { UsersModule } from '../users/users.module';
import { AccessTokensService } from './access-tokens.service';
import { AppleGrantsRepository } from './apple/apple-grants.repository';
import { APPLE_ID_TOKENS, appleIdTokens } from './apple/apple-id-tokens';
import { AppleTokenEndpoint } from './apple/apple-token-endpoint';
import { APPLE_TOKENS, type AppleTokens } from './apple/apple-tokens';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { GOOGLE_ID_TOKENS, googleIdTokens } from './google/google-id-tokens';
import { LogMailer } from './mailer/log-mailer';
import { MAILER } from './mailer/mailer';
import { SessionsRepository } from './sessions.repository';
import { SignInCodesRepository } from './sign-in-codes.repository';

/**
 * Apple's token endpoint while the Apple settings are unset. Sign-in never
 * reaches it, since it answers 503 first; a revoke for a grant stored while
 * Apple was set up fails, and `DELETE /me` logs that.
 */
const appleNotSetUp: AppleTokens = {
  exchange: () =>
    Promise.resolve({ outcome: 'unavailable', reason: 'Apple is not set up' }),
  revoke: () => Promise.reject(new Error('Apple is not set up')),
};

@Module({
  imports: [
    UsersModule,
    JwtModule.registerAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        secret: env.JWT_SECRET,
        // Verification pins the algorithm as well: a verifier that accepts
        // whatever `alg` the token names is the classic JWT forgery.
        signOptions: { algorithm: 'HS256' },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokensService,
    SignInCodesRepository,
    SessionsRepository,
    // `MAILER=log` is the only value env.schema.ts accepts today. A real
    // provider becomes a `useFactory` switching on `env.MAILER`.
    { provide: MAILER, useClass: LogMailer },
    // One instance for the process, so Google's keys are fetched once and
    // shared by every request.
    {
      provide: GOOGLE_ID_TOKENS,
      inject: [ENV],
      useFactory: (env: Env) => googleIdTokens(env.GOOGLE_CLIENT_IDS),
    },
    // One instance for the same reason: Apple's keys are fetched once.
    {
      provide: APPLE_ID_TOKENS,
      inject: [ENV],
      useFactory: (env: Env) => appleIdTokens(env.APPLE_CLIENT_IDS),
    },
    {
      provide: APPLE_TOKENS,
      inject: [ENV],
      useFactory: (env: Env): AppleTokens =>
        env.APPLE_CLIENT_IDS.length === 0
          ? appleNotSetUp
          : new AppleTokenEndpoint({
              teamId: env.APPLE_TEAM_ID,
              keyId: env.APPLE_KEY_ID,
              privateKey: env.APPLE_PRIVATE_KEY,
            }),
    },
    AppleGrantsRepository,
    // Global: every route in the app needs an access token unless it is
    // `@Public()`. Registered here rather than in `AppModule` because it
    // depends on `AccessTokensService`, which lives here.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // For `/me`: every method reads the caller's session, and `DELETE /me`
  // removes the account's sign-in code row and revokes its Apple grant.
  exports: [
    SessionsRepository,
    SignInCodesRepository,
    AppleGrantsRepository,
    APPLE_TOKENS,
  ],
})
export class AuthModule {}
