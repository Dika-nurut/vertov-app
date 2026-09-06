import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../../../packages/db/seed/models';
import { ASSIST_TIERS } from '@seed/shared';
import { PROMPT_ENHANCER_MODEL, PROMPT_STUDIO_MODEL_SLUGS } from '@seed/provider-prompt-enhancer';

type DecisionStatus = 'supported' | 'hidden_pending_proof' | 'intentionally_excluded' | 'defective';

interface InventoryRow {
  canonicalId: string;
  identity: {
    vertovId: string | null;
    providerIds: string[];
    aliases: string[];
    family: string;
    version: string;
  };
  mediaPurpose: string;
  source: { type: string; path: string; active: boolean; kind: string };
  exposure: {
    Generate: string;
    Scenario: string;
    Boards: string;
    internalOnly: boolean;
  };
  visibility: {
    sourceActive: boolean;
    liveActive: boolean;
    tierEligibility: string | string[];
    uiEligibility: string | string[];
  };
  capabilities: {
    inputs: string[];
    outputs: string[];
    frames: string[];
    maxReferences: { image: number | null; video: number; audio: number };
    outputCount: { min: number; max: number };
    audio: { generate: boolean; reference: boolean };
    durations: number[];
    resolutions: string[];
    aspectRatios: string[];
    extras: string[];
  };
  routing: {
    primary: string;
    configuredFallback: string | null;
    supportedFallbacks: string[];
    primaryProviderId: string;
    providerIdsByRoute: string[];
  };
  cost: {
    billingUnit: string;
    creditsPerUnit: number | null;
    providerUsdPerUnit: number | { input: number; output: number } | null;
    basis: string;
  };
  proof: {
    staticContract: string[];
    mockTests: string[];
    liveSchema: { status: string; date: string | null; source: string | null };
    liveMediaProbe: { status: string; date: string | null };
  };
  decision: { status: DecisionStatus; reason: string };
}

interface InventoryFixture {
  schemaVersion: number;
  liveCatalog: {
    modelCount: number;
    sourceActiveMediaCount: number;
    missingFromLive: string[];
    unexpectedLive: string[];
    health: { commit: string | null };
  };
  defects: { id: string; severity: string; category: string; summary: string }[];
  models: InventoryRow[];
}

const fixturePath = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'fixtures',
  'ai-model-inventory.v1.json',
);
const inventory = JSON.parse(readFileSync(fixturePath, 'utf8')) as InventoryFixture;
const mediaRows = inventory.models.filter((row) => row.source.type === 'db-seed');
const textRows = inventory.models.filter((row) => row.source.kind === 'text');

