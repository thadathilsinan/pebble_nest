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
    ConfigModule.forRoot({
      envFilePath: ['.env.local', '.env'],
      validate: (raw) => envSchema.parse(raw),
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
