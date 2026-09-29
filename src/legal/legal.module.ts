import { Module } from '@nestjs/common';
import { LegalController } from './legal.controller';

/** The public legal pages. Static content, so no providers. */
@Module({
  controllers: [LegalController],
})
export class LegalModule {}
