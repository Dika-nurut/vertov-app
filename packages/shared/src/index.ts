import type {
  tierEnum,
  modelKindEnum,
  providerEnum,
  unitKindEnum,
  jobStatusEnum,
  subStatusEnum,
} from '@seed/db';

export const APP_NAME = 'Vertov';
export const DEFAULT_LOCALE = 'ru' as const;

export { FREE_MEDIA_RETENTION_COPY } from './media-retention';
export { resolveGeneratePrompt } from './board-prompt';
export { buildSceneContext, GROUP_SEP } from './scene-context';
export { sceneObjectKindSchema } from './scene-objects';

// `shot-plan` is deliberately NOT re-exported here. It imports `node:crypto`,
// and this barrel is reachable from client components (useProjectPanel.ts →
// ScenarioCanvas.tsx), so re-exporting it fails the Next production build with
// "Module not found: node:crypto" — while tests and tsc stay green. Server code
// imports it by its subpath: `@seed/shared/shot-plan`.
export {
  MEDIA_TITLE_MAX_LENGTH,
  UNTITLED_MEDIA_LABEL,
  generatedMediaTitle,
  mediaDisplayTitle,
} from './media-title';

export {
  SUBSCRIPTION_TIER_ORDER,
  SUBSCRIPTION_TIER_LABELS,
  isSubscriptionTier,
  subscriptionTierRank,
  subscriptionTierAllows,
  subscriptionTierLabel,
  type SubscriptionTier,
} from './subscription-tiers';

export {
  SREDA_FOLDER_NAME_MAX_LENGTH,
  SREDA_FOLDER_NAME_FORBIDDEN,
  sredaFolderNameSchema,
  sredaFolderCreateSchema,
  sredaFolderPatchSchema,
  validateSredaFolderName,
  type SredaFolder,
} from './sreda-folders';

export {
  mergePresetPrompt,
  unfilledRequiredSlots,
  type PresetMergeMode,
  type PresetSlot,
  type PresetPromptSpec,
} from './preset-merge';

export { bibleNotes, type BibleShape } from './bible-notes';

export {
  scenarioFormatSchema,
  scenarioBriefV1Schema,
  scenarioBeatV1Schema,
  scenarioOutlineV1Schema,
  EMPTY_SCENARIO_BRIEF,
  EMPTY_SCENARIO_OUTLINE,
  STRUCTURIZE_SOURCE_MAX_CHARS,
  scenarioStructurizeResultSchema,
  type ScenarioFormat,
  type ScenarioBriefV1,
  type ScenarioBeatV1,
  type ScenarioOutlineV1,
  type ScenarioStructurizeResult,
} from './scenario-project';

export {
  SCENARIO_SHOT_PLAN_VERSION,
  SCENARIO_SHOT_PLAN_MODEL,
  SCENARIO_SHOT_PLAN_BUDGET,
  SCENARIO_SHOT_PLAN_MAX_ATTEMPTS,
  SCENARIO_SHOT_PLAN_CREDITS,
  SCENARIO_SHOT_PLAN_MAX_INPUT_BYTES,
  SCENARIO_SHOT_PLAN_SOURCE_MAX_BYTES,
  SCENARIO_SHOT_PLAN_PROMPT_MAX_CHARS,
  SCENARIO_SHOT_PLAN_MAX_SHOTS,
  SCENARIO_SHOT_PLAN_MAX_SHOT_DURATION_SECONDS,
  SCENARIO_SHOT_PLAN_DEADLINE_MS,
  SCENARIO_SHOT_DURATION_STEPS,
  scenarioShotPlanRawSchema,
  scenarioShotPlanSchema,
  normalizeScenarioShotPlan,
  ScenarioShotPlanDurationError,
  type ScenarioShotRaw,
  type ScenarioShotPlanRaw,
  type ScenarioShot,
  type ScenarioShotPlan,
} from './scenario-shot-plan';

export {
  GENERATION_PARAMS_MAX_BYTES,
  generationGatewaySchema,
  generationRequestSourceSchema,
  generationParamsSchema,
  generationJobRequestSchema,
  generationJobEstimateSchema,
  generationJobSubmitSchema,
  unitsForGenerationModel,
  KNOWN_GENERATION_PARAM_KEYS,
  unknownGenerationParamKeys,
  type GenerationJobRequest,
  type GenerationJobEstimate,
  type GenerationJobSubmit,
  type UnitsForGenerationModelInput,
  type UnitsForGenerationModelResult,
} from './generation-request';

export {
  EXECUTION_SNAPSHOT_VERSION,
  executionSnapshotSchema,
  parseExecutionSnapshot,
  type ExecutionSnapshot,
} from './execution-snapshot';

export {
  REGISTRY_MANAGED_CAPABILITY_KEYS,
  deriveCatalogCapabilities,
  pickManagedCapabilities,
  contractForGateway,
  normalizeVideoParams,
  type NormalizedVideoParams,
  type NormalizeResult,
  type ContractGateway,
  type ContractInputMode,
  type ContractRole,
  type ContractProvenance,
  type EnumParamContract,
  type DurationParamContract,
  type ReferenceContract,
  type AudioContract,
  type ModelGatewayContract,
  type RegistryManagedCapabilityKey,
} from './model-contract';

