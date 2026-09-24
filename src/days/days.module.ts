import { Module } from '@nestjs/common';
import { BlockNamesModule } from '../block-names/block-names.module';
import { BlockOccurrencesModule } from '../block-occurrences/block-occurrences.module';
import { BlocksModule } from '../blocks/blocks.module';
import { TasksModule } from '../tasks/tasks.module';
import { DaysController } from './days.controller';
import { DaysService } from './days.service';

/**
 * The timeline (`docs/api-plan.md` §3): a day's blocks and general list. It
 * owns no table; it reads the other features' and lays them out by date.
 */
@Module({
  imports: [
    BlocksModule,
    BlockNamesModule,
    BlockOccurrencesModule,
    TasksModule,
  ],
  controllers: [DaysController],
  providers: [DaysService],
  // `NotificationsModule` finds block alerts in the days it lays out.
  exports: [DaysService],
})
export class DaysModule {}
