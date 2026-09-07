import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AUTH_EMAIL_QUEUE } from '@seed/credits';
import { db, nid, outboxJobs } from '@seed/db';

export const SUPPORT_TOPIC_LABELS = {
  general: 'Общий вопрос',
  billing: 'Оплата',
  refund: 'Возврат денег',
  technical: 'Техническая проблема',
  privacy: 'Персональные данные',
  legal: 'Юридический вопрос',
} as const;

type SupportTopic = keyof typeof SUPPORT_TOPIC_LABELS;

const supportSchema = z.object({
  email: z.string().trim().email().max(320),
  topic: z.enum(Object.keys(SUPPORT_TOPIC_LABELS) as [SupportTopic, ...SupportTopic[]]),
  message: z.string().trim().min(10).max(5_000),
  orderId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional()
    .or(z.literal('')),
  // Honeypot for simple bots. A filled field is acknowledged without sending.
  website: z.string().max(0).optional(),
});

export type SupportEmailPayload = {
  to: string;
  subject: string;
  text: string;
  _reqId?: string;
};

export type SupportRouteDeps = {
  enqueue?: (payload: SupportEmailPayload) => Promise<void>;
  isMailerConfigured?: () => boolean;
  supportEmail?: string;
};

function hasSmtpConfig(): boolean {
  const port = Number(process.env.SMTP_PORT);
  return Boolean(
    process.env.SMTP_HOST &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      process.env.SMTP_FROM,
  );
}

export function supportSubject(topic: SupportTopic): string {
  return `[Vertov support] ${SUPPORT_TOPIC_LABELS[topic]}`;
}

export function supportMessage(input: {
  email: string;
  topic: SupportTopic;
  message: string;
  orderId?: string;
  requestId: string;
}): string {
  return [
    'Новое обращение в поддержку Vertov',
    '',
    `Тема: ${SUPPORT_TOPIC_LABELS[input.topic]}`,
    `Email для ответа: ${input.email}`,
    `Order ID: ${input.orderId || '(не указан)'}`,
    `Request ID: ${input.requestId}`,
    '',
    'Сообщение:',
    input.message,
  ].join('\n');
}

async function enqueueSupportEmail(payload: SupportEmailPayload): Promise<void> {
  const id = nid();
  await db.insert(outboxJobs).values({
    id,
    queueName: AUTH_EMAIL_QUEUE,
    payload,
    jobId: `support-email-${id}`,
  });
}

export function setupSupportRoutes(app: FastifyInstance, deps: SupportRouteDeps = {}): void {
  app.post(
    '/v1/support',
    { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const raw =
        req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      if (typeof raw.website === 'string' && raw.website.length > 0) {
        return reply.status(202).send({ ok: true });
      }

      const parsed = supportSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }

      const requestId = req.id;
      const supportEmail = deps.supportEmail ?? process.env.SUPPORT_EMAIL ?? 'support@vertov.space';
      if (
        process.env.NODE_ENV === 'production' &&
        !(deps.isMailerConfigured?.() ?? hasSmtpConfig())
      ) {
        return reply.status(503).send({ error: 'support_unavailable' });
      }

      const payload: SupportEmailPayload = {
        to: supportEmail,
        subject: supportSubject(parsed.data.topic),
        text: supportMessage({
          email: parsed.data.email,
          topic: parsed.data.topic,
          message: parsed.data.message,
          ...(parsed.data.orderId ? { orderId: parsed.data.orderId } : {}),
          requestId,
        }),
        _reqId: requestId,
      };
      try {
        await (deps.enqueue ?? enqueueSupportEmail)(payload);
      } catch {
        // Do not echo message/email/provider details into logs or the response.
        req.log.error({ requestId }, 'support: enqueue failed');
        return reply.status(503).send({ error: 'support_unavailable' });
      }

      return reply.status(202).send({ ok: true });
    },
  );
}
