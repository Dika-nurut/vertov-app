import { describe, expect, it } from 'vitest';
import { buildProjectMap, PROJECT_MAP_MAX_CHARS } from '../src/scenario-context';

describe('buildProjectMap', () => {
  it('maps every non-Film beat and brief field without needing Fountain text', () => {
    const map = buildProjectMap({
      format: 'social',
      brief: { version: 1, platform: 'Reels', durationSeconds: 25, tone: 'ирония' },
      outline: {
        version: 1,
        beats: [
          {
            id: 'h',
            kind: 'hook',
            title: 'Камера падает',
            summary: 'Первый кадр',
            durationSeconds: 3,
          },
          { id: 'c', kind: 'cta', title: 'Открой Vertov', summary: '' },
        ],
      },
      fountain: '',
    });
    expect(map.text).toContain('Формат: Короткое видео');
    expect(map.text).toContain('Площадка: Reels');
    expect(map.text).toContain('[hook] Камера падает');
    expect(map.text).toContain('[cta] Открой Vertov');
    expect(map.itemCount).toBe(2);
  });

  it('derives a Film map from all scene headings plus bounded action excerpts', () => {
    const map = buildProjectMap({
      format: 'film',
      brief: { version: 1 },
      outline: { version: 1, beats: [] },
      fountain:
        'ИНТ. КИНОБУДКА — НОЧЬ\n\nМарк чинит проектор.\n\nНАТ. КРЫША — НОЧЬ\n\nВетер рвёт афиши.\n',
    });
    expect(map.text).toContain('1. ИНТ. КИНОБУДКА — НОЧЬ');
    expect(map.text).toContain('Марк чинит проектор');
    expect(map.text).toContain('2. НАТ. КРЫША — НОЧЬ');
    expect(map.itemCount).toBe(2);
  });

  it('never exceeds the project-map budget and makes omission explicit', () => {
    const map = buildProjectMap({
      format: 'social',
      brief: { version: 1 },
      outline: {
        version: 1,
        beats: Array.from({ length: 100 }, (_, i) => ({
          id: String(i),
          kind: 'development' as const,
          title: `Бит ${i}`,
          summary: 'а'.repeat(4_000),
        })),
      },
      fountain: '',
    });
    expect(map.text.length).toBeLessThanOrEqual(PROJECT_MAP_MAX_CHARS);
    expect(map.omitted).toBe(true);
    expect(map.text).toContain('часть карты опущена');
  });
});
