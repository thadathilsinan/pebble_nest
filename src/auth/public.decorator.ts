import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'isPublic';

/**
 * Lets a controller or a handler through `AuthGuard` without an access token.
 * Every other route needs one, so forgetting this fails closed.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
