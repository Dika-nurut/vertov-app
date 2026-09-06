function coordinate(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function compareBoardReadingOrder(
  a: { id: string; position?: { x?: number; y?: number } },
  b: { id: string; position?: { x?: number; y?: number } },
): number {
  const yDifference = coordinate(a.position?.y) - coordinate(b.position?.y);
  if (yDifference !== 0) return yDifference;

  const xDifference = coordinate(a.position?.x) - coordinate(b.position?.x);
  if (xDifference !== 0) return xDifference;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
