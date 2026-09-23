import { Test, type TestingModule } from '@nestjs/testing';
import type { Pool } from 'pg';
import { AppConfigModule } from '../config/config.module';
import { LoggingModule } from '../logging/logging.module';
import { DatabaseModule, DB, POOL, type Db } from './database.module';

/**
 * A real database for a repository spec: the same pool and Drizzle instance
 * the app builds, against the `DATABASE_URL` the app would use.
 *
 * Isolation is decision 9 in `docs/database-decisions.md`: each spec
 * truncates the tables it touches before every test, and jest runs files one
 * at a time (`--runInBand`) so two specs never interleave on one database.
 */
export interface TestDatabase {
  db: Db;
  pool: Pool;
  /** Empties the named tables, following foreign keys. Names are constants. */
  truncate(...tables: string[]): Promise<void>;
  close(): Promise<void>;
}

export async function openTestDatabase(): Promise<TestDatabase> {
  const module: TestingModule = await Test.createTestingModule({
    imports: [AppConfigModule, LoggingModule, DatabaseModule],
  }).compile();

  const pool = module.get<Pool>(POOL);

  return {
    db: module.get<Db>(DB),
    pool,
    truncate: async (...tables) => {
      await pool.query(
        `TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`,
      );
    },
    close: () => module.close(),
  };
}
