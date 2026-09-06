import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Typed accessor for the committed media fixture corpus
 * (`fixtures/media-corpus`, T2). The single seam every offline test uses to
 * get a real, known-property render input without a provider call.
 */

export interface CorpusClip {
  id: string;
  file: string;
  kind: 'video' | 'image';
  width: number;
  height: number;
  fps?: number;
  durationSec?: number;
  hasAudio: boolean;
  role: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// apps/worker/src/test-support → repo-root/fixtures/media-corpus
export const CORPUS_DIR = resolve(here, '../../../../fixtures/media-corpus');

interface Manifest {
  clips: CorpusClip[];
}

const manifest = JSON.parse(readFileSync(resolve(CORPUS_DIR, 'manifest.json'), 'utf8')) as Manifest;

export const CORPUS: readonly CorpusClip[] = manifest.clips;

/** Absolute path to a corpus file by clip id (throws on unknown id). */
export function corpusPath(id: string): string {
  const clip = CORPUS.find((c) => c.id === id);
  if (!clip) throw new Error(`corpus: unknown clip id '${id}'`);
  return resolve(CORPUS_DIR, clip.file);
}

/** The clip descriptor by id (throws on unknown id). */
export function corpusClip(id: string): CorpusClip {
  const clip = CORPUS.find((c) => c.id === id);
  if (!clip) throw new Error(`corpus: unknown clip id '${id}'`);
  return clip;
}

/** All video clips — the editor render harness's default input pool. */
export function corpusVideos(): CorpusClip[] {
  return CORPUS.filter((c) => c.kind === 'video');
}
