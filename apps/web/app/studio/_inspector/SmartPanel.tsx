// Inspector smart panel — Seed's "умные инструменты" surface. Two kinds of tool:
// «Авто-рефрейм» runs INSTANTLY (a local transform patch), so it reads as a real
// control with a lime «сразу» spark; the GPU/ML operations are Seed-native — they
// route to generation in «Проекты» (honest routing, no fake on-device AI). Each
// route is a branded action card with an explicit "→ Проекты" hand-off.
import { ArrowUpRight, Gauge, Maximize2, Scissors, Sparkles, Sun } from '../_icons';
import { DEFAULT_TRANSFORM, SMART_ROUTES } from '../_model';
import { useStudioProjectHref } from '../_project-context';
import type { TClip } from '../_model';

// Per-route Phosphor icon (the model's SMART_ROUTES carry no icon).
const ROUTE_ICON: Record<string, typeof Maximize2> = {
  removebg: Scissors,
  retouch: Sparkles,
  relight: Sun,
  slowmo: Gauge,
};

export function SmartPanel({
  clip,
  patchClip,
}: {
  clip: TClip;
  patchClip: (uid: string, patch: Partial<TClip>) => void;
}) {
  const boardsHref = useStudioProjectHref('/boards');
  return (
    <div className="space-y-3" data-testid="insp-pane-smart">
      <p className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
        Умные инструменты Vertov работают через генерацию, а не локальный GPU. «Авто-рефрейм»
        применяется сразу; ИИ-операции открываются в «Проектах».
      </p>

      {/* Instant, local tool — applies immediately. The single lime spark marks it
          apart from the routes that leave the editor. */}
      <button
        type="button"
        data-testid="smart-reframe"
        onClick={() =>
          patchClip(clip.uid, {
            transform: { ...DEFAULT_TRANSFORM, ...clip.transform, scale: 1.1, posX: 0, posY: 0 },
          })
        }
        className="press-inset group flex w-full items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 text-left ring-1 ring-inset ring-[color:var(--color-line)]/15 transition-colors hover:bg-[color:var(--color-surface)]"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-xs)] border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)]">
          <Maximize2 size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
            Авто-рефрейм
          </span>
          <span className="block text-[11px] text-[color:var(--color-faint)]">
            Кадрировать по центру под формат
          </span>
        </span>
        <span
          className="shrink-0 rounded-[var(--radius-xs)] px-1.5 py-0.5 font-mono text-[11px] font-bold uppercase tracking-[0.08em]"
          style={{ background: 'var(--color-accent2)', color: 'var(--color-accent2-foreground)' }}
        >
          сразу
        </span>
      </button>

      {/* GPU/ML operations — generate in «Проекты». Branded cards with a clear
          out-bound hand-off affordance. */}
      <div className="space-y-2">
        {SMART_ROUTES.map((r) => {
          const Icon = ROUTE_ICON[r.id] ?? Sparkles;
          return (
            <a
              key={r.id}
              href={boardsHref}
              data-testid={`smart-${r.id}`}
              className="press-inset group flex w-full items-center gap-3 rounded-[var(--radius-sm)] bg-[color:var(--color-surface2)] p-3 text-left ring-1 ring-inset ring-[color:var(--color-line)]/15 transition-colors hover:bg-[color:var(--color-surface)]"
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-xs)] bg-[rgba(var(--accent-rgb),0.15)] text-[color:var(--color-accent)]">
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-[color:var(--color-fg)]">
                  {r.label}
                </span>
                <span className="block truncate text-[11px] text-[color:var(--color-faint)]">
                  {r.desc}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] font-bold uppercase tracking-[0.06em] text-[color:var(--color-muted-foreground)] transition-colors group-hover:text-[color:var(--color-accent)]">
                Проекты
                <ArrowUpRight size={13} />
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
