import { Mark } from '@/components/ui/mark';

/**
 * Wordmark — the canonical brand lockup (SPEC 11-04 / D14): the asterism `Mark`
 * plus the outline «ВЕРТОВ». Replaces the retired accent-plate box that lingered
 * on the public/legal page headers. Drop inside a `<Link href="/">`; the Mark
 * carries the accessible name, the text is decorative.
 */
export function Wordmark({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark variant="plate" size={size} role="img" aria-label="Вертов" />
      <span
        aria-hidden
        className="font-display font-black leading-none tracking-[0.05em] text-transparent [-webkit-text-stroke:1.4px_var(--color-line)]"
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        ВЕРТОВ
      </span>
    </span>
  );
}
