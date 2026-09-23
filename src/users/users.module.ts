import { Module } from '@nestjs/common';
import { UsersRepository } from './users.repository';

/**
 * The account table's repository, exported for sign-in. No controller yet:
 * `GET /me` and `PATCH /me` arrive in a later slice.
 */
@Module({
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
