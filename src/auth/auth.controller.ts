import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './public.decorator';
import { RefreshSessionBody } from './dto/refresh-session.dto';
import { RequestSignInCodeBody } from './dto/request-sign-in-code.dto';
import { SignOutBody } from './dto/sign-out.dto';
import { VerifySignInCodeBody } from './dto/verify-sign-in-code.dto';

// Public: every route here is how a client gets a token in the first place.
@Public()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('email/code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async requestCode(@Body() body: RequestSignInCodeBody): Promise<void> {
    await this.auth.requestCode(body);
  }

  // 200, not the 201 a POST defaults to: signing in returns a session, it does
  // not create a resource the client can address.
  @Post('email/verify')
  @HttpCode(HttpStatus.OK)
  verifyCode(@Body() body: VerifySignInCodeBody) {
    return this.auth.verifyCode(body);
  }

  // 200 for the same reason as verify: a new session state, not a resource.
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() body: RefreshSessionBody) {
    return this.auth.refresh(body);
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  async signOut(@Body() body: SignOutBody): Promise<void> {
    await this.auth.signOut(body);
  }
}
