// Crop modal — full-screen crop editor for the selected clip (extracted from
// StudioClient.tsx, split 5m/N). Rendered in a PORTAL to document.body so the
// fixed overlay always covers the viewport — it can't be clipped or mis-anchored
// by the editor's `overflow-hidden` grid or any transformed ancestor.
import { createPortal } from 'react-dom';
import { assetSrc } from '@/lib/asset-src';
import { RotateCcw, X } from '../_icons';
import { TripleInput } from '../_kit/controls';
import { DEFAULT_TRANSFORM } from '../_model';
import type { Format, TClip } from '../_model';

export function CropModal({
  clip,
  setCropOpen,
  patchClip,
  format,
}: {
  clip: TClip;
  setCropOpen: (v: boolean) => void;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
  format: Format;
}) {
  const tr = clip.transform ?? DEFAULT_TRANSFORM;
  const crop = tr.crop ?? DEFAULT_TRANSFORM.crop;
  const setCrop = (k: 'left' | 'top' | 'right' | 'bottom', v: number) =>
    patchClip(clip.uid, {
      transform: {
        ...DEFAULT_TRANSFORM,
        ...tr,
        crop: {
          ...DEFAULT_TRANSFORM.crop,
          ...crop,
          [k]: Math.min(0.45, Math.max(0, v / 100)),
        },
      },
    });
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      data-testid="crop-modal"
      style={{ position: 'fixed', inset: 0 }}
      className="z-[80] grid place-items-center bg-[color:var(--color-overlay)] p-4"
      onPointerDown={() => setCropOpen(false)}
    >
      <div
        className="glass-menu w-full max-w-2xl rounded-[var(--radius-md)] p-5"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <span className="font-display text-[16px] font-medium text-[color:var(--color-fg)]">
            Кадрирование
          </span>
          <button
            type="button"
            onClick={() => setCropOpen(false)}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] text-[color:var(--color-faint)] press-inset hover:text-[color:var(--color-fg)]"
          >
            <X size={16} />
          </button>
        </div>
        <div className="grid gap-5 sm:grid-cols-[1fr_minmax(0,200px)]">
          <div
            className="relative mx-auto w-full overflow-hidden rounded-[var(--radius-md)] bg-black"
            style={{ aspectRatio: format.width / format.height, maxHeight: 320 }}
          >
            {clip.assetId && clip.assetUnavailable !== false ? (
              <div className="grid h-full place-items-center text-[13px] font-semibold text-red-200">
                Материал недоступен
              </div>
            ) : (
              <video
                src={`${assetSrc(clip.url)}#t=${clip.inSec + 0.1}`}
                muted
                playsInline
                className="h-full w-full object-contain"
              />
            )}
            <div className="pointer-events-none absolute inset-0">
              <div
                className="absolute left-0 right-0 top-0 bg-black/55"
                style={{ height: `${crop.top * 100}%` }}
              />
              <div
                className="absolute bottom-0 left-0 right-0 bg-black/55"
                style={{ height: `${crop.bottom * 100}%` }}
              />
              <div
                className="absolute left-0 bg-black/55"
                style={{
                  top: `${crop.top * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  width: `${crop.left * 100}%`,
                }}
              />
              <div
                className="absolute right-0 bg-black/55"
                style={{
                  top: `${crop.top * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  width: `${crop.right * 100}%`,
                }}
              />
              <div
                className="absolute border-[1.5px] border-[color:var(--color-accent)]"
                style={{
                  top: `${crop.top * 100}%`,
                  bottom: `${crop.bottom * 100}%`,
                  left: `${crop.left * 100}%`,
                  right: `${crop.right * 100}%`,
                }}
              />
            </div>
          </div>
          <div className="space-y-3">
            <TripleInput
              label="Лево"
              value={Math.round(crop.left * 100)}
              min={0}
              max={45}
              step={1}
              def={0}
              unit="%"
              testid="crop-left"
              onChange={(v) => setCrop('left', v)}
            />
            <TripleInput
              label="Верх"
              value={Math.round(crop.top * 100)}
              min={0}
              max={45}
              step={1}
              def={0}
              unit="%"
              testid="crop-top"
              onChange={(v) => setCrop('top', v)}
            />
            <TripleInput
              label="Право"
              value={Math.round(crop.right * 100)}
              min={0}
              max={45}
              step={1}
              def={0}
              unit="%"
              testid="crop-right"
              onChange={(v) => setCrop('right', v)}
            />
            <TripleInput
              label="Низ"
              value={Math.round(crop.bottom * 100)}
              min={0}
              max={45}
              step={1}
              def={0}
              unit="%"
              testid="crop-bottom"
              onChange={(v) => setCrop('bottom', v)}
            />
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                data-testid="crop-reset"
                onClick={() =>
                  patchClip(clip.uid, {
                    transform: {
                      ...DEFAULT_TRANSFORM,
                      ...tr,
                      crop: { ...DEFAULT_TRANSFORM.crop },
                    },
                  })
                }
                className="press-inset inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-[1.5px] border-[color:var(--color-line2)] text-[13px] font-medium text-[color:var(--color-muted-foreground)] hover:text-[color:var(--color-fg)]"
              >
                <RotateCcw size={13} /> Сброс
              </button>
              <button
                type="button"
                data-testid="crop-apply"
                onClick={() => setCropOpen(false)}
                className="glass-accent inline-flex h-9 flex-1 items-center justify-center rounded-[var(--radius-md)] text-[13px] font-semibold"
              >
                Готово
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
