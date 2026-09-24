import { Inject, Injectable } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { accessTokenInvalid } from '../auth/errors';
import { DB, type Db } from '../core/database/database.module';
import type { ChosenTrace } from '../core/database/schema';
import { UsersRepository } from '../users/users.repository';
import { defaultTrace, normaliseBlockName } from './block-name';
import { BlockNamesRepository } from './block-names.repository';

/** BLK-02: the most names the block slip offers. */
const MAX_SUGGESTIONS = 6;

@Injectable()
export class BlockNamesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly names: BlockNamesRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * Names used before that the slip offers while `q` is typed (BLK-02), most
   * recently used first, as the app's `nameSuggestions` does: matched ignoring
   * capitals and surrounding spaces, anywhere in the name, leaving out the
   * name `q` already is. A blank `q` offers the most recent names.
   *
   * It does not read the session (decision 16).
   */
  async suggest(caller: Caller, q: string): Promise<string[]> {
    const typed = normaliseBlockName(q);
    const seen = new Set<string>();
    const out: string[] = [];

    for (const name of await this.names.findNamesByRecentUse(
      this.db,
      caller.userId,
    )) {
      // The database already gave one spelling per name. Checking again with
      // JavaScript's lower-casing keeps one per name as the app counts them.
      const key = normaliseBlockName(name);
      if (seen.has(key)) continue;
      seen.add(key);
      if (typed !== '' && (key === typed || !key.includes(typed))) continue;
      out.push(name);
      if (out.length === MAX_SUGGESTIONS) break;
    }
    return out;
  }

  /**
   * Records the trace every block named `nameKey` is drawn in, past and
   * future. Choosing the trace the name hashes to clears the choice, as the
   * app's `chooseTraceForName` does. Last write wins.
   *
   * A token whose account is gone gets `401 TOKEN_INVALID`, as a create does.
   * It does not read the session (decision 16).
   */
  async setTrace(
    caller: Caller,
    nameKey: string,
    trace: ChosenTrace,
  ): Promise<void> {
    if ((await this.users.findById(this.db, caller.userId)) === null) {
      throw accessTokenInvalid();
    }

    if (trace === defaultTrace(nameKey)) {
      await this.names.clearTrace(this.db, caller.userId, nameKey);
    } else {
      await this.names.setTrace(this.db, caller.userId, nameKey, trace);
    }
  }
}
