import { notFound } from 'next/navigation';

/**
 * P-4 launch policy: the curated preset catalog is parked post-MVP. Keep the
 * landing vitrina and Generate's in-context preset chips alive, but make this
 * old discoverable catalog route impossible to reach or index.
 */
export default function PresetsPage(): never {
  notFound();
}
