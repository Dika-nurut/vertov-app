'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { bibleNotes } from '@seed/shared';
import type { MaterialsList, MemoryNote, ScriptBible } from './_lib';

/** File extension → import format for the «⤓ Файл» upload. */
const FILE_EXT: Record<string, string> = {
  txt: 'txt',
  md: 'md',
  markdown: 'markdown',
  fountain: 'fountain',
  spmd: 'spmd',
  docx: 'docx',
  pdf: 'pdf',
  highland: 'highland',
};

const EMPTY: MaterialsList = {
  items: [],
  totalChars: 0,
};

/** Left panel data: «Библия проекта» (editable) + «Материалы» (CRUD + meter). */
export function useProjectPanel(apiUrl: string, scriptId: string, initialBible: ScriptBible) {
  const [materials, setMaterials] = useState<MaterialsList>(EMPTY);
  const [bible, setBible] = useState<ScriptBible>(initialBible);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const failedBibleRef = useRef<ScriptBible | null>(null);
  const failedMaterialRef = useRef<{ id: string; includeInAi: boolean } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/materials`, {
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) setMaterials((await res.json()) as MaterialsList);
    } catch {
      /* leave the last-known list */
    }
  }, [apiUrl, scriptId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Add a material; returns a RU error message on a ceiling breach, else null. */
  const addMaterial = useCallback(
    async (name: string, content: string): Promise<string | null> => {
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/materials`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, content }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          await refresh();
          return null;
        }
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        return b.message ?? 'Не удалось добавить материал.';
      } catch {
        return 'Не удалось добавить материал.';
      }
    },
    [apiUrl, scriptId, refresh],
  );

  const removeMaterial = useCallback(
    async (id: string) => {
      setMaterials((m) => ({
        ...m,
        items: m.items.filter((x) => x.id !== id),
        totalChars: m.totalChars - (m.items.find((x) => x.id === id)?.chars ?? 0),
      }));
      await fetch(`${apiUrl}/v1/scripts/${scriptId}/materials/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      }).catch(() => {});
      await refresh();
    },
    [apiUrl, scriptId, refresh],
  );

  const saveBible = useCallback(
    async (next: ScriptBible) => {
      const previous = bible;
      setBible(next);
      setPersistenceError(null);
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bible: next }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`save bible HTTP ${res.status}`);
        failedBibleRef.current = null;
      } catch {
        setBible(previous);
        failedBibleRef.current = next;
        setPersistenceError('Не удалось сохранить Мир проекта. Изменение отменено.');
      }
    },
    [apiUrl, bible, scriptId],
  );

  // МИР ПРОЕКТА is a flat notes list; legacy typed fields fold in on read and
  // are dropped on the first save (we persist only { notes }).
  const notes: MemoryNote[] = bible.notes?.every((n) => typeof n !== 'string')
    ? (bible.notes as MemoryNote[])
    : bibleNotes(bible).map((content, index) => ({
        id: `legacy-${index}`,
        content,
        includeInAi: true,
      }));
  const addNote = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return Promise.resolve();
      return saveBible({
        notes: [...notes, { id: crypto.randomUUID(), content: t, includeInAi: true }],
      });
    },
    [notes, saveBible],
  );
  const removeNote = useCallback(
    (id: string) => saveBible({ notes: notes.filter((note) => note.id !== id) }),
    [notes, saveBible],
  );
  const toggleNoteContext = useCallback(
    (id: string) =>
      saveBible({
        notes: notes.map((note) =>
          note.id === id ? { ...note, includeInAi: !note.includeInAi } : note,
        ),
      }),
    [notes, saveBible],
  );

  const toggleMaterialContext = useCallback(
    async (id: string, includeInAi: boolean) => {
      const previous = materials;
      setMaterials((current) => ({
        ...current,
        items: current.items.map((item) =>
          item.id === id ? { ...item, includeInAi: includeInAi ? 1 : 0 } : item,
        ),
      }));
      setPersistenceError(null);
      try {
        const res = await fetch(`${apiUrl}/v1/scripts/${scriptId}/materials/${id}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ includeInAi }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`toggle material HTTP ${res.status}`);
        failedMaterialRef.current = null;
        await refresh();
      } catch {
        setMaterials(previous);
        failedMaterialRef.current = { id, includeInAi };
        setPersistenceError('Не удалось изменить память файла. Изменение отменено.');
      }
    },
    [apiUrl, materials, refresh, scriptId],
  );

  const retryPersistence = useCallback(async () => {
    if (failedBibleRef.current) {
      const next = failedBibleRef.current;
      await saveBible(next);
      return;
    }
    if (failedMaterialRef.current) {
      const next = failedMaterialRef.current;
      await toggleMaterialContext(next.id, next.includeInAi);
    }
  }, [saveBible, toggleMaterialContext]);

  /** Attach a file whole (text-extracted server-side). RU error or null. */
  const uploadFile = useCallback(
    async (file: File): Promise<string | null> => {
      const ext = (file.name.split('.').pop() ?? '').toLowerCase();
      const format = FILE_EXT[ext];
      if (!format) return 'Формат файла не поддерживается.';
      try {
        const res = await fetch(
          `${apiUrl}/v1/scripts/${scriptId}/materials/file?format=${format}&name=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/octet-stream' },
            body: await file.arrayBuffer(),
            signal: AbortSignal.timeout(30_000),
          },
        );
        if (res.ok) {
          await refresh();
          return null;
        }
        const b = (await res.json().catch(() => ({}))) as { message?: string };
        return b.message ?? 'Не удалось добавить файл.';
      } catch {
        return 'Не удалось добавить файл.';
      }
    },
    [apiUrl, scriptId, refresh],
  );

  const hasMaterials = materials.items.length > 0;

  return {
    materials,
    bible,
    notes,
    hasMaterials,
    addMaterial,
    removeMaterial,
    uploadFile,
    addNote,
    removeNote,
    toggleNoteContext,
    toggleMaterialContext,
    persistenceError,
    retryPersistence,
    saveBible,
    setBible,
  };
}
