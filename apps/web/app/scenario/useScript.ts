'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAutosaveScheduler } from '../../lib/autosave';
import type { Script } from './_lib';
import type { ScenarioBriefV1, ScenarioFormat, ScenarioOutlineV1 } from '@seed/shared';

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

interface DraftBlob {
  rev: number;
  text: string;
  at: number;
}

const SAVE_TIMEOUT_MS = 15_000;
const draftKey = (id: string) => `scenario-draft:${id}`;

/**
 * Canvas save engine: debounced rev-guarded autosave, a hard-409 conflict
 * banner (the writer's draft is never silently dropped), and a localStorage
 * draft so a crash/close never loses unsaved text.
 */
export function useScript(apiUrl: string, initial: Script) {
  const [title, setTitleState] = useState(initial.title);
  const [rev, setRev] = useState(initial.rev);
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [conflictRev, setConflictRev] = useState<number | null>(null);
  const [conflictServerText, setConflictServerText] = useState<string | null>(null);
  const [conflictLocalText, setConflictLocalText] = useState<string | null>(null);
  /** Recovered-from-crash text to seed the editor with, if any. */
  const [recovered, setRecovered] = useState<string | null>(null);

  const scriptId = initial.id;
  const fountainRef = useRef(initial.fountain);
  const revRef = useRef(initial.rev);
  const suppressRef = useRef(0);
  /** Auto-title to fold into the next fountain autosave (no separate PUT). */
  const pendingTitleRef = useRef<string | null>(null);

  useEffect(() => {
    revRef.current = rev;
  }, [rev]);

  // On mount, recover unsaved edits parked from a prior crash (same rev, newer text).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftKey(scriptId));
      if (!raw) return;
      const d = JSON.parse(raw) as DraftBlob;
      if (d.rev === initial.rev && d.text !== initial.fountain) {
        fountainRef.current = d.text;
        setRecovered(d.text);
        setStatus('dirty');
      } else if (d.rev < initial.rev) {
        localStorage.removeItem(draftKey(scriptId));
      }
    } catch {
      /* ignore malformed draft */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const writeDraft = useCallback(
    (text: string) => {
      try {
        const blob: DraftBlob = { rev: revRef.current, text, at: Date.now() };
        localStorage.setItem(draftKey(scriptId), JSON.stringify(blob));
      } catch {
        /* quota / private mode — non-fatal */
      }
    },
    [scriptId],
  );

  const flush = useCallback(async (): Promise<boolean> => {
    const text = fountainRef.current;
    const title = pendingTitleRef.current;
    setStatus('saving');
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        // Fold a pending auto-title into the same rev-guarded save — no
        // separate metadata PUT racing the fountain autosave.
        body: JSON.stringify({
          fountain: text,
          baseRev: revRef.current,
          ...(title ? { title } : {}),
        }),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { rev: number };
        revRef.current = body.rev;
        setRev(body.rev);
        setStatus('saved');
        setConflictRev(null);
        if (title && pendingTitleRef.current === title) pendingTitleRef.current = null;
        writeDraft(text); // keep the draft in sync with the accepted rev
        return true;
      }
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { rev?: number; fountain?: string };
        // The draft stays put — nothing is lost; the banner offers reload.
        setConflictRev(body.rev ?? null);
        setConflictServerText(body.fountain ?? null);
        setConflictLocalText(text);
        setStatus('conflict');
        return false;
      }
      setStatus('error');
      return false;
    } catch {
      setStatus('error');
      return false;
    }
  }, [apiUrl, scriptId, writeDraft]);

  const scheduler = useMemo(
    () => createAutosaveScheduler(() => void flush(), { debounceMs: 1200, maxWaitMs: 8000 }),
    [flush],
  );

  useEffect(() => {
    const onHide = () => scheduler.flushNow();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      scheduler.cancel();
    };
  }, [scheduler]);

  /** Fed by the editor's onChange. */
  const onEditorChange = useCallback(
    (text: string) => {
      fountainRef.current = text;
      writeDraft(text);
      if (suppressRef.current > 0) {
        // A programmatic edit that already matches the server (an apply) — do
        // not autosave it into a stale-rev 409.
        suppressRef.current -= 1;
        setStatus('saved');
        return;
      }
      if (conflictRev !== null) return; // frozen until the writer reloads
      setStatus('dirty');
      scheduler.schedule();
    },
    [scheduler, writeDraft, conflictRev],
  );

  const setTitle = useCallback(
    async (next: string) => {
      setTitleState(next);
      pendingTitleRef.current = null; // a manual rename wins over any pending auto-title
      await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      }).catch(() => {});
    },
    [apiUrl, scriptId],
  );

  /** Auto-title from the first scene heading — folded into the next autosave. */
  const setAutoTitle = useCallback(
    (next: string) => {
      setTitleState(next);
      pendingTitleRef.current = next;
      scheduler.schedule();
    },
    [scheduler],
  );

  /** Save the first-class brief/outline without routing it through Fountain. */
  const updateStructure = useCallback(
    async (value: {
      format: ScenarioFormat;
      brief: ScenarioBriefV1;
      outline: ScenarioOutlineV1;
    }): Promise<boolean> => {
      setStatus('saving');
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...value, baseRev: revRef.current }),
          signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
        });
        if (res.ok) {
          const body = (await res.json()) as { rev?: number };
          if (typeof body.rev === 'number') {
            revRef.current = body.rev;
            setRev(body.rev);
          }
          setStatus('saved');
          return true;
        }
        setStatus(res.status === 409 ? 'conflict' : 'error');
        return false;
      } catch {
        setStatus('error');
        return false;
      }
    },
    [apiUrl, scriptId],
  );

  /** Called before a programmatic editor edit that the server already has. */
  const markSuppressNext = useCallback((newRev: number) => {
    suppressRef.current += 1;
    revRef.current = newRev;
    setRev(newRev);
  }, []);

  const reload = useCallback(async (): Promise<Script | null> => {
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}`, {
        credentials: 'include',
        signal: AbortSignal.timeout(SAVE_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const fresh = (await res.json()) as Script;
      fountainRef.current = fresh.fountain;
      revRef.current = fresh.rev;
      setRev(fresh.rev);
      setTitleState(fresh.title);
      setConflictRev(null);
      setConflictServerText(null);
      setConflictLocalText(null);
      setStatus('saved');
      localStorage.removeItem(draftKey(scriptId));
      return fresh;
    } catch {
      return null;
    }
  }, [apiUrl, scriptId]);

  return {
    scriptId,
    apiUrl,
    title,
    rev,
    status,
    conflictRev,
    conflictServerText,
    conflictLocalText,
    recovered,
    fountainRef,
    onEditorChange,
    setTitle,
    setAutoTitle,
    updateStructure,
    markSuppressNext,
    saveNow: flush,
    reload,
  };
}
