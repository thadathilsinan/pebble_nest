import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository';

/**
 * The account table's repository, exported for sign-in and for `/me`. The
 * `/me` endpoints live in `MeModule`, since they also read the session, and
 * `AuthModule` (which owns sessions) already imports this module.
 */
@Module({
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