export {
  byteplusRouteContracts,
  byteplusContractList,
  catalogCapabilitiesForModel,
} from './model-contract-byteplus';

export {
  CHAIN_RELAY_EXPANSIONS,
  OFFICIAL_OPENROUTER_CONTRACT_GAP,
  RELAY_TO_ADAPTER_GATEWAY,
  SIGNED_CHAIN_LEG_ORDER,
  SINGLE_LEG_CONFIGURATIONS,
  UNCOSTED_ADAPTER_GATEWAYS,
  contractGatewayForRelay,
  gatewayArmingFromEnv,
  isGatewayArmed,
  orderLegsBySignedOrder,
  relayForAdapterGateway,
  singleLegGateway,
  signedChainLegOrder,
  isSingleLegConfiguration,
  type SingleLegConfiguration,
  type SignedLegOrder,
  type AdapterGateway,
  type FinanceRelay,
  type GatewayArming,
  type GatewayArmingEnv,
} from './relay-gateway';

export { renderContractMatrix } from './model-contract-matrix';
export { priceModeForRequest, type PriceModeModel } from './pricing-mode';
export { priceResolutionForRequest } from './price-resolution';

/*
 * The route engine is NOT re-exported here, deliberately.
 *
 * `select-route.ts` and `route-engine-guards.ts` import VALUES from `@seed/db`
 * (`costCatalogue`, `landedRubPerUsd`, `costLegFile`), and `@seed/db` loads
 * `pg`. This barrel is imported by client components — `ScenarioCanvas.tsx`
 * pulls it through `useProjectPanel.ts` — so a re-export here drags the
 * Postgres driver into the browser bundle and `next build` dies on
 * `Can't resolve 'fs'`. Unit tests and tsc never see it; only the web build
 * does.
 *
 * Node-side callers import the subpaths instead:
 *   `@seed/shared/select-route`, `@seed/shared/route-engine-guards`.
 */

export { resolveProductContract, type ProductContract } from './model-contract-product';

export {
  billableVideoUnits,
  billableVideoUnitsForModel,
  type BillableVideoResult,
} from './model-contract-billing';

export {
  BOARD_SCHEMA_VERSION,
  BOARD_NODE_VERSION,
  BOARD_KNOWN_NODE_TYPES,
  BOARD_LIMITS,
  BOARD_VIDEO_ASPECTS,
  BOARD_VIDEO_RESOLUTIONS,
  BOARD_IMAGE_ASPECTS,
  BOARD_IMAGE_QUALITIES,
  BOARD_GENERATION_STATUSES,
  BOARD_GENERATE_DEFAULTS,
  BOARD_NODE_REGISTRY,
  boardPositionSchema,
  boardViewportSchema,
  boardShotGrammarSchema,
  boardPromptDataSchema,
  boardAiPromptDataSchema,
  PROMPT_STUDIO_CREDITS,
  PROMPT_STUDIO_BRIEF_CHAR_LIMIT,
  PROMPT_STUDIO_CHARS_PER_TOKEN,
  PROMPT_STUDIO_INPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_OUTPUT_TOKEN_LIMIT,
  PROMPT_STUDIO_PRICING,
  PROMPT_STUDIO_RESULT_CHAR_LIMIT,
  PROMPT_STUDIO_AVERAGE_TOKEN_BUDGET,
  PROMPT_STUDIO_MAX_TOKEN_BUDGET,
  promptStudioCostUsd,
  promptStudioCreditsFor,
  promptStudioMarginAtFloor,
  boardNoteDataSchema,
  boardTextSizeSchema,
  boardTextDataSchema,
  BOARD_FRAME_TINTS,
  boardFrameTintSchema,
  boardFrameDataSchema,
  boardSceneDataSchema,
  boardSceneObjectSchema,
  boardMediaDataSchema,
  boardCastDataSchema,
  boardGenerateDataSchema,
  boardGenerateSettingsSchema,
  boardNodeSchema,
  boardEdgeSchema,
  boardDocumentSchema,
  migrateBoardDocument,
  normalizeBoardNodeOrder,
  isKnownBoardNodeType,
  safeParseBoardDocument,
  parseBoardDocument,
  boardGenerateCycleEdgeIndexes,
  boardGenerateGraphHasCycle,
  boardNodeDefaultData,
  boardOutputPort,
  boardInputPort,
  validateBoardConnectionShape,
  resolveBoardModelContract,
  validateBoardModelForNode,
  boardReferenceInputCapacity,
  boardVideoDurationsFor,
  boardVideoResolutionsFor,
  boardVideoAspectsFor,
  boardImageAspectsFor,
  boardImageQualitiesFor,
  boardImageQualityLabel,
  boardImageQualityIsVendorWord,
  pickSignedRung,
  resolveBoardVideoSettings,
  resolveBoardImageSettings,
  boardGenerateSettingIssues,
  boardGenerateSettingsPatch,
  boardCompiledImageParamsSchema,
  boardCompiledVideoParamsSchema,
  boardCompiledFrameImageSchema,
  boardCompiledFrameImagesSchema,
  boardCompiledGenerationRequestSchema,
  boardModelMetadataIssues,
  isBoardModelCatalogComplete,
  validateBoardCompiledGenerationRequest,
  compileBoardGenerationRequest,
  compileBoardGenerationQuote,
  validateBoardConnection,
  validateBoardConnections,
  type BoardDocument,
  type BoardNode,
  type BoardEdge,
  type BoardNodeType,
  type BoardPromptData,
  type BoardAiPromptData,
  type PromptStudioModel,
  type PromptStudioBudgetKind,
  type PromptStudioCostBasis,
  type PromptStudioModelPricing,
  type BoardNoteData,
  type BoardTextData,
  type BoardFrameData,
  type BoardSceneData,
  type BoardMediaData,
  type BoardCastData,
  type BoardGenerateData,
  type BoardShotGrammar,
  type BoardSemanticPayload,
  type BoardPortSpec,
  type BoardNodeSpec,
  type BoardConnectionShapeResult,
  type BoardModelLike,
  type BoardImageInputRole,
  type BoardResolvedModelContract,
  type BoardModelResult,
  type BoardResolvedVideoSettings,
  type BoardResolvedImageSettings,
  type BoardGenerateSettingField,
  type BoardGenerateSettingIssue,
  type BoardGenerationCompileInput,
  type BoardGenerationOutputContract,
  type BoardCompiledGenerationRequest,
  type BoardCompiledFrameImage,
  type BoardCompiledRequestValidationResult,
  type BoardGenerationCompileResult,
  type BoardGenerationQuoteResult,
  type BoardConnectionResult,
  type BoardConnectionCandidate,
  type BoardConnectionsResult,
} from './board-contract';

