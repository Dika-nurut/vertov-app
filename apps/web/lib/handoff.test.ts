import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearHandoff,
  parseHandoff,
  peekHandoff,
  serializeHandoff,
  stashHandoff,
  takeHandoff,
} from './handoff';

describe('serializeHandoff / parseHandoff (pure)', () => {
  it('round-trips a URL list', () => {
    const urls = ['https://a/1.mp4', 'https://a/2.png'];
    expect(parseHandoff(serializeHandoff(urls))).toEqual(urls);
  });
  it('drops empty / non-string entries on serialize', () => {
    const raw = serializeHandoff(['https://a/1.mp4', '', undefined as unknown as string]);
    expect(parseHandoff(raw)).toEqual(['https://a/1.mp4']);
  });
  it('returns [] for null, malformed JSON, or a non-array payload', () => {
    expect(parseHandoff(null)).toEqual([]);
    expect(parseHandoff('{not json')).toEqual([]);
    expect(parseHandoff('{"urls":"nope"}')).toEqual([]);
    expect(parseHandoff('{}')).toEqual([]);
  });
});

describe('stashHandoff / takeHandoff (sessionStorage)', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('stashes then takes once, clearing the slot', () => {
    expect(stashHandoff('studio', ['https://a/1.mp4'])).toBe(true);
    expect(peekHandoff('studio')).toEqual(['https://a/1.mp4']);
    expect(peekHandoff('studio')).toEqual(['https://a/1.mp4']);
    expect(takeHandoff('studio')).toEqual(['https://a/1.mp4']);
    // Second take is empty — a refresh must not re-ingest.
    expect(takeHandoff('studio')).toEqual([]);
  });

  it('keeps studio and board slots independent', () => {
    stashHandoff('studio', ['https://a/s.mp4']);
    stashHandoff('board', ['https://a/b.mp4']);
    expect(takeHandoff('board')).toEqual(['https://a/b.mp4']);
    expect(takeHandoff('studio')).toEqual(['https://a/s.mp4']);
  });

  it('does not stash an empty selection', () => {
    expect(stashHandoff('studio', [])).toBe(false);
    expect(takeHandoff('studio')).toEqual([]);
  });

  it('clears a peeked handoff after the consumer commits', () => {
    stashHandoff('studio', ['https://a/strict-mode.mp4']);
    expect(peekHandoff('studio')).toHaveLength(1);
    clearHandoff('studio');
    expect(peekHandoff('studio')).toEqual([]);
  });
});
