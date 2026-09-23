import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { UsersModule } from '../users/users.module';
import { AccessTokensService } from './access-tokens.service';
import { AuthController } from './auth.controller';
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
        // Pinned so verification (arriving with the auth guard) can pin it
        // too; a verifier that accepts whatever `alg` the token names is the
        // classic JWT forgery.
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
  ],
})
export class AuthModule {}
