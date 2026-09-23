import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { accessTokenInvalid } from '../auth/errors';
import { SessionsRepository } from '../auth/sessions.repository';
import { DB, type Db } from '../database/database.module';
import { toProfile, type Profile } from '../users/users.mapper';
import { UsersRepository } from '../users/users.repository';

@Injectable()
export class MeService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * The caller's `Profile`. It reads the session because
   * `Profile.signInMethod` belongs to the device, not the account. That read
   * also means a signed-out, revoked or expired session gets a 401 here at
   * once, even though the stateless guard let the token through.
   *
   * The two reads are not in a transaction. If `DELETE /me` lands between
   * them, the user read finds nothing, and that is a 401 too.
   */
  async get(caller: Caller): Promise<Profile> {
    const session = await this.sessions.findLiveById(this.db, caller.sessionId);
    if (session === null || session.userId !== caller.userId) {
      throw accessTokenInvalid();
    }

    const user = await this.users.findById(this.db, caller.userId);
    if (user === null) throw accessTokenInvalid();

    return toProfile(user, session.signInMethod);
  }
}
