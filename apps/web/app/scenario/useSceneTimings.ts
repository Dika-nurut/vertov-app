'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface SceneTimingRevision {
  id: string;
  durationSeconds: number;
  owner: 'vertov' | 'user';
  sourceRevisionId: string;
  stale: boolean;
  sourceChanged: boolean;
  createdAt: string;
}

export interface SceneTiming {
  sourceUnitId: string;
  ordinal: number;
  heading: string;
  synopsis: string;
  sourceRevisionId: string;
  pageEstimate: string | null;
  timing: SceneTimingRevision | null;
}

/** "m:ss" page estimate → whole seconds (never below 1). */
function estimateSeconds(estimate: string | null): number | null {
  const match = estimate ? /^(\d+):(\d{2})$/.exec(estimate) : null;
  if (!match) return null;
  return Math.max(1, Number(match[1]) * 60 + Number(match[2]));
}

/**
 * The one screen-time number per scene: the author's own value, else Vertov's
 * suggestion while its text is unchanged, else the page estimate.
 */
export function sceneSeconds(scene: SceneTiming): number | null {
  const timing = scene.timing;
  if (timing && !timing.stale) return timing.durationSeconds;
  return estimateSeconds(scene.pageEstimate);
}

/** True when the shot planner will accept this scene's timing as it stands. */
export function sceneTimingConfirmed(scene: SceneTiming): boolean {
  return scene.timing?.owner === 'user' && scene.timing.sourceRevisionId === scene.sourceRevisionId;
}

export function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60);
  return `${minutes}:${String(value % 60).padStart(2, '0')}`;
}

export function useSceneTimings(apiUrl: string, scriptId: string, rev: number) {
  const [scenes, setScenes] = useState<SceneTiming[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const base = `${apiUrl}/v1/scripts/${encodeURIComponent(scriptId)}/scene-timings`;

  const reload = useCallback(async (): Promise<SceneTiming[] | null> => {
    const seq = ++loadSeq.current;
    try {
      const response = await fetch(base, {
        credentials: 'include',
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('load');
      const body = (await response.json()) as { scenes: SceneTiming[] };
      if (seq === loadSeq.current) {
        setScenes(body.scenes);
        setError(null);
      }
      return body.scenes;
    } catch {
      if (seq === loadSeq.current) setError('Не удалось загрузить хронометраж.');
      return null;
    }
  }, [base]);

  // Scenes are counted on the saved text, so re-read after every save.
  useEffect(() => {
    const timer = setTimeout(() => void reload(), 300);
    return () => clearTimeout(timer);
  }, [reload, rev]);

  const setSeconds = useCallback(
    async (sourceUnitId: string, durationSeconds: number): Promise<boolean> => {
      try {
        const response = await fetch(`${base}/${encodeURIComponent(sourceUnitId)}`, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ durationSeconds }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error('save');
        const body = (await response.json()) as { timing: SceneTimingRevision };
        setScenes(
          (current) =>
            current?.map((scene) =>
              scene.sourceUnitId === sourceUnitId ? { ...scene, timing: body.timing } : scene,
            ) ?? current,
        );
        return true;
      } catch {
        setError('Не удалось сохранить длительность. Повтори ещё раз.');
        return false;
      }
    },
    [base],
  );

  return { scenes, error, reload, setSeconds };
}
