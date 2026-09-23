import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/**
 * The probes. No providers: the pool arrives through `DatabaseModule`'s
 * `@Global()` export, and the checks are cheap enough that putting them behind a
 * service would add a layer that only forwards.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
