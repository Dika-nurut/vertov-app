import { sceneList } from '@seed/screenplay';
import type {
  ScenarioBeatV1,
  ScenarioBriefV1,
  ScenarioFormat,
  ScenarioOutlineV1,
} from '@seed/shared';

/** Bounded semantic map used by normal project-level assistant context. */
export const PROJECT_MAP_MAX_CHARS = 16_000;
const FILM_SCENE_EXCERPT_CHARS = 360;

export interface ProjectMapInput {
  format: ScenarioFormat;
  brief: ScenarioBriefV1;
  outline: ScenarioOutlineV1;
  fountain: string;
}

export interface ProjectMapResult {
  text: string;
  omitted: boolean;
  itemCount: number;
}

/**
 * A deterministic project map, deliberately separate from raw-document
 * reading. It gives every ordinary assistant turn global narrative awareness
 * while preserving the explicit, paid full-read path for literal analysis.
 */
export function buildProjectMap(input: ProjectMapInput): ProjectMapResult {
  const lines = [`=== КАРТА ПРОЕКТА ===`, `Формат: ${formatLabel(input.format)}`];
  const brief = briefLines(input.brief);
  if (brief.length) lines.push('Бриф:', ...brief.map((line) => `- ${line}`));

  const beats = input.outline.beats;
  if (beats.length) {
    lines.push('Биты:');
    for (let i = 0; i < beats.length; i++) lines.push(renderBeat(i + 1, beats[i]!));
  } else if (input.format === 'film') {
    const scenes = sceneList(input.fountain);
    if (scenes.length) {
      lines.push('Сцены:');
      for (const scene of scenes) {
        const excerpt = compactExcerpt(input.fountain.slice(scene.from, scene.to));
        lines.push(`${scene.index}. ${scene.heading}${excerpt ? ` — ${excerpt}` : ''}`);
      }
    } else if (input.fountain.trim()) {
      lines.push(`Черновик без размеченных сцен: ${compactExcerpt(input.fountain)}`);
    }
  }

  const full = lines.join('\n');
  if (full.length <= PROJECT_MAP_MAX_CHARS) {
    return {
      text: full,
      omitted: false,
      itemCount: beats.length || sceneList(input.fountain).length,
    };
  }
  const notice = '\n… часть карты опущена из-за лимита контекста';
  return {
    text: `${full.slice(0, PROJECT_MAP_MAX_CHARS - notice.length)}${notice}`,
    omitted: true,
    itemCount: beats.length || sceneList(input.fountain).length,
  };
}

function briefLines(brief: ScenarioBriefV1): string[] {
  const fields: Array<[string, string | number | undefined]> = [
    ['Цель', brief.goal],
    ['Аудитория', brief.audience],
    ['Площадка', brief.platform],
    ['Длительность, сек', brief.durationSeconds],
    ['Тон', brief.tone],
    ['CTA', brief.cta],
  ];
  const lines = fields
    .filter(([, value]) => value !== undefined)
    .map(([label, value]) => `${label}: ${value}`);
  if (brief.constraints?.length) lines.push(`Ограничения: ${brief.constraints.join('; ')}`);
  return lines;
}

function renderBeat(index: number, beat: ScenarioBeatV1): string {
  const extras = [
    beat.summary,
    beat.visual ? `Визуал: ${beat.visual}` : '',
    beat.spokenText ? `Текст: ${beat.spokenText}` : '',
    beat.onScreenText ? `На экране: ${beat.onScreenText}` : '',
    beat.durationSeconds ? `${beat.durationSeconds} сек` : '',
  ].filter(Boolean);
  return `${index}. [${beat.kind}] ${beat.title}${extras.length ? ` — ${extras.join(' · ')}` : ''}`;
}

function compactExcerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, FILM_SCENE_EXCERPT_CHARS);
}

function formatLabel(format: ScenarioFormat): string {
  return {
    film: 'Фильм / сценарий',
    social: 'Короткое видео',
    ad: 'Реклама / бренд',
    sketch: 'Скетч',
  }[format];
}
