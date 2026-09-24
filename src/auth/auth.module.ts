import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '../core/config/config.module';
import type { Env } from '../core/config/env.schema';
import { UsersModule } from '../users/users.module';
import { AccessTokensService } from './access-tokens.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { LogMailer } from './mailer/log-mailer';
import { MAILER } from './mailer/mailer';
import { SessionsRepository } from './sessions.repository';
import { SignInCodesRepository } from './sign-in-codes.repository';

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
    // Global: every route in the app needs an access token unless it is
    // `@Public()`. Registered here rather than in `AppModule` because it
    // depends on `AccessTokensService`, which lives here.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // For `/me`: every method reads the caller's session, and `DELETE /me`
  // removes the account's sign-in code row.
  exports: [SessionsRepository, SignInCodesRepository],
})
export class AuthModule {}
