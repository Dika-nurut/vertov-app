// Mobile board node-data types.
//
// These MIRROR the persisted board state shapes that the desktop canvas
// (../GraphBoard.tsx, lines ~157-216) reads/writes. They are intentionally
// DUPLICATED here, not imported, so the mobile board is a fully isolated code
// path — the desktop component is never touched or made to export internals
// (owner constraint: explicitly divide mobile and desktop). The board `state`
// is opaque JSON on the server, so both sides just have to agree on this shape.

export type GenStatus = 'idle' | 'running' | 'done' | 'failed';

export interface PromptData {
  text: string;
}

export type AiTextModel = 'claude' | 'gpt' | 'gemini';
export interface AiPromptData {
  brief: string;
  idempotencyKey?: string;
  text?: string;
  model?: AiTextModel;
  mode?: 'video' | 'image';
  status?: GenStatus;
  view?: 'brief' | 'result';
}

export interface NoteData {
  text: string;
}

export interface TextData {
  text: string;
  size?: 's' | 'm' | 'l';
}

export interface FrameData {
  title: string;
  tint?: 'violet' | 'blue' | 'green' | 'amber' | 'pink' | 'gray';
}

export interface SceneData {
  title: string;
  synopsis: string;
  sourceText: string;
  sourceScriptId?: string;
  sourceOrdinal?: number;
  sourceStatus?: 'current' | 'changed' | 'removed';
  collapsed?: boolean;
}

export interface MediaData {
  url: string;
  mediaKind: 'image' | 'video';
}

export interface CastData {
  castKind: 'character' | 'location';
  name: string;
  imageUrls: string[];
  videoUrl?: string;
  characterId?: string;
}

export interface GenerateData {
  mode: 'image' | 'video';
  prompt: string;
  count?: number;
  status?: GenStatus;
  jobId?: string;
  resultUrl?: string;
  resultKind?: 'image' | 'video';
  lastFrameUrl?: string;
  takes?: string[];
  drifted?: boolean;
  // NodeSettings + ShotGrammar fields ride along untyped here — Phase 1 only
  // reads the display-relevant fields above; later phases that EDIT a shot
  // import the real NodeSettings/ShotGrammar types from lib/ (import-safe).
  [k: string]: unknown;
}

export type AnyNodeData =
  | PromptData
  | AiPromptData
  | NoteData
  | TextData
  | FrameData
  | SceneData
  | MediaData
  | CastData
  | GenerateData;

/** The persisted board state (standard ReactFlow + a montage tray). */
export interface BoardState {
  nodes?: unknown[];
  edges?: unknown[];
  viewport?: { x: number; y: number; zoom: number };
  tray?: string[];
}

export function isVideoUrl(u: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(u);
}
