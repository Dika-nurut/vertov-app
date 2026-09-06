'use client';

import Link from 'next/link';
import type { RefObject } from 'react';
import { HighlightMatch } from './HighlightMatch';
import { associationLabel, flattenSearchGroups } from './search-utils';
import { SEARCH_TYPE_LABELS, type SearchResponse } from './types';

function ResultIcon({ type }: { type: string }) {
  const glyph =
    type === 'project'
      ? '▰'
      : type === 'script'
        ? '¶'
        : type === 'board'
          ? '⌗'
          : type === 'studio'
            ? '◇'
            : '◫';
  return (
    <span
      aria-hidden
      className="grid size-10 shrink-0 place-items-center border-2 border-[color:var(--color-line)] bg-[color:var(--color-surface2)] font-display text-lg"
    >
      {glyph}
    </span>
  );
}

export function SearchResults({
  response,
  query,
  activeIndex,
  onActiveIndexChange,
  optionRefs,
  listboxId,
  optionIdPrefix,
}: {
  response: SearchResponse;
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  optionRefs: RefObject<Array<HTMLAnchorElement | null>>;
  listboxId: string;
  optionIdPrefix: string;
}) {
  let flatIndex = -1;
  const flatItems = flattenSearchGroups(response.groups);

  if (flatItems.length === 0) {
    return (
      <div className="border-2 border-dashed border-[color:var(--color-line-soft)] px-6 py-14 text-center">
        <p className="font-display text-xl font-black">Ничего не найдено</p>
        <p className="mt-2 text-sm text-[color:var(--color-muted-foreground)]">
          Попробуйте часть названия, имя файла или другой запрос.
        </p>
      </div>
    );
  }

  return (
    <div id={listboxId} role="listbox" aria-label="Результаты поиска">
      {response.groups.map((group) => (
        <section key={group.type} className="mb-7" aria-labelledby={`search-group-${group.type}`}>
          <div className="mb-2 flex items-center gap-3">
            <h2
              id={`search-group-${group.type}`}
              className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[color:var(--color-muted-foreground)]"
            >
              {SEARCH_TYPE_LABELS[group.type]}
            </h2>
            <span className="h-px flex-1 bg-[color:var(--color-line-soft)]" />
            <span className="font-mono text-[10px] text-[color:var(--color-faint)]">
              {group.items.length}
            </span>
          </div>
          <div className="space-y-2">
            {group.items.map((result) => {
              flatIndex += 1;
              const index = flatIndex;
              const active = index === activeIndex;
              return (
                <Link
                  key={`${result.type}:${result.id}`}
                  id={`${optionIdPrefix}-${index}`}
                  ref={(node) => {
                    optionRefs.current[index] = node;
                  }}
                  role="option"
                  aria-selected={active}
                  href={result.href}
                  onMouseMove={() => onActiveIndexChange(index)}
                  onFocus={() => onActiveIndexChange(index)}
                  className={`flex min-w-0 items-center gap-3 border-2 px-3 py-3 outline-none transition-[background-color,box-shadow,transform] ${
                    active
                      ? 'border-[color:var(--color-line)] bg-[color:var(--color-accent)] text-black shadow-[4px_4px_0_0_var(--color-line)]'
                      : 'border-[color:var(--color-line-soft)] bg-[color:var(--color-surface)] hover:border-[color:var(--color-line)]'
                  }`}
                >
                  <ResultIcon type={result.type} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[17px] font-black">
                      <HighlightMatch value={result.title} query={query} />
                    </span>
                    <span
                      className={`mt-1 block truncate font-mono text-[10px] uppercase tracking-[0.08em] ${
                        active ? 'text-black/70' : 'text-[color:var(--color-muted-foreground)]'
                      }`}
                    >
                      {associationLabel(result)}
                    </span>
                  </span>
                  <span
                    aria-hidden
                    className={`font-mono text-lg ${active ? 'text-black' : 'text-[color:var(--color-faint)]'}`}
                  >
                    ↗
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
