import { describe, expect, it } from 'vitest';
import { planSceneContinuityShot, sceneContinuityPrompt } from './scene-continuity-bridge';

const model = {
  id: 'seedream-4-5',
  kind: 'image' as const,
  capabilities: { maxRefs: 14 },
};

const scene = {
  id: 'scene-1',
  type: 'scene' as const,
  version: 1 as const,
  position: { x: 0, y: 0 },
  data: {
    title: 'ИНТ. КАФЕ — ВЕЧЕР',
    synopsis: 'Анна ждёт.',
    sourceText: 'FULL SOURCE MUST NOT LEAK',
    sourceStatus: 'current' as const,
    collapsed: true,
  },
};

const document = {
  schemaVersion: 1,
  nodes: [scene],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  tray: [],
};

function cast(
  id: string,
  name: string,
  images: string[],
  videoUrl?: string,
  castKind: 'character' | 'location' | 'product' = 'character',
) {
  return {
    id,
    name,
    node: {
      id,
      type: 'cast' as const,
      version: 1 as const,
      position: { x: 100, y: 100 },
      data: {
        castKind,
        name,
        imageUrls: images,
        ...(videoUrl ? { videoUrl } : {}),
      },
    },
  };
}

function ids(count: number) {
  return {
    promptId: 'prompt-1',
    shotId: 'shot-1',
    promptEdgeId: 'edge-prompt',
    castEdgeIds: Array.from({ length: count }, (_, index) => `edge-cast-${index}`),
  };
}

describe('scene continuity bridge', () => {
  it('builds the exact editable prompt seed without sourceText', () => {
    const text = sceneContinuityPrompt(scene.data, [
      { ...cast('cast-1', 'Анна', ['a.jpg']), description: 'тёмное каре' },
    ]);
    expect(text).toBe(
      'ИНТ. КАФЕ — ВЕЧЕР\n\nАнна ждёт.\n\nОбъекты:\n- Анна: тёмное каре\n\nКадр: опишите действие и композицию',
    );
    expect(text).not.toContain('FULL SOURCE');
  });

  it('creates one Prompt, one Generate and indexed Cast edges', () => {
    const casts = [cast('cast-1', 'Анна', ['a.jpg']), cast('cast-2', 'Кафе', ['b.jpg'])];
    const result = planSceneContinuityShot({
      document: { ...document, nodes: [...document.nodes, ...casts.map((item) => item.node)] },
      sceneNodeId: scene.id,
      casts,
      model,
      ids: ids(casts.length),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const shotEdges = result.document.edges.filter((edge) => edge.target === result.shotId);
    expect(shotEdges.map((edge) => edge.targetHandle)).toEqual([
      'prompt',
      'images[0]',
      'images[1]',
    ]);
  });

  it('returns an explicit subset when four 4-still cards overflow fourteen refs', () => {
    const casts = Array.from({ length: 4 }, (_, castIndex) =>
      cast(
        `cast-${castIndex}`,
        `Объект ${castIndex}`,
        Array.from({ length: 4 }, (_, imageIndex) => `${castIndex}-${imageIndex}.jpg`),
      ),
    );
    const result = planSceneContinuityShot({
      document: { ...document, nodes: [...document.nodes, ...casts.map((item) => item.node)] },
      sceneNodeId: scene.id,
      casts,
      model,
      ids: ids(casts.length),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.overflow).toHaveLength(4);
    expect(result.reason).toContain('16 из 14');
  });

  it('does not wire an incompatible motion-video pack', () => {
    const item = cast('cast-1', 'Кафе', ['a.jpg'], 'motion.mp4', 'location');
    const result = planSceneContinuityShot({
      document: { ...document, nodes: [...document.nodes, item.node] },
      sceneNodeId: scene.id,
      casts: [item],
      model,
      ids: ids(1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('видео движения');
    expect(result.overflow?.[0]?.disabledReason).toContain('не поддерживает');
  });
});
