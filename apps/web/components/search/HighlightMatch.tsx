import { splitSearchMatch } from './search-utils';

export function HighlightMatch({ value, query }: { value: string; query: string }) {
  return (
    <>
      {splitSearchMatch(value, query).map((part, index) =>
        part.match ? (
          <mark key={`${part.text}-${index}`} className="bg-[color:var(--color-accent)] text-black">
            {part.text}
          </mark>
        ) : (
          <span key={`${part.text}-${index}`}>{part.text}</span>
        ),
      )}
    </>
  );
}
