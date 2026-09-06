import 'dotenv/config';
import { pool } from '../src/index';

/**
 * Idempotently translates the legacy gallery_items.folder string into the
 * project-scoped placement layer. Assets without a project stay untouched:
 * they must be adopted explicitly before they can appear on a desk.
 */
const client = await pool.connect();
try {
  await client.query('BEGIN');
  const folders = await client.query<{ count: string }>(`
    WITH legacy AS (
      SELECT DISTINCT g.origin_project_id AS project_id, g.user_id, btrim(g.folder) AS name
      FROM gallery_items g
      JOIN projects p ON p.id = g.origin_project_id AND p.user_id = g.user_id
      WHERE g.origin_project_id IS NOT NULL AND nullif(btrim(g.folder), '') IS NOT NULL
    ), inserted AS (
      INSERT INTO folders (id, project_id, user_id, name, ord)
      SELECT
        'legacy-folder:' || md5(project_id || ':' || name),
        project_id,
        user_id,
        name,
        row_number() OVER (PARTITION BY project_id ORDER BY name) - 1
      FROM legacy
      ON CONFLICT (project_id, name) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::text AS count FROM inserted
  `);
  const placements = await client.query<{ count: string }>(`
    WITH inserted AS (
      INSERT INTO asset_placements (asset_id, folder_id)
      SELECT g.id, f.id
      FROM gallery_items g
      JOIN folders f
        ON f.project_id = g.origin_project_id
       AND f.user_id = g.user_id
       AND f.name = btrim(g.folder)
      WHERE g.origin_project_id IS NOT NULL AND nullif(btrim(g.folder), '') IS NOT NULL
      ON CONFLICT (asset_id, folder_id) DO NOTHING
      RETURNING asset_id
    )
    SELECT count(*)::text AS count FROM inserted
  `);
  const leases = await client.query<{ count: string }>(`
    WITH placed AS (
      SELECT DISTINCT ap.asset_id, g.user_id
      FROM asset_placements ap
      JOIN gallery_items g ON g.id = ap.asset_id
    ), inserted AS (
      INSERT INTO asset_references (id, gallery_item_id, user_id, ref_type, ref_id)
      SELECT 'legacy-keep:' || asset_id, asset_id, user_id, 'keep', 'folder-placement'
      FROM placed
      ON CONFLICT (gallery_item_id, ref_type, ref_id) DO NOTHING
      RETURNING id
    )
    SELECT count(*)::text AS count FROM inserted
  `);
  await client.query('COMMIT');
  console.log(
    `asset placement backfill: ${folders.rows[0]?.count ?? '0'} folders, ` +
      `${placements.rows[0]?.count ?? '0'} placements, ${leases.rows[0]?.count ?? '0'} leases`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  client.release();
  await pool.end();
}
