#!/usr/bin/env node
/**
 * Compare a read-only /v1/models JSON response with the current active source
 * seed. The caller supplies the response on stdin; this script performs no
 * network, database, provider, or filesystem writes.
 *
 * Example:
 *   ssh ... 'curl -fsS http://127.0.0.1:4000/v1/models' |
 *     pnpm --filter @seed/db exec tsx ../../scripts/compare-live-model-source.ts
 */
import { seedModels } from '../packages/db/seed/models';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, stable((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const parsed: unknown = JSON.parse(input);
    const liveRows = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object'
        ? (((parsed as Record<string, unknown>).items ??
            (parsed as Record<string, unknown>).models ??
            []) as unknown[])
        : [];
    const sourceRows = seedModels.filter((model) => model.isActive);
    const sourceById = new Map(sourceRows.map((model) => [model.id, model]));
    const liveById = new Map(
      liveRows
        .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object'))
        .map((row) => [String(row.id), row]),
    );
    const ids = [...new Set([...sourceById.keys(), ...liveById.keys()])].sort();
    const mismatches: Array<{ id: string; kind?: string; fields?: string[] }> = [];

    for (const id of ids) {
      const source = sourceById.get(id);
      const live = liveById.get(id);
      if (!source || !live) {
        mismatches.push({ id, kind: source ? 'source_only' : 'live_only' });
        continue;
      }
      const fields = (['kind', 'family', 'unitKind', 'creditCostPerUnit'] as const).filter(
        (field) => source[field] !== live[field],
      );
      if (!same(source.capabilities ?? null, live.capabilities ?? null))
        fields.push('capabilities');
      if (fields.length > 0) mismatches.push({ id, fields });
    }

    const result = {
      sourceActive: sourceRows.length,
      live: liveRows.length,
      exactIds:
        sourceRows.length === liveRows.length &&
        sourceRows.every((model) => liveById.has(model.id)) &&
        liveRows.every((row) =>
          Boolean(
            row &&
              typeof row === 'object' &&
              liveById.has(String((row as Record<string, unknown>).id)),
          ),
        ),
      mismatchCount: mismatches.length,
      mismatches,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.exactIds || result.mismatchCount > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
