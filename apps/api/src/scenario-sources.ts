import { and, eq, inArray } from 'drizzle-orm';
import { db, scripts, scriptSceneTimings, scriptShotPlans } from '@seed/db';
import { scenarioFormatSchema, scenarioOutlineV1Schema } from '@seed/shared';
import { extractScenarioHandoffSources } from './scenario-board-handoff';

/**
 * The scenes of a script as timing, planning and the board see them. A
 * short-form script that already saved timings or shot plans under its beat
 * ids keeps its beats as the source, so that saved work stays reachable; every
 * other script reads its scenes from the sheet.
 */
export async function loadScenarioSources(
  script: Pick<typeof scripts.$inferSelect, 'id' | 'format' | 'outline' | 'fountain'>,
) {
  const format = scenarioFormatSchema.parse(script.format);
  const outline = scenarioOutlineV1Schema.parse(script.outline);
  const beatIds = outline.beats.map((beat) => beat.id);
  let keepBeatSources = false;
  if (format !== 'film' && beatIds.length > 0) {
    const [timing] = await db
      .select({ id: scriptSceneTimings.id })
      .from(scriptSceneTimings)
      .where(
        and(
          eq(scriptSceneTimings.scriptId, script.id),
          inArray(scriptSceneTimings.sourceUnitId, beatIds),
        ),
      )
      .limit(1);
    const [plan] = timing
      ? []
      : await db
          .select({ id: scriptShotPlans.id })
          .from(scriptShotPlans)
          .where(
            and(
              eq(scriptShotPlans.scriptId, script.id),
              inArray(scriptShotPlans.sourceSceneId, beatIds),
            ),
          )
          .limit(1);
    keepBeatSources = Boolean(timing ?? plan);
  }
  return extractScenarioHandoffSources({
    format,
    outline,
    fountain: script.fountain,
    keepBeatSources,
  });
}
