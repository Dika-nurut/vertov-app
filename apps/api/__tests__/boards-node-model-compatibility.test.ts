import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedModels } from '../../../packages/db/seed/models';
import { buildJobParams, type ModelLike } from '../../web/lib/node-settings';
import { REF_CAP } from '../../web/lib/ref-ports';

interface InventoryRow {
  canonicalId: string;
  source: { kind: string };
  exposure: { Boards: string };
  visibility: { sourceActive: boolean };
}

interface InventoryFixture {
  defects: { id: string }[];
  models: InventoryRow[];
}

interface MappingOutcome {
  behavior: string;
  defectIds: string[];
}

interface ModelCompatibility {
  id: string;
  kind: 'image' | 'video';
  boardExposure: string;
  requiredCapabilities: {
    imageInputRole: string;
    providerImageMax: number | null;
    providerVideoMax: number;
    audioGenerate: boolean;
    output: string;
  };
  currentBoard: {
    uiReferenceSlots: number;
    imageInput: MappingOutcome;
    videoInput?: MappingOutcome;
    audioGeneration?: MappingOutcome;
    imageParameters?: {
      aspectBehavior: string;
      qualityBehavior: string;
      defectIds: string[];
    };
  };
  defectIds: string[];
}

interface CompatibilityFixture {
  schemaVersion: number;
  nodeContracts: { id: string }[];
  connectionContracts: { id: string }[];
  controlContracts: { id: string; appliesTo: string[] }[];
  modelCompatibility: ModelCompatibility[];
  defects: { id: string; severity: string; category: string; summary: string }[];
  reestimate: { structuralImplementation: { total: string } };
}

interface GeneratedRow {
  rowType: string;
  combinationId: string;
  nodeTypeVersion: string;
  inputPort: unknown;
  outputPort: unknown;
  legalUpstreamNodes: string[];
  legalDownstreamNodes: string[];
  modelRequirement: string;
  parameterMapping: unknown;
  unsupportedBehavior: string;
  defectIds: string[];
  runtimeEvidence: string[];
}

interface GeneratedMatrix {
  schemaVersion: number;
  rowCount: number;
  counts: {
    nodes: number;
    connections: number;
    controlModelCombinations: number;
    models: number;
  };
  rows: GeneratedRow[];
}

const repoRoot = resolve(__dirname, '..', '..', '..');
const fixture = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'docs', 'fixtures', 'boards-node-model-compatibility.v1.json'),
    'utf8',
  ),
) as CompatibilityFixture;
const inventory = JSON.parse(
  readFileSync(resolve(repoRoot, 'docs', 'fixtures', 'ai-model-inventory.v1.json'), 'utf8'),
) as InventoryFixture;

function generatedMatrix(): GeneratedMatrix {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [resolve(repoRoot, 'scripts', 'boards-compatibility-matrix.mjs'), '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
      },
    ),
  ) as GeneratedMatrix;
}

