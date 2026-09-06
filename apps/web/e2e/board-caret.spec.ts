import { test, expect } from './fixtures';
import type { APIRequestContext, Locator, Page } from '@playwright/test';

/**
 * Regression for the mid-text caret jump: typing into the MIDDLE of an existing
 * prompt moved the caret to the end of the field. Appending at the end always
 * looked correct, which is why this went unnoticed for so long.
 *
 * React restores a controlled field's value right after the input event, but
 * React Flow mirrors controlled nodes into its own store in a passive effect.
 * The restore therefore read the pre-keystroke node value and rewrote the
 * textarea — and rewriting a focused textarea's value parks the caret at the end.
 */

async function newBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
): Promise<string> {
  const res = await request.post(`${apiUrl}/v1/boards`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { title: 'Каретка e2e' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function seedBoard(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  state: Record<string, unknown>,
): Promise<string> {
  const id = await newBoard(request, apiUrl, cookieHeader);
  const res = await request.put(`${apiUrl}/v1/boards/${id}`, {
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    data: { rev: 0, state },
  });
  expect(res.ok()).toBe(true);
  return id;
}

async function savedCastName(
  request: APIRequestContext,
  apiUrl: string,
  cookieHeader: string,
  boardId: string,
): Promise<string | undefined> {
  const res = await request.get(`${apiUrl}/v1/boards/${boardId}`, {
    headers: { cookie: cookieHeader },
  });
  expect(res.ok()).toBe(true);
  const state = (await res.json()) as {
    state: { nodes?: { type?: string; data?: { name?: string } }[] };
  };
  return state.state.nodes?.find((node) => node.type === 'cast')?.data?.name;
}

async function addNode(page: Page, testid: string, nodeClass: string): Promise<void> {
  await page.getByTestId('board-add').click();
  await page.getByTestId(testid).click();
  await expect(page.locator(nodeClass).first()).toBeVisible();
}

/**
 * Put the caret between `mi` and `ddle`, type one character, and report what the
 * field looks like afterwards. Tags the DOM node first so the assertion can tell
 * a caret reset apart from a remount — they are different bugs with different fixes.
 */
async function middleEdit(page: Page, textarea: Locator) {
  const marker = await textarea.evaluate((element) => {
    const id = crypto.randomUUID();
    element.dataset.caretInstance = id;
    return id;
  });

  // Record every write to the field's value plus the selection at each phase, so
  // a failure says WHICH write moved the caret instead of merely that it moved.
  await textarea.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    const trace: Record<string, unknown>[] = [];
    const record = (phase: string, next?: unknown) =>
      trace.push({ phase, next, value: input.value, selectionStart: input.selectionStart });
    // Cast names are an <input>, prompts a <textarea>: take the setter off the
    // element's OWN prototype, or calling it throws "Illegal invocation".
    const prototype =
      element instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.get && descriptor.set) {
      Object.defineProperty(input, 'value', {
        configurable: true,
        get: descriptor.get,
        set(next) {
          record('value-set', next);
          descriptor.set!.call(this, next);
          record('value-set-after');
        },
      });
    }
    input.addEventListener('input', () => {
      record('input');
      queueMicrotask(() => record('microtask'));
      requestAnimationFrame(() => record('frame'));
    });
    (window as Window & { __caretTrace?: Record<string, unknown>[] }).__caretTrace = trace;
  });

  await textarea.focus();
  await textarea.evaluate((element) => (element as HTMLTextAreaElement).setSelectionRange(2, 2));
  const before = await textarea.evaluate(
    (element) => (element as HTMLTextAreaElement).selectionStart,
  );

  await page.keyboard.type('X');

  const after = await textarea.evaluate((element, instance) => {
    const input = element as HTMLTextAreaElement;
    return {
      value: input.value,
      selectionStart: input.selectionStart,
      focused: document.activeElement === input,
      sameNode: input.dataset.caretInstance === instance,
      trace: (window as Window & { __caretTrace?: Record<string, unknown>[] }).__caretTrace,
    };
  }, marker);

  return { before, after };
}

async function expectMiddleEdit(page: Page, textarea: Locator) {
  await expect(textarea).toBeVisible();
  await textarea.fill('middle');
  await expect(textarea).toHaveValue('middle');

  const { before, after } = await middleEdit(page, textarea);

  expect(before).toBe(2);
  expect(after.value).toBe('miXddle');
  expect(after.focused).toBe(true);
  expect(after.sameNode).toBe(true);
  expect(after.selectionStart, JSON.stringify(after.trace, null, 1)).toBe(3);
}

test('prompt card keeps a middle-edit caret next to its insertion', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const id = await newBoard(context.request, apiUrl, cookieHeader);
  await page.goto(`/boards/${id}`);
  await addNode(page, 'add-prompt', '.react-flow__node-prompt');

  await expectMiddleEdit(page, page.getByTestId('node-prompt-text'));
});

test('prompt card keeps a middle-edit caret alongside a generate card', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const id = await newBoard(context.request, apiUrl, cookieHeader);
  await page.goto(`/boards/${id}`);
  await addNode(page, 'add-prompt', '.react-flow__node-prompt');
  // The owner hit this on a board that also carried a generate card, so keep a
  // second node mounted and re-rendering while the prompt is edited.
  await addNode(page, 'add-generate', '.react-flow__node-generate');

  await expectMiddleEdit(page, page.getByTestId('node-prompt-text'));
});

test('cast name keeps a middle-edit caret and saves the edit', async ({
  signedInPage: page,
  context,
  cookieHeader,
  apiUrl,
}) => {
  const id = await seedBoard(context.request, apiUrl, cookieHeader, {
    nodes: [
      {
        id: 'cast-1',
        type: 'cast',
        position: { x: 80, y: 80 },
        data: { castKind: 'character', name: 'middle', imageUrls: [] },
      },
    ],
    edges: [],
  });
  await page.goto(`/boards/${id}`);

  await expectMiddleEdit(page, page.getByTestId('cast-name'));
  await expect(page.getByTestId('save-indicator')).toHaveText('Сохранено', { timeout: 15_000 });
  await expect
    .poll(() => savedCastName(context.request, apiUrl, cookieHeader, id), { timeout: 15_000 })
    .toBe('miXddle');
});
