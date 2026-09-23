import { Controller, Get } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentCaller() caller: Caller) {
    return this.me.get(caller);
  }
}