describe('BRD-0B generated Board node/model compatibility matrix', () => {
  it('expands every audited node, connection, and relevant model/control combination', () => {
    const matrix = generatedMatrix();
    expect(fixture.schemaVersion).toBe(1);
    expect(matrix.schemaVersion).toBe(1);
    expect(matrix.counts).toEqual({
      nodes: 9,
      connections: 16,
      controlModelCombinations: 236,
      models: 22, // happyhorse-1-0 and Seedream 4.5 are retired
    });
    expect(matrix.rowCount).toBe(261);
    expect(matrix.rows).toHaveLength(matrix.rowCount);
    expect(new Set(matrix.rows.map((row) => row.combinationId)).size).toBe(matrix.rowCount);

    for (const row of matrix.rows) {
      expect(row.rowType, row.combinationId).not.toBe('');
      expect(row.nodeTypeVersion, row.combinationId).not.toBe('');
      expect(row.inputPort, row.combinationId).toBeDefined();
      expect(row.outputPort, row.combinationId).toBeDefined();
      expect(Array.isArray(row.legalUpstreamNodes), row.combinationId).toBe(true);
      expect(Array.isArray(row.legalDownstreamNodes), row.combinationId).toBe(true);
      expect(row.modelRequirement, row.combinationId).not.toBe('');
      expect(row.parameterMapping, row.combinationId).toBeDefined();
      expect(row.unsupportedBehavior, row.combinationId).not.toBe('');
      expect(row.runtimeEvidence.length, row.combinationId).toBeGreaterThan(0);
    }
  });

  it('covers every source-active media model exactly once, including release-drift rows', () => {
    const sourceActive = seedModels.filter(
      (model) => model.isActive && ['image', 'image-edit', 'video'].includes(model.kind),
    );
    expect(fixture.modelCompatibility.map((model) => model.id).sort()).toEqual(
      sourceActive.map((model) => model.id).sort(),
    );
    // 22: happyhorse-1-0 and Seedream 4.5 are retired.
    expect(new Set(fixture.modelCompatibility.map((model) => model.id)).size).toBe(22);

    const inventoryById = new Map(inventory.models.map((model) => [model.canonicalId, model]));
    for (const model of fixture.modelCompatibility) {
      const source = inventoryById.get(model.id);
      expect(source?.visibility.sourceActive, model.id).toBe(true);
      expect(model.boardExposure, model.id).toBe(
        source?.exposure.Boards === 'visible' ? 'visible_live' : 'hidden_release_drift',
      );
      expect(model.currentBoard.uiReferenceSlots, model.id).toBe(
        model.kind === 'video' ? REF_CAP.video : REF_CAP.image,
      );
      expect(model.requiredCapabilities.output, model.id).not.toBe('');
      expect(model.currentBoard.imageInput.behavior, model.id).not.toBe('');
      if (model.kind === 'video') {
        expect(model.currentBoard.videoInput?.behavior, model.id).not.toBe('');
        expect(model.currentBoard.audioGeneration?.behavior, model.id).not.toBe('');
      } else {
        expect(model.currentBoard.imageParameters?.aspectBehavior, model.id).not.toBe('');
        expect(model.currentBoard.imageParameters?.qualityBehavior, model.id).not.toBe('');
      }
    }
  });

  it('audits every required control across all five mapping layers', () => {
    expect(fixture.controlContracts.map((control) => control.id).sort()).toEqual(
      [
        'aspectRatio',
        'audioGeneration',
        'audioReference',
        'count',
        'duration',
        'gatewayReferenceRouting',
        'imageReference',
        'model',
        'negativePrompt',
        'quality',
        'resolution',
        'seed',
        'shotGrammar',
        'videoReference',
      ].sort(),
    );

    const controls = generatedMatrix().rows.filter((row) => row.rowType === 'control-model');
    for (const row of controls) {
      const mapping = row.parameterMapping as Record<string, unknown>;
      expect(Object.keys(mapping).sort(), row.combinationId).toEqual(
        [
          'apiValidation',
          'clientRequest',
          'persistedNodeData',
          'providerAdapter',
          'visibleControl',
        ].sort(),
      );
      for (const value of Object.values(mapping)) expect(value, row.combinationId).not.toBe('');
    }
  });

  it('never leaves a current ignored input undocumented', () => {
    const allDefectIds = new Set([
      ...fixture.defects.map((defect) => defect.id),
      ...inventory.defects.map((defect) => defect.id),
    ]);
    for (const row of generatedMatrix().rows) {
      for (const id of row.defectIds)
        expect(allDefectIds, `${row.combinationId}:${id}`).toContain(id);
      if (/ignored/i.test(row.unsupportedBehavior)) {
        expect(row.defectIds.length, row.combinationId).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the defect ledger classified and the structural re-estimate explicit', () => {
    const allowed =
      /^(invalid wire|false affordance|ignored input|wrong request mapping|missing capability|missing test)$/;
    expect(new Set(fixture.defects.map((defect) => defect.id)).size).toBe(fixture.defects.length);
    expect(fixture.defects.some((defect) => defect.severity === 'P0')).toBe(true);
    for (const defect of fixture.defects) {
      expect(defect.category, defect.id).toMatch(allowed);
      expect(defect.summary, defect.id).not.toBe('');
    }
    expect(fixture.reestimate.structuralImplementation.total).toMatch(/19-26 engineering days/);
  });

  it('matches the current pure compiler facts that drive the highest-risk findings', () => {
    const sora: ModelLike = {
      id: 'sora-2-pro',
      family: 'Sora',
      variant: '2 Pro',
      kind: 'video',
      minUnitCredits: 1,
      maxDurationSeconds: 20,
      capabilities: { frames: [], audio: true, durations: [4, 8, 12, 16, 20] },
    };
    expect(
      buildJobParams({
        mode: 'video',
        settings: { durationSeconds: 8 },
        images: ['https://assets.example/ignored.png'],
        videos: ['https://assets.example/ignored.mp4'],
        count: 4,
        model: sora,
      }),
    ).toEqual({
      duration_seconds: 8,
      resolution: '720p',
      aspect_ratio: '16:9',
      generate_audio: true,
      return_last_frame: true,
    });

    const image = buildJobParams({
      mode: 'image',
      settings: { imageAspect: '9:16', imageQuality: '4K' },
      images: Array.from({ length: 20 }, (_, i) => `https://assets.example/${i}.png`),
      count: 4,
    });
    expect(image['aspect_ratio']).toBe('9:16');
    expect(image['resolution']).toBe('4K');
    expect(image['n']).toBe(4);
    expect(image['imageUrls']).toHaveLength(14);
  });
});
