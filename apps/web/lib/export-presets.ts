/**
 * Social/export presets for Studio (B-2a). Each maps to the render request's
 * existing width/height/fps/format fields (the worker already honours them), so
 * a preset is just a named, validated dimension+encode bundle — no new render
 * capability. Kept pure so the mapping is unit-tested.
 *
 * Dimensions stay within the render schema's bounds (≤3840 per side, fps 1–60,
 * format mp4|mov) — see apps/api/src/studio.ts renderSchema.
 */

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'mov';
  /** Human-facing aspect tag, e.g. '9:16'. */
  aspect: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  {
    id: 'tiktok',
    label: 'TikTok',
    width: 1080,
    height: 1920,
    fps: 30,
    format: 'mp4',
    aspect: '9:16',
  },
  {
    id: 'reels',
    label: 'Reels',
    width: 1080,
    height: 1920,
    fps: 30,
    format: 'mp4',
    aspect: '9:16',
  },
  {
    id: 'shorts',
    label: 'Shorts',
    width: 1080,
    height: 1920,
    fps: 30,
    format: 'mp4',
    aspect: '9:16',
  },
  {
    id: 'youtube',
    label: 'YouTube',
    width: 1920,
    height: 1080,
    fps: 30,
    format: 'mp4',
    aspect: '16:9',
  },
  {
    id: 'storyboard',
    label: 'Раскадровка',
    width: 1280,
    height: 720,
    fps: 24,
    format: 'mp4',
    aspect: '16:9',
  },
];

export function presetById(id: string): ExportPreset | undefined {
  return EXPORT_PRESETS.find((p) => p.id === id);
}

/** The render-request fields a preset sets (what Studio applies on selection). */
export interface PresetDimensions {
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'mov';
}

export function presetDimensions(preset: ExportPreset): PresetDimensions {
  return { width: preset.width, height: preset.height, fps: preset.fps, format: preset.format };
}
