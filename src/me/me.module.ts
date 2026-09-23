import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MeController } from './me.controller';
import { MeService } from './me.service';

/**
 * The signed-in caller's own account (`/me`, `docs/api-plan.md` §2). It is
 * separate from `UsersModule` because it needs `AuthModule`'s sessions, and
 * `AuthModule` already imports `UsersModule`.
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [MeController],
  providers: [MeService],
})
export class MeModule {}
