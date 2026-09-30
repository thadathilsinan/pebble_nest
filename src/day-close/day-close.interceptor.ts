import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type CustomDecorator,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, switchMap, type Observable } from 'rxjs';
import type { CallerRequest } from '../auth/caller';
import { addDays, todayIn } from '../calendar/local-date';
import { DayCloseService } from '../tasks/day-close.service';
import { ClosedDaysCache } from './closed-days-cache';

const SKIP_DAY_CLOSE = 'dayClose:skip';

/**
 * Opts a handler out of the day-end close, where settling the user's days
 * first would be wasted: `DELETE /me` is about to remove them all.
 */
export const SkipDayClose = (): CustomDecorator =>
  SetMetadata(SKIP_DAY_CLOSE, true);

/**
 * Runs the day-end close before every signed-in request (decision 38), so
 * the handler, read or write, sees every closed day already settled.
 *
 * A user whose days are closed through yesterday, as last seen here, costs
 * no database read. Otherwise the close runs, in its own transaction, and
 * commits before the handler starts; a failure fails the request rather
 * than serving days left unsettled. A `@Public()` route has no caller and
 * is passed straight through.
 */
@Injectable()
export class DayCloseInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly dayClose: DayCloseService,
    private readonly cache: ClosedDaysCache,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const caller = context.switchToHttp().getRequest<CallerRequest>().caller;
    const skip = this.reflector.getAllAndOverride<boolean | undefined>(
      SKIP_DAY_CLOSE,
      [context.getHandler(), context.getClass()],
    );
    if (caller === undefined || skip === true) return next.handle();

    return from(this.closeFor(caller.userId)).pipe(
      switchMap(() => next.handle()),
    );
  }

  private async closeFor(userId: string): Promise<void> {
    const seen = this.cache.get(userId);
    if (
      seen !== undefined &&
      seen.closedThrough >= addDays(todayIn(seen.timeZone), -1)
    ) {
      return;
    }

    const state = await this.dayClose.close(userId);
    // A gone account is the handler's to refuse.
    if (state === null) this.cache.delete(userId);
    else this.cache.set(userId, state);
  }
}
