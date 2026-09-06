import 'dotenv/config';
import { pool } from '@seed/db';
import { backfillCreditBuckets, reconcileUnbucketedGrantLegs } from '../src/index';

try {
  try {
    const backfill = await backfillCreditBuckets();
    const unbucketedGrantLegs = await reconcileUnbucketedGrantLegs();
    console.log(
      JSON.stringify(
        {
          backfill,
          reconciler: {
            unbucketedGrantLegCount: unbucketedGrantLegs.length,
            unbucketedGrantLegs,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
