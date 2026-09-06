/**
 * Character identity helpers (B-5). Builds on the existing cast system: a cast
 * node carries a character's reference images and wires into shots, which inject
 * those refs subject-first. These helpers describe reference coverage and usage;
 * they deliberately do not infer a guaranteed identity lock from image count.
 *
 * Pure (structural node/edge shapes) → unit-tested; the cast node renders them.
 */
import type { ShotEdgeLike, ShotNodeLike } from './shot-list';
import { isReferenceModel } from './gateway-routing';

export type IdentityStrength = 'none' | 'weak' | 'ok' | 'strong';

export interface IdentityQuality {
  refCount: number;
  strength: IdentityStrength;
  /** Human-facing nudges (RU) toward a more stable identity. */
  warnings: string[];
}

export type CharacterReferenceSupport = 'unknown' | 'unsupported' | 'guided' | 'specialized';

/** Honest route classification. `specialized` means a dedicated reference model,
 * not a promise that a provider will reproduce a face exactly.
 *
 * `unknown` is NOT `unsupported`: when no model resolves for the shot — the
 * catalog has not loaded, or the plan entitles nothing for this mode — we know
 * nothing about reference support. Reporting that as "the model does not use
 * character references" blames a capability for what is really an empty or
 * gated picker, which is exactly what a free-plan board used to show. */
export function characterReferenceSupport(input: {
  modelId: string | undefined;
  imageInputMax: number;
}): CharacterReferenceSupport {
  if (!input.modelId) return 'unknown';
  if (input.imageInputMax <= 0) return 'unsupported';
  return isReferenceModel(input.modelId) ? 'specialized' : 'guided';
}

/**
 * Score only the completeness of a character's reference set. More views give a
 * compatible model more evidence; the score is not model capability or outcome.
 */
export function identityRefQuality(imageUrls: string[] | undefined): IdentityQuality {
  const refCount = (imageUrls ?? []).filter((u) => typeof u === 'string' && u.length > 0).length;
  const warnings: string[] = [];
  let strength: IdentityStrength;
  if (refCount === 0) {
    strength = 'none';
    // Kind-neutral: this readout now serves people AND products.
    warnings.push('Нет референсов — добавь 2–4 кадра объекта.');
  } else if (refCount === 1) {
    strength = 'weak';
    warnings.push('Один ракурс даёт модели мало информации. Добавь ещё 1–3.');
  } else if (refCount < 4) {
    strength = 'ok';
  } else {
    strength = 'strong';
  }
  return { refCount, strength, warnings };
}

/**
 * Generate-node ids wired FROM this cast node — the shots that use the
 * character. (Cast → generate edges; mirrors deriveShotList's inbound resolve.)
 */
export function shotsUsingCharacter(
  castId: string,
  nodes: ShotNodeLike[],
  edges: ShotEdgeLike[],
): string[] {
  const generateIds = new Set(nodes.filter((n) => n.type === 'generate').map((n) => n.id));
  const used: string[] = [];
  for (const e of edges) {
    if (e.source === castId && generateIds.has(e.target) && !used.includes(e.target)) {
      used.push(e.target);
    }
  }
  return used;
}