describe('BRD-0A machine-readable AI model inventory', () => {
  it('is versioned, unique, and structurally complete', () => {
    expect(inventory.schemaVersion).toBe(1);
    expect(new Set(inventory.models.map((row) => row.canonicalId)).size).toBe(
      inventory.models.length,
    );

    const decisions: DecisionStatus[] = [
      'supported',
      'hidden_pending_proof',
      'intentionally_excluded',
      'defective',
    ];
    for (const row of inventory.models) {
      expect(row.identity.providerIds.length, row.canonicalId).toBeGreaterThan(0);
      expect(row.mediaPurpose, row.canonicalId).not.toBe('');
      expect(row.capabilities.inputs.length, row.canonicalId).toBeGreaterThan(0);
      expect(row.capabilities.outputs.length, row.canonicalId).toBeGreaterThan(0);
      expect(row.routing.primary, row.canonicalId).not.toBe('');
      expect(row.routing.primaryProviderId, row.canonicalId).not.toBe('');
      expect(row.cost.billingUnit, row.canonicalId).not.toBe('');
      expect(row.proof.staticContract.length, row.canonicalId).toBeGreaterThan(0);
      expect(row.proof.mockTests.length, row.canonicalId).toBeGreaterThan(0);
      expect(decisions, row.canonicalId).toContain(row.decision.status);
      expect(row.decision.reason, row.canonicalId).not.toBe('');
    }
  });

  it('contains every source image/video row exactly once and preserves source identity', () => {
    const source = seedModels.filter((row) => ['image', 'image-edit', 'video'].includes(row.kind));
    expect(mediaRows.map((row) => row.canonicalId).sort()).toEqual(
      source.map((row) => row.id).sort(),
    );

    for (const row of source) {
      const found = mediaRows.find((candidate) => candidate.canonicalId === row.id)!;
      expect(found.identity.vertovId, row.id).toBe(row.id);
      expect(found.identity.providerIds, row.id).toContain(row.providerModelId);
      expect(found.identity.family, row.id).toBe(row.family);
      expect(found.identity.version, row.id).toBe(row.variant);
      expect(found.source.kind, row.id).toBe(row.kind);
      expect(found.visibility.sourceActive, row.id).toBe(row.isActive);
      expect(found.cost.billingUnit, row.id).toBe(row.unitKind);
      // The legacy creditCostPerUnit ceiling is purged (P-11b); the fixture
      // records null for it, and the workbook is the only price source.
      expect(found.cost.creditsPerUnit, row.id).toBeNull();
    }
  });

  it('fails closed when an active source row has no live/product decision', () => {
    const active = mediaRows.filter((row) => row.visibility.sourceActive);
    expect(active).toHaveLength(inventory.liveCatalog.sourceActiveMediaCount);
    for (const row of active) {
      expect(row.decision.status, row.canonicalId).not.toBe('intentionally_excluded');
      expect(row.exposure.Generate, row.canonicalId).not.toBe('');
      expect(row.exposure.Boards, row.canonicalId).not.toBe('');
      expect(row.cost.providerUsdPerUnit, row.canonicalId).not.toBeNull();
      if (!row.visibility.liveActive) {
        expect(row.decision.status, row.canonicalId).toBe('defective');
      }
    }
  });

  it('maps every live row and records release drift explicitly', () => {
    const live = mediaRows.filter((row) => row.visibility.liveActive);
    expect(live).toHaveLength(inventory.liveCatalog.modelCount);
    expect(
      mediaRows
        .filter((row) => row.visibility.sourceActive && !row.visibility.liveActive)
        .map((row) => row.canonicalId)
        .sort(),
    ).toEqual([...inventory.liveCatalog.missingFromLive].sort());
    expect(
      mediaRows
        .filter((row) => !row.visibility.sourceActive && row.visibility.liveActive)
        .map((row) => row.canonicalId)
        .sort(),
    ).toEqual([...inventory.liveCatalog.unexpectedLive].sort());

    for (const row of live) {
      expect(row.exposure.Generate, row.canonicalId).not.toBe('hidden');
      expect(row.exposure.Boards, row.canonicalId).not.toBe('hidden');
    }
    expect(inventory.liveCatalog.health.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it('contains every Scenario primary and candidate text slug', () => {
    const slugs = new Set(textRows.map((row) => row.canonicalId));
    for (const tier of ASSIST_TIERS) {
      expect(slugs, `${tier.id} primary`).toContain(tier.model);
      for (const candidate of tier.candidates) {
        expect(slugs, `${tier.id} candidate`).toContain(candidate);
      }
    }
  });

  it('resolves every Board AI-prompt label and fixed helper to an explicit inventoried slug', () => {
    expect(Object.keys(PROMPT_STUDIO_MODEL_SLUGS).sort()).toEqual(['claude', 'gemini', 'gpt']);
    const slugs = new Set(textRows.map((row) => row.canonicalId));
    for (const [label, slug] of Object.entries(PROMPT_STUDIO_MODEL_SLUGS)) {
      expect(slug, label).toMatch(/^[a-z0-9-]+\/[a-z0-9._-]+$/i);
      expect(slugs, label).toContain(slug);
    }
    expect(slugs).toContain(PROMPT_ENHANCER_MODEL);
  });

  it('keeps the classified defect ledger machine-checkable', () => {
    expect(new Set(inventory.defects.map((defect) => defect.id)).size).toBe(
      inventory.defects.length,
    );
    expect(inventory.defects.some((defect) => defect.severity === 'P1')).toBe(true);
    for (const defect of inventory.defects) {
      expect(defect.category).toMatch(
        /^(invalid wire|false affordance|ignored input|wrong request mapping|missing capability|missing test)$/,
      );
      expect(defect.summary).not.toBe('');
    }
  });
});
