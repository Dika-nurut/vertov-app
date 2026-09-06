#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function evidence(fixture, ids) {
  return [...new Set(ids.flatMap((id) => fixture.evidence[id] ?? []))];
}

function modelRequirement(model) {
  const cap = model.requiredCapabilities;
  return [
    `kind=${model.kind}`,
    `imageInput=${cap.imageInputRole}:${String(cap.providerImageMax)}`,
    `videoRefs=${cap.providerVideoMax}`,
    `audioGenerate=${cap.audioGenerate}`,
  ].join('; ');
}

function controlOutcome(model, control) {
  const explicit = model.controlOutcomes[control.id];
  if (explicit) return explicit;
  const board = model.currentBoard;
  if (control.id === 'imageReference') {
    const input = board.imageInput;
    return {
      visibleControl: `${board.uiReferenceSlots} dynamic images[i] handles, all labelled as generic image references`,
      persistedNodeData:
        'edge targetHandle=images[i]; payload URL or cast bundle stays on the source node',
      clientRequest: `params.imageUrls; client maximum=${String(input.clientMax)}; role=${input.clientRole}`,
      apiValidation:
        'generic params record; URL safety only; no role, capability, or cardinality schema',
      providerAdapter: `${input.providerField}; provider maximum=${String(input.providerMax)}`,
      behavior: input.behavior,
      defectIds: input.defectIds,
      evidenceIds: input.evidenceIds,
    };
  }
  if (control.id === 'videoReference') {
    const input = board.videoInput;
    return {
      visibleControl:
        'video source connects to a visually image-typed images[i] handle for every video model',
      persistedNodeData: 'edge targetHandle=images[i]; mediaKind=video or cast.videoUrl on source',
      clientRequest: `params.videoUrls; client maximum=${input.clientMax}`,
      apiValidation: 'generic params record; URL safety only; no video-reference capability check',
      providerAdapter: `${input.providerField}; provider maximum=${input.providerMax}`,
      behavior: input.behavior,
      defectIds: input.defectIds,
      evidenceIds: input.evidenceIds,
    };
  }
  if (control.id === 'audioGeneration') {
    const audio = board.audioGeneration;
    return {
      visibleControl: 'audio switch is visible for every video model',
      persistedNodeData: 'generate.data.generateAudio boolean',
      clientRequest: 'params.generate_audio boolean is always compiled for video',
      apiValidation: 'none beyond generic params payload size',
      providerAdapter: audio.providerAdapter,
      behavior: audio.behavior,
      defectIds: audio.defectIds,
      evidenceIds: audio.evidenceIds,
    };
  }
  if ((control.id === 'aspectRatio' || control.id === 'quality') && board.imageParameters) {
    const field = control.id === 'aspectRatio' ? 'aspect' : 'quality';
    return {
      visibleControl:
        control.id === 'aspectRatio'
          ? 'static image aspect selector'
          : 'static 1K/2K/4K quality selector',
      persistedNodeData:
        control.id === 'aspectRatio' ? 'generate.data.imageAspect' : 'generate.data.imageQuality',
      clientRequest: control.id === 'aspectRatio' ? 'params.size' : 'params.quality',
      apiValidation: 'none beyond generic params payload size',
      providerAdapter: board.imageParameters.providerAdapter,
      behavior: board.imageParameters[`${field}Behavior`],
      defectIds: board.imageParameters.defectIds,
      evidenceIds: board.imageParameters.evidenceIds,
    };
  }
  if (control.id === 'count' && board.count) {
    return {
      visibleControl: 'tries stepper 1..4 is visible in both generation modes',
      persistedNodeData: 'generate.data.count',
      clientRequest: board.count.clientRequest,
      apiValidation: board.count.apiValidation,
      providerAdapter: board.count.providerAdapter,
      behavior: board.count.behavior,
      defectIds: board.count.defectIds,
      evidenceIds: board.count.evidenceIds,
    };
  }
  if (control.id === 'gatewayReferenceRouting' && board.gatewayRouting) {
    return {
      visibleControl: 'automatic reference routing plus a development-only gateway policy widget',
      persistedNodeData:
        'policy in localStorage; reference payload on source nodes/edges, not in versioned node data',
      clientRequest: 'top-level provider=openrouter|atlascloud selected after params are compiled',
      apiValidation:
        'model.gatewayOverride, slash-shaped provider id, or capabilities.forceGateway may supersede provider',
      providerAdapter: board.gatewayRouting.providerAdapter,
      behavior: board.gatewayRouting.behavior,
      defectIds: board.gatewayRouting.defectIds,
      evidenceIds: board.gatewayRouting.evidenceIds,
    };
  }
  const fallback = control.defaultOutcome[model.kind === 'video' ? 'video' : 'image'];
  if (!fallback) {
    throw new Error(`missing ${control.id} outcome for ${model.id}`);
  }
  return fallback;
}

