import { Module } from '@nestjs/common';
import { BlocksModule } from '../blocks/blocks.module';
import { DaysController } from './days.controller';
import { DaysService } from './days.service';

/**
 * The timeline (`docs/api-plan.md` §3): a day's blocks and general list. It
 * owns no table; it reads the other features' and lays them out by date.
 */
@Module({
  imports: [BlocksModule],
  controllers: [DaysController],
  providers: [DaysService],
})
export class DaysModule {}
