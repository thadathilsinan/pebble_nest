import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envSchema, type Env } from './env.schema';

/** Injection token for the validated environment. Inject it to receive `Env`. */
export const ENV = Symbol('ENV');

@Global()
@Module({
  imports: [
    // Reads the env files into `process.env`, then fails the boot if the result
    // does not satisfy the schema. Both happen before any provider is constructed.
    //
    // `validate` returns the raw strings, not the parsed result, because what it
    // returns is what `@nestjs/config` copies from the env files into
    // `process.env` — and it copies only strings, numbers and booleans. A parsed
    // value that is anything else, like `CORS_ORIGINS` as an array, would be
    // dropped silently, and `ENV` below would then parse its default instead.
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
      validate: (raw) => {
        envSchema.parse(raw);
        return raw;
      },
    }),
  ],
  providers: [
    {
      provide: ENV,
      useFactory: (): Env => envSchema.parse(process.env),
    },
  ],
  exports: [ENV],
})
export class AppConfigModule {}
