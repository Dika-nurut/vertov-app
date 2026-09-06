'use client';

import { useEffect, useState } from 'react';

/** The hero's ONE animated element. The owner's actual ask was a wordplay
 *  where one word toggles inside a sentence so you read the range of verbs —
 *  a continuously-scrolling marquee is the wrong MOTION for this brand: the
 *  project's own documented language is hard cuts, never smooth/conveyor
 *  motion. Reuses the existing "Скажи. ___." tagline itself as the toggle
 *  slot — no separate list, no separate box.
 *
 *  (2026-07-02: tried a film-shutter-blade cut; owner reverted — read as a
 *  rendering glitch. 2026-07-07: tried a scale-overshoot "stamp" landing;
 *  owner reverted again — wanted plain swapping, no effect at all. Word now
 *  just cuts straight to the next value.)
 *
 *  2026-07-06 (kinobar workstream): word list cut to the owner's three-beat
 *  production arc — Придумано → Снято → Смонтировано. The per-word font-size
 *  cap is GONE (owner: the word must never change size mid-cycle); instead the
 *  whole H1 carries one uniform size cap sized for the longest word — see
 *  Hero.tsx. */
const WORDS = ['Придумано.', 'Снято.', 'Смонтировано.'];
const HOLD_MS = 1600;

export function HeadlineCycle() {
  const [i, setI] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % WORDS.length), HOLD_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <span
      data-testid="headline-cycle"
      className="inline-block whitespace-nowrap text-[color:var(--color-accent)]"
    >
      {WORDS[i]}
    </span>
  );
}
