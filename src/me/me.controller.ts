import { Body, Controller, Get, Patch } from '@nestjs/common';
import type { Caller } from '../auth/caller';
import { CurrentCaller } from '../auth/current-caller.decorator';
import { UpdateProfileBody } from './dto/update-profile.dto';
import { MeService } from './me.service';

@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  get(@CurrentCaller() caller: Caller) {
    return this.me.get(caller);
  }

  @Patch()
  update(@CurrentCaller() caller: Caller, @Body() body: UpdateProfileBody) {
    return this.me.update(caller, body);
  }
}
