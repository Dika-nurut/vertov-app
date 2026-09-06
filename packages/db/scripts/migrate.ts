import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from '../src/index';

await migrate(db, { migrationsFolder: './migrations' });

// Apply table comment for 152-ФЗ marker.
await pool.query(`COMMENT ON TABLE users_pii IS 'RU-PII — 152-ФЗ split target.'`);

console.log('migrate: OK');
await pool.end();
