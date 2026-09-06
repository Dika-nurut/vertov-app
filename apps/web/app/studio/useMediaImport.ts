// Studio local video import (extracted from StudioClient.tsx, split 5a/N).
// Owns the source bin (clips), the in-flight upload progress + dropzone hover,
// and the resumable multipart upload flow (init -> parts -> complete, with
// retry/resume/cancel). addClip (the project op) and onError (a failure sink,
// so the hook never reaches into the global ExportPhase machine) are injected.
import { useCallback, useRef, useState } from 'react';
import type { StudioClip } from './_model';

export function useMediaImport(
  apiUrl: string,
  initialClips: StudioClip[],
  addClip: (url: string) => Promise<void> | void,
  onError: (message: string) => void,
) {
  // Source bin: generated platform clips (initial) + locally-uploaded videos.
  const [clips, setClips] = useState<StudioClip[]>(initialClips);
  // Local-upload state — drag-hover highlight on the dropzone, plus live upload
  // progress (null = idle). Big files go through the resumable multipart flow;
  // `pct` drives the bar and `uploadAbort`/`uploadIdRef` back the Cancel button.
  const [upload, setUpload] = useState<{ pct: number; name: string } | null>(null);
  const importing = upload !== null;
  const [dragOver, setDragOver] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);
  const uploadIdRef = useRef<string | null>(null);

  /* ---------- local video upload (drag-drop / file picker) ----------
     Small files go in one request; anything over a part goes through the
     resumable multipart flow (init → parts → complete) so raw-4K footage of
     several GB clears the edge body cap one chunk at a time. The API streams
     each chunk to MinIO and composes the final asset server-side; we never
     expose storage to the browser. The minted URL drops into the source bin
     and (optionally) onto the timeline; the worker reads it back at render. */
  const PART_SIZE = 32 * 1024 * 1024; // mirror of the API's PART_SIZE

  // Upload one big file in parallel, retried chunks, resumable within a session.
  const uploadMultipart = useCallback(
    async (
      file: File,
      ext: string,
      ac: AbortController,
      onProgress: (pct: number) => void,
    ): Promise<string> => {
      const initRes = await fetch(`${apiUrl}/v1/studio/upload/init`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ext, size: file.size }),
        signal: ac.signal,
      });
      if (!initRes.ok) throw new Error(`init HTTP ${initRes.status}`);
      const { uploadId, partSize, parts } = (await initRes.json()) as {
        uploadId: string;
        partSize: number;
        parts: number;
      };
      uploadIdRef.current = uploadId;

      // Resume: if this is a retry of a half-finished upload, skip parts already
      // stored. (Same-session — the browser can't keep the File across reloads.)
      let stored = new Set<number>();
      try {
        const st = await fetch(`${apiUrl}/v1/studio/upload/status?uploadId=${uploadId}`, {
          credentials: 'include',
          signal: ac.signal,
        });
        if (st.ok) stored = new Set(((await st.json()) as { parts: number[] }).parts);
      } catch {
        /* fresh upload */
      }

      let completed = stored.size;
      onProgress(Math.round((completed / parts) * 100));
      const queue: number[] = [];
      for (let i = 0; i < parts; i++) if (!stored.has(i)) queue.push(i);

      const putPart = async (i: number): Promise<void> => {
        const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (ac.signal.aborted) throw new Error('aborted');
          try {
            const res = await fetch(
              `${apiUrl}/v1/studio/upload/part?uploadId=${uploadId}&index=${i}`,
              {
                method: 'PUT',
                credentials: 'include',
                headers: { 'content-type': 'application/x-seed-upload-part' },
                body: blob,
                signal: ac.signal,
              },
            );
            if (!res.ok) throw new Error(`part ${i} HTTP ${res.status}`);
            completed++;
            onProgress(Math.round((completed / parts) * 100));
            return;
          } catch (e) {
            if (ac.signal.aborted) throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          }
        }
        throw lastErr ?? new Error(`part ${i} failed`);
      };

      // Bounded concurrency — a few parts in flight saturates the link without
      // opening 200 sockets on a 4 GB file.
      const worker = async (): Promise<void> => {
        for (let i = queue.shift(); i !== undefined; i = queue.shift()) await putPart(i);
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length || 1) }, worker));

      const comp = await fetch(`${apiUrl}/v1/studio/upload/complete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId, ext, parts }),
        signal: ac.signal,
      });
      if (!comp.ok) throw new Error(`complete HTTP ${comp.status}`);
      return ((await comp.json()) as { url: string }).url;
    },
    [apiUrl],
  );

  const uploadVideo = useCallback(
    async (file: File, addToTimeline = true) => {
      const extMatch = /\.([a-z0-9]+)$/i.exec(file.name);
      let ext = (extMatch?.[1] ?? 'mp4').toLowerCase();
      if (ext === 'qt') ext = 'mov';
      if (!['mp4', 'mov', 'webm'].includes(ext)) {
        onError(`Формат .${ext} не поддерживается (MP4/MOV/WebM)`);
        return;
      }
      const ac = new AbortController();
      uploadAbort.current = ac;
      uploadIdRef.current = null;
      setUpload({ pct: 0, name: file.name });
      try {
        let url: string;
        if (file.size <= PART_SIZE) {
          const res = await fetch(`${apiUrl}/v1/studio/upload?ext=${ext}`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/octet-stream' },
            body: await file.arrayBuffer(),
            signal: ac.signal,
          });
          if (!res.ok) throw new Error(`upload HTTP ${res.status}`);
          url = ((await res.json()) as { url: string }).url;
          setUpload({ pct: 100, name: file.name });
        } else {
          url = await uploadMultipart(file, ext, ac, (pct) => setUpload({ pct, name: file.name }));
        }
        setClips((cs) => [{ id: `up-${url}`, assetUrl: url }, ...cs]);
        if (addToTimeline) await addClip(url);
      } catch (err) {
        if (!ac.signal.aborted) {
          onError(err instanceof Error ? err.message : 'Ошибка загрузки');
        }
      } finally {
        uploadAbort.current = null;
        uploadIdRef.current = null;
        setUpload(null);
      }
    },
    [apiUrl, addClip, uploadMultipart, PART_SIZE, onError],
  );

  // Cancel an in-flight upload: abort the requests, then best-effort sweep the
  // chunks already parked in storage so a cancelled 4 GB upload leaves nothing.
  const cancelUpload = useCallback(() => {
    uploadAbort.current?.abort();
    const id = uploadIdRef.current;
    if (id) {
      void fetch(`${apiUrl}/v1/studio/upload/abort`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploadId: id }),
      }).catch(() => {});
    }
  }, [apiUrl]);

  // Accept a drop / multi-file pick: upload every video; only the first lands on
  // the timeline so a bulk import fills the bin without stacking the track.
  const onDropFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const vids = Array.from(files).filter(
        (f) => f.type.startsWith('video/') || /\.(mp4|mov|webm|qt)$/i.test(f.name),
      );
      vids.forEach((f, i) => void uploadVideo(f, i === 0));
    },
    [uploadVideo],
  );

  return {
    clips,
    upload,
    importing,
    dragOver,
    setDragOver,
    cancelUpload,
    onDropFiles,
  };
}
