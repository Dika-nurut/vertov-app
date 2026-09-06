import 'dotenv/config';
import type { Config } from 'drizzle-kit';

export default {
  schema: './schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://seed:seed@127.0.0.1:5434/seed',
  },
  strict: true,
  verbose: true,
} satisfies Config;
