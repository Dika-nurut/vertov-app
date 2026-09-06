// OpenRouter-shaped Scenario mock. It admits only the floor's streaming economy
// assist or non-streaming structurization request and can inject their failure
// shapes. Never point production at this service.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 4399);
const HOST = process.env.MOCK_HOST ?? '127.0.0.1';
const REWRITE = process.env.MOCK_REWRITE ?? 'ПЕРЕПИСАНО ассистентом.';
const ECONOMY_MODEL = 'qwen/qwen3.5-plus-02-15';
const STRUCTURIZE_MODEL = 'deepseek/deepseek-v4-flash';
const CONTROL_SECRET = process.env.MOCK_CONTROL_SECRET ?? '';
// Optionally append a <rule> tag so the suggestion-engine nudge (spec §5) can
// be exercised. Off by default so the plain apply path stays clean.
const RULE = process.env.MOCK_RULE;
let mode = process.env.MOCK_MODE ?? 'ok';
let delayMs = Number(process.env.MOCK_DELAY_MS ?? 0);
const chunks = [
  'Понял, вот вариант. ',
  `<rewrite>${REWRITE}</rewrite>`,
  ...(RULE ? [`\n<rule>${RULE}</rule>`] : []),
];
const structurize = JSON.stringify({
  format: 'film',
  brief: { version: 1, goal: 'Проверить идею под нагрузкой', inferred: true },
  outline: {
    version: 1,
    beats: [
      {
        id: 'load-setup',
        kind: 'setup',
        title: 'Завязка',
        summary: 'Герой обнаруживает проблему и принимает решение действовать.',
      },
      {
        id: 'load-resolution',
        kind: 'resolution',
        title: 'Развязка',
        summary: 'Решение героя меняет ситуацию и завершает проверяемую арку.',
      },
    ],
  },
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const reject = (req, res, reason, { model, stream } = {}) => {
  const streamState = stream === undefined ? 'absent' : String(stream);
  const detail = `unexpected mock request method=${req.method} url=${req.url} model=${String(model)} stream=${streamState} reason=${reason}`;
  console.error(detail);
  res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: detail }));
};

createServer((req, res) => {
  if (req.url === '/__control' && req.method === 'POST') {
    if (!CONTROL_SECRET || req.headers['x-mock-secret'] !== CONTROL_SECRET) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        const next = JSON.parse(raw || '{}');
        if (typeof next.mode === 'string') mode = next.mode;
        if (Number.isFinite(next.delayMs)) delayMs = Math.max(0, Number(next.delayMs));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ mode, delayMs }));
      } catch {
        res.writeHead(400).end('invalid json');
      }
    });
    return;
  }
  if (req.url !== '/' || req.method !== 'POST') {
    reject(req, res, 'endpoint_or_method');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let parsed;
    try {
      parsed = JSON.parse(body || '{}');
    } catch {
      reject(req, res, 'invalid_json');
      return;
    }
    const isAssist = parsed.stream === true && parsed.model === ECONOMY_MODEL;
    const isStructurize = parsed.stream === undefined && parsed.model === STRUCTURIZE_MODEL;
    if (!isAssist && !isStructurize) {
      reject(req, res, 'payload_shape', parsed);
      return;
    }
    if (mode === 'reset') {
      req.socket.destroy();
      return;
    }
    if (mode === 'hang') return;
    if (mode === '429' || mode === '500') {
      res.writeHead(Number(mode), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock ${mode}` } }));
      return;
    }
    if (isStructurize) {
      await wait(delayMs);
      const content = mode === 'empty' ? '' : mode === 'malformed' ? '{broken' : structurize;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const streamed =
      mode === 'empty'
        ? []
        : mode === 'malformed'
          ? ['<rewrite>незакрытый служебный протокол']
          : chunks;
    for (const c of streamed) {
      await wait(delayMs);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  });
}).listen(PORT, HOST, () =>
  console.log(`mock-openrouter on ${HOST}:${PORT} mode=${mode} delayMs=${delayMs}`),
);
