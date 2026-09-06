import { BOARD_LIMITS } from './board-contract';
import type { SceneObjectKind } from './scene-objects';

export const GROUP_SEP = ' · ';

function clean(value: string | undefined): string {
  return (value ?? '')
    .replaceAll(GROUP_SEP, '')
    .replace(/[\r\n]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function headingFromTitle(title: string | undefined): string {
  return clean(title)
    .replace(
      /^(?:ИНТ\.?\/НАТ\.?|ИНТ\.?\/ЭКСТ\.?|INT\.?\/EXT\.?|НАТ\.?|ИНТ\.?|INT\.?|EXT\.?)(?=\s|$)\s*/iu,
      '',
    )
    .replace(/\s+[—–]\s+/gu, ', ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function truncateAtWordBoundary(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const contentLimit = Math.max(0, limit - 1);
  let content = '';
  for (const character of value) {
    if (content.length + character.length > contentLimit) break;
    content += character;
  }
  const boundary = content.search(/\s[^\s]*$/u);
  const prefix = boundary > 0 ? content.slice(0, boundary) : content;
  return `${prefix.trimEnd()}…`;
}

/**
 * Build the compact scene snapshot sent to AI-промпт. Casing is deliberately
 * preserved: lowercasing a slugline tail would turn proper nouns such as
 * «ИНТ. ДОМ АННЫ — ВЕЧЕР» into the incorrect «Дом анны, вечер». Uppercase
 * sluglines are the screenplay's convention and the author recognises them;
 * no cheap casing rule can distinguish «АННЫ» from «ВЕЧЕР» safely.
 */
export function buildSceneContext(scene: {
  title?: string;
  synopsis?: string;
  objects?: readonly { kind: SceneObjectKind; name: string }[] | undefined;
}): string {
  const heading = headingFromTitle(scene.title);
  const groupOne = heading ? [heading] : [];
  for (const object of scene.objects ?? []) {
    if (object.kind !== 'place') continue;
    const name = clean(object.name);
    if (
      name.length > 0 &&
      !groupOne.join(', ').toLocaleLowerCase().includes(name.toLocaleLowerCase())
    ) {
      groupOne.push(name);
    }
  }
  const people = (scene.objects ?? [])
    .filter((object) => object.kind === 'person')
    .map((object) => clean(object.name))
    .filter(Boolean);
  const things = (scene.objects ?? [])
    .filter((object) => object.kind === 'thing')
    .map((object) => clean(object.name))
    .filter(Boolean);

  const groups = [groupOne.join(', '), people.join(', '), things.join(', ')].filter(Boolean);
  let result = groups.join(GROUP_SEP);
  const synopsis = clean(scene.synopsis);
  if (result.length < BOARD_LIMITS.sceneContext && synopsis) {
    const withSynopsis = result ? `${result} — ${synopsis}` : synopsis;
    if (withSynopsis.length <= BOARD_LIMITS.sceneContext) result = withSynopsis;
  }
  return truncateAtWordBoundary(result, BOARD_LIMITS.sceneContext);
}
