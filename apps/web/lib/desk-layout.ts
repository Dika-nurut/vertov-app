export const DESK_ICON_WIDTH = 108;
export const DESK_ICON_HEIGHT = 110;
export const DESK_COLUMN_GAP = 18;
export const DESK_ROW_GAP = 26;
export const DESK_COLUMN_STEP = DESK_ICON_WIDTH + DESK_COLUMN_GAP;
export const DESK_ROW_STEP = DESK_ICON_HEIGHT + DESK_ROW_GAP;

export interface DeskLayoutPoint {
  x: number;
  y: number;
}

export interface DeskLayoutBounds {
  width: number;
  height: number;
}

function dimensions(bounds: DeskLayoutBounds): { columns: number; rows: number } {
  return {
    columns: Math.max(
      1,
      Math.floor((Math.max(0, bounds.width) + DESK_COLUMN_GAP) / DESK_COLUMN_STEP),
    ),
    rows: Math.max(1, Math.floor((Math.max(0, bounds.height) + DESK_ROW_GAP) / DESK_ROW_STEP)),
  };
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function firstFreeCell(
  occupied: Set<string>,
  columns: number,
  rows: number,
  start = 0,
): { column: number; row: number } {
  const capacity = columns * rows;
  for (let offset = 0; offset < capacity; offset += 1) {
    const index = (start + offset) % capacity;
    const column = index % columns;
    const row = Math.floor(index / columns);
    if (!occupied.has(cellKey(column, row))) return { column, row };
  }
  // An overflowing desk remains reachable by scrolling vertically.
  const index = capacity + occupied.size - capacity;
  return { column: index % columns, row: rows + Math.floor(index / columns) };
}

export function snapDeskPoint(point: DeskLayoutPoint, bounds: DeskLayoutBounds): DeskLayoutPoint {
  const { columns, rows } = dimensions(bounds);
  const column = Math.min(columns - 1, Math.max(0, Math.round(point.x / DESK_COLUMN_STEP)));
  const row = Math.min(rows - 1, Math.max(0, Math.round(point.y / DESK_ROW_STEP)));
  return { x: column * DESK_COLUMN_STEP, y: row * DESK_ROW_STEP };
}

/**
 * Persisted items win cells before new items. Within each group, stable identity
 * decides collision winners so reloads and independent sessions produce the same layout.
 */
export function resolveDeskLayout(
  itemKeys: string[],
  persisted: Readonly<Record<string, DeskLayoutPoint>>,
  bounds: DeskLayoutBounds,
): Record<string, DeskLayoutPoint> {
  const { columns, rows } = dimensions(bounds);
  const keys = [...new Set(itemKeys)];
  const positioned = keys.filter((key) => persisted[key]).sort();
  const unpositioned = keys.filter((key) => !persisted[key]);
  const occupied = new Set<string>();
  const result: Record<string, DeskLayoutPoint> = {};

  for (const key of [...positioned, ...unpositioned]) {
    const candidate = persisted[key] ? snapDeskPoint(persisted[key], bounds) : null;
    let column = candidate ? Math.round(candidate.x / DESK_COLUMN_STEP) : 0;
    let row = candidate ? Math.round(candidate.y / DESK_ROW_STEP) : 0;
    if (!candidate || occupied.has(cellKey(column, row))) {
      const start = candidate ? row * columns + column : 0;
      ({ column, row } = firstFreeCell(occupied, columns, rows, start));
    }
    occupied.add(cellKey(column, row));
    result[key] = { x: column * DESK_COLUMN_STEP, y: row * DESK_ROW_STEP };
  }
  return result;
}

export function moveDeskItem(
  itemKey: string,
  point: DeskLayoutPoint,
  current: Readonly<Record<string, DeskLayoutPoint>>,
  bounds: DeskLayoutBounds,
): Record<string, DeskLayoutPoint> {
  const target = snapDeskPoint(point, bounds);
  const withoutMoved = Object.fromEntries(
    Object.entries(current).filter(([key]) => key !== itemKey),
  );
  const occupied = new Set(
    Object.values(withoutMoved).map((position) => {
      const snapped = snapDeskPoint(position, bounds);
      return cellKey(
        Math.round(snapped.x / DESK_COLUMN_STEP),
        Math.round(snapped.y / DESK_ROW_STEP),
      );
    }),
  );
  const { columns, rows } = dimensions(bounds);
  let column = Math.round(target.x / DESK_COLUMN_STEP);
  let row = Math.round(target.y / DESK_ROW_STEP);
  if (occupied.has(cellKey(column, row))) {
    ({ column, row } = firstFreeCell(occupied, columns, rows, row * columns + column));
  }
  return {
    ...resolveDeskLayout(Object.keys(withoutMoved), withoutMoved, bounds),
    [itemKey]: { x: column * DESK_COLUMN_STEP, y: row * DESK_ROW_STEP },
  };
}
