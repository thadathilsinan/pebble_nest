import { Module } from '@nestjs/common';
import { BlockNamesModule } from '../block-names/block-names.module';
import { BlocksModule } from '../blocks/blocks.module';
import { TasksModule } from '../tasks/tasks.module';
import { UsersModule } from '../users/users.module';
import { BlockOccurrencesController } from './block-occurrences.controller';
import { BlockOccurrencesRepository } from './block-occurrences.repository';
import { BlockOccurrencesService } from './block-occurrences.service';

/**
 * One occurrence of a block series (`docs/api-plan.md` §4): editing,
 * skipping and deleting it. Its own module rather than part of `BlocksModule`, because it moves
 * tasks, and `TasksModule` already imports `BlocksModule`.
 */
@Module({
  // Each occurrence an edit returns carries the trace chosen for its name.
  imports: [BlockNamesModule, BlocksModule, TasksModule, UsersModule],
  controllers: [BlockOccurrencesController],
  providers: [BlockOccurrencesService, BlockOccurrencesRepository],
  // `DaysModule` marks skipped occurrences on the timeline and leaves out
  // deleted ones.
  exports: [BlockOccurrencesRepository],
})
export class BlockOccurrencesModule {}
