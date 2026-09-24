import { Controller, Get, Query } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { ReviewQuery } from './dto/review-query.dto';
import { ReviewService } from './review.service';

@Controller('review')
export class ReviewController {
  constructor(private readonly review: ReviewService) {}

  @Get()
  get(@CurrentCaller() caller: Caller, @Query() query: ReviewQuery) {
    return this.review.review(caller, query.from, query.to);
  }
}
