#!/usr/bin/env node
/**
 * Read-only post-migration verifier for the Generate execution-snapshot gate.
 *
 * It deliberately runs in a READ ONLY transaction and never changes jobs,
 * migration state, credits, or worker configuration. A missing column or an
 * queued/running job without a snapshot returns exit code 2: the rollout must
 * remain on the legacy-safe side of the gate.
 *
 * Run from the @seed/db dependency context, for example:
 *   DATABASE_URL=... pnpm --filter @seed/db exec tsx \
 *     ../../scripts/execution-snapshot-readiness.ts
 */
import fs from 'node:fs';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('execution-snapshot-readiness: DATABASE_URL is required');
  process.exit(1);
}

const ssl = process.env.PGSSLROOTCERT
  ? {
      ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8'),
      rejectUnauthorized: true,
    }
  : process.env.PGSSLMODE === 'disable'
    ? false
    : undefined;

async function main(connectionString: string): Promise<number> {
  const pool = new Pool({
    connectionString,
    ...(ssl === undefined ? {} : { ssl }),
  });
  let exitCode = 0;
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '5000'");

      const columnResult = await client.query<{ present: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'jobs'
          AND column_name = 'execution_snapshot'
      ) AS present
    `);
      const columnPresent = columnResult.rows[0]?.present === true;

      if (!columnPresent) {
        console.log(
          JSON.stringify(
            {
              status: 'schema_missing',
              executionSnapshotColumn: false,
              ownerAction:
                'keep REQUIRE_EXECUTION_SNAPSHOT disabled; deploy reviewed migration first',
            },
            null,
            2,
          ),
        );
        exitCode = 2;
      } else {
        const totalsResult = await client.query<{
          total: number;
          snapshotted: number;
          snapshotless: number;
          active: number;
          activeSnapshotless: number;
          missingFinishedAt: number;
          oldestQueuedAt: string | null;
          newestQueuedAt: string | null;
        }>(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE execution_snapshot IS NOT NULL)::int AS snapshotted,
          count(*) FILTER (WHERE execution_snapshot IS NULL)::int AS snapshotless,
          count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active,
          count(*) FILTER (
            WHERE status IN ('queued', 'running') AND execution_snapshot IS NULL
          )::int AS "activeSnapshotless",
          count(*) FILTER (WHERE finished_at IS NULL)::int AS "missingFinishedAt",
          min(queued_at)::text AS "oldestQueuedAt",
          max(queued_at)::text AS "newestQueuedAt"
        FROM public.jobs
      `);
        const statusResult = await client.query<{
          status: string;
          rows: number;
          snapshotless: number;
          active: number;
          activeSnapshotless: number;
          missingFinishedAt: number;
        }>(`
        SELECT
          status::text AS status,
          count(*)::int AS rows,
          count(*) FILTER (WHERE execution_snapshot IS NULL)::int AS snapshotless,
          count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS active,
          count(*) FILTER (
            WHERE status IN ('queued', 'running') AND execution_snapshot IS NULL
          )::int AS "activeSnapshotless",
          count(*) FILTER (WHERE finished_at IS NULL)::int AS "missingFinishedAt"
        FROM public.jobs
        GROUP BY status
        ORDER BY status
      `);
        const totals = totalsResult.rows[0];
        const activeSnapshotless = totals?.activeSnapshotless ?? 0;

        console.log(
          JSON.stringify(
            {
              status: activeSnapshotless === 0 ? 'ready_for_owner_review' : 'active_legacy_rows',
              executionSnapshotColumn: true,
              totals,
              byStatus: statusResult.rows,
              ownerAction:
                activeSnapshotless === 0
                  ? 'review deployed commit/worker match and explicitly approve REQUIRE_EXECUTION_SNAPSHOT'
                  : 'reconcile queued/running snapshot-less jobs; keep REQUIRE_EXECUTION_SNAPSHOT disabled',
            },
            null,
            2,
          ),
        );
        if (activeSnapshotless > 0) exitCode = 2;
      }

      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  } catch (error) {
    console.error(
      `execution-snapshot-readiness: ${error instanceof Error ? error.message : String(error)}`,
    );
    exitCode = 1;
  } finally {
    await pool.end();
  }
  return exitCode;
}

if (databaseUrl) {
  main(databaseUrl)
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        `execution-snapshot-readiness: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
