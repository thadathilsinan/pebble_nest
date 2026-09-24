import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { localDate } from '../../calendar/local-date';

/** `GET /days/{date}`. */
export class DayDateParams extends createZodDto(
  z.object({ date: localDate }),
) {}