export {
  BOARD_SEMANTIC_PAYLOAD_LABELS,
  diagnoseBoardTarget,
  diagnoseBoardGraph,
  analyzeBoardModelChange,
  type BoardTargetInput,
  type BoardEdgeDiagnostic,
  type BoardConnectionRole,
  type BoardGeneralDiagnostic,
  type BoardTargetDiagnostic,
  type BoardGraphNodeLike,
  type BoardGraphEdgeLike,
  type BoardGraphDiagnostic,
  type BoardModelChangeImpact,
} from './board-diagnostics';

// Single source of truth: derive from the Drizzle enums in @seed/db so a schema
// change automatically updates these types (no manual sync needed).
export type Tier = (typeof tierEnum.enumValues)[number];
export type ModelKind = (typeof modelKindEnum.enumValues)[number];
export type ProviderId = (typeof providerEnum.enumValues)[number];
export type UnitKind = (typeof unitKindEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type SubscriptionStatus = (typeof subStatusEnum.enumValues)[number];
export {
  LLM_PRICING_WORKBOOK,
  llmPricingRecord,
  llmModelPrice,
  type LlmSurface,
  type LlmUnitPrice,
  type LlmPricingRecord,
} from './llm-pricing-workbook';
export {
  ASSIST_TIERS,
  ASSIST_TOKEN_BUDGET,
  ASSIST_CHARS_PER_TOKEN,
  KIE_GEMINI3_FLASH_PRICE_USD_PER_MTOK,
  KIE_CLAUDE_SONNET5_PRICE_USD_PER_MTOK,
  KIE_GPT56_TERRA_PRICE_USD_PER_MTOK,
  MODEL_PRICES_USD_PER_MTOK,
  MATERIALS_MAX_CHARS,
  MATERIALS_SURCHARGE,
  MEMORY_NOTES_MAX_CHARS,
  MATERIAL_SUMMARY_MIN_RAW_CHARS,
  MATERIAL_SUMMARY_MAX_CHARS,
  MATERIAL_COMPACTION_INPUT_TOKEN_LIMIT,
  MATERIAL_COMPACTION_OUTPUT_TOKEN_LIMIT,
  CONSPECT_INPUT_TOKEN_LIMIT,
  CONSPECT_OUTPUT_TOKEN_LIMIT,
  CONSPECT_MAX_ATTEMPTS,
  STRUCTURIZE_MODEL,
  STRUCTURIZE_MAX_ATTEMPTS,
  STRUCTURIZE_TOKEN_BUDGET,
  STRUCTURIZE_SOURCE_MAX_BYTES,
  STRUCTURIZE_CREDITS,
  STRUCTURIZE_ACTIVE_CREDITS,
  structurizeCostUsd,
  creditsForCostUsd,
  ASSIST_PRICING,
  assistTier,
  assistPrice,
  assistCallCostUsd,
  assistCostUsdForBudget,
  assistMarginAtFloor,
  type AssistTier,
  type AssistTierId,
  type AssistScope,
} from './assist-tiers';
export * from './ai-usage';
export * from './scenario-assist-pricing';
export * from './delivered-rank';
export * from './support-attachments';