/**
 * Expand the compact BRD-0B audit fixture into one row per node, connection,
 * and selected-model/control combination. Every row uses the field vocabulary
 * required by the master plan, so downstream checks can consume JSON rather
 * than scrape the Markdown report.
 */
export function buildBoardCompatibilityMatrix(fixture, inventory) {
  const inventoryById = new Map(inventory.models.map((model) => [model.canonicalId, model]));

  const nodeRows = fixture.nodeContracts.map((node) => ({
    rowType: 'node',
    combinationId: `node:${node.id}`,
    nodeTypeVersion: node.id,
    inputPort: node.inputPorts.length ? node.inputPorts : ['none'],
    outputPort: node.outputPorts.length ? node.outputPorts : ['none'],
    legalUpstreamNodes: node.legalUpstreamNodes,
    legalDownstreamNodes: node.legalDownstreamNodes,
    modelRequirement: node.modelRequirement,
    parameterMapping: node.parameterMapping,
    unsupportedBehavior: node.unsupportedBehavior,
    defectIds: node.defectIds,
    runtimeEvidence: evidence(fixture, node.evidenceIds),
  }));

  const connectionRows = fixture.connectionContracts.map((connection) => ({
    rowType: 'connection',
    combinationId: `connection:${connection.id}`,
    nodeTypeVersion: connection.targetNode,
    inputPort: connection.targetPort,
    outputPort: connection.sourcePort,
    legalUpstreamNodes: connection.legalUpstreamNodes,
    legalDownstreamNodes: [connection.targetNode],
    modelRequirement: connection.modelRequirement,
    parameterMapping: connection.parameterMapping,
    unsupportedBehavior: connection.currentBehavior,
    defectIds: connection.defectIds,
    runtimeEvidence: evidence(fixture, connection.evidenceIds),
  }));

  const controlRows = [];
  for (const model of fixture.modelCompatibility) {
    const inventoryRow = inventoryById.get(model.id);
    if (!inventoryRow) throw new Error(`model ${model.id} is absent from the AI inventory`);
    for (const control of fixture.controlContracts) {
      const mode = model.kind === 'video' ? 'video' : 'image';
      if (!control.appliesTo.includes(mode)) continue;
      const outcome = controlOutcome(model, control);
      controlRows.push({
        rowType: 'control-model',
        combinationId: `control:${model.id}:${control.id}`,
        nodeTypeVersion: `generate:${mode}@unversioned`,
        inputPort: `control:${control.id}`,
        outputPort: model.requiredCapabilities.output,
        legalUpstreamNodes: control.legalUpstreamNodes,
        legalDownstreamNodes: ['POST /v1/jobs', inventoryRow.routing.primary],
        modelRequirement: modelRequirement(model),
        parameterMapping: {
          visibleControl: outcome.visibleControl,
          persistedNodeData: outcome.persistedNodeData,
          clientRequest: outcome.clientRequest,
          apiValidation: outcome.apiValidation,
          providerAdapter: outcome.providerAdapter,
        },
        unsupportedBehavior: outcome.behavior,
        defectIds: [...new Set([...(control.defectIds ?? []), ...(outcome.defectIds ?? [])])],
        runtimeEvidence: evidence(fixture, [
          ...control.evidenceIds,
          ...(outcome.evidenceIds ?? []),
          'model-inventory',
        ]),
      });
    }
  }

  return {
    schemaVersion: fixture.schemaVersion,
    generatedFrom: fixture.generatedFrom,
    rowCount: nodeRows.length + connectionRows.length + controlRows.length,
    counts: {
      nodes: nodeRows.length,
      connections: connectionRows.length,
      controlModelCombinations: controlRows.length,
      models: fixture.modelCompatibility.length,
    },
    rows: [...nodeRows, ...connectionRows, ...controlRows],
  };
}

function main() {
  const fixturePath = resolve(repoRoot, 'docs/fixtures/boards-node-model-compatibility.v1.json');
  const inventoryPath = resolve(repoRoot, 'docs/fixtures/ai-model-inventory.v1.json');
  const matrix = buildBoardCompatibilityMatrix(readJson(fixturePath), readJson(inventoryPath));
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(matrix, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      `BRD-0B schema v${matrix.schemaVersion}`,
      `${matrix.rowCount} generated rows`,
      `${matrix.counts.models} models`,
      `${matrix.counts.nodes} node contracts`,
      `${matrix.counts.connections} connection contracts`,
      `${matrix.counts.controlModelCombinations} control/model combinations`,
    ].join(' | ') + '\n',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
