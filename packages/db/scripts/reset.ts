import 'dotenv/config';
import { pool } from '../src/index';

if (process.env.NODE_ENV === 'production') {
  console.error('reset: refusing to run in production');
  process.exit(1);
}

await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
console.log('reset: schema dropped + recreated');
await pool.end();
