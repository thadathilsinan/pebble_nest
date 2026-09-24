import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { BlockNamesController } from './block-names.controller';
import { BlockNamesRepository } from './block-names.repository';
import { BlockNamesService } from './block-names.service';

/**
 * Block names (`docs/api-plan.md` §4): the names offered while typing
 * (BLK-02), and the trace chosen for each name.
 */
@Module({
  imports: [UsersModule],
  controllers: [BlockNamesController],
  providers: [BlockNamesService, BlockNamesRepository],
  // Blocks and days put the chosen trace on each occurrence.
  exports: [BlockNamesRepository],
})
export class BlockNamesModule {}
