import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AUTH_EMAIL_QUEUE } from '@seed/credits';
import type { AuthEmailAttachment } from '@seed/credits';
import { db, nid, outboxJobs } from '@seed/db';
import {
  SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
  SUPPORT_ATTACHMENT_MAX_FILES,
  SUPPORT_ATTACHMENT_MAX_REQUEST_BYTES,
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
  type SupportAttachmentContentType,
} from '@seed/shared/support-attachments';
import {
  createSupportAttachmentStore,
  type SupportAttachmentStore,
  type SupportAttachmentUpload,
} from './support-attachments';

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
  attachments?: AuthEmailAttachment[];
  _reqId?: string;
};

export type SupportRouteDeps = {
  enqueue?: (payload: SupportEmailPayload) => Promise<void>;
  isMailerConfigured?: () => boolean;
  supportEmail?: string;
  attachmentStore?: SupportAttachmentStore;
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
  attachments?: number;
  requestId: string;
}): string {
  return [
    'Новое обращение в поддержку Vertov',
    '',
    `Тема: ${SUPPORT_TOPIC_LABELS[input.topic]}`,
    `Email для ответа: ${input.email}`,
    `Order ID: ${input.orderId || '(не указан)'}`,
    `Вложения: ${input.attachments ?? 0}`,
    `Request ID: ${input.requestId}`,
    '',
    'Сообщение:',
    input.message,
  ].join('\n');
}

const SUPPORT_FIELD_NAMES = new Set(['email', 'topic', 'orderId', 'message', 'website']);
const EXTENSION_BY_CONTENT_TYPE: Record<SupportAttachmentContentType, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

class SupportMultipartError extends Error {
  constructor(public readonly statusCode: 400 | 413) {
    super('invalid support multipart request');
  }
}

function isMultipartLimitError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413) {
    return true;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return (
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_REQ_FILE_TOO_LARGE'
  );
}

function detectedContentType(bytes: Buffer): SupportAttachmentContentType | null {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a')
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function safeFilename(
  raw: string,
  index: number,
  contentType: SupportAttachmentContentType,
): string {
  const basename = raw.split(/[\\/]/).pop() ?? '';
  const stem = basename
    .normalize('NFKC')
    .replace(/\.[^.]*$/, '')
    .replace(/[^\p{L}\p{N}._() -]/gu, '_')
    .replace(/^\.+$/, '')
    .trim()
    .slice(0, 80);
  return `${stem || `attachment-${index}`}${EXTENSION_BY_CONTENT_TYPE[contentType]}`;
}

interface ParsedSupportMultipart {
  fields: Record<string, string>;
  uploads: SupportAttachmentUpload[];
}

async function parseSupportMultipart(req: FastifyRequest): Promise<ParsedSupportMultipart> {
  const fields: Record<string, string> = {};
  const uploads: SupportAttachmentUpload[] = [];
  let totalBytes = 0;
  let parsingError: SupportMultipartError | null = null;

  try {
    for await (const part of req.parts()) {
      if (parsingError) {
        if (part.type === 'file') part.file.resume();
        continue;
      }
      try {
        if (part.type === 'field') {
          if (
            !SUPPORT_FIELD_NAMES.has(part.fieldname) ||
            Object.prototype.hasOwnProperty.call(fields, part.fieldname) ||
            typeof part.value !== 'string'
          ) {
            throw new SupportMultipartError(400);
          }
          if (part.valueTruncated) throw new SupportMultipartError(413);
          fields[part.fieldname] = part.value;
          continue;
        }

        const bytes = await part.toBuffer();
        if (part.file.truncated || bytes.length > SUPPORT_ATTACHMENT_MAX_FILE_BYTES) {
          throw new SupportMultipartError(413);
        }
        if (part.fieldname !== 'attachments') throw new SupportMultipartError(400);
        if (uploads.length >= SUPPORT_ATTACHMENT_MAX_FILES) throw new SupportMultipartError(413);
        totalBytes += bytes.length;
        if (totalBytes > SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES) {
          throw new SupportMultipartError(413);
        }
        const contentType = detectedContentType(bytes);
        if (!contentType || !SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES.includes(contentType)) {
          throw new SupportMultipartError(400);
        }
        uploads.push({
          filename: safeFilename(part.filename, uploads.length + 1, contentType),
          contentType,
          bytes,
        });
      } catch (error) {
        parsingError =
          error instanceof SupportMultipartError
            ? error
            : new SupportMultipartError(isMultipartLimitError(error) ? 413 : 400);
        if (part.type === 'file') part.file.resume();
      }
    }
  } catch (error) {
    parsingError ??= new SupportMultipartError(isMultipartLimitError(error) ? 413 : 400);
  }

  if (parsingError) throw parsingError;
  return { fields, uploads };
}

function rawSupportFields(req: FastifyRequest): Record<string, unknown> {
  return req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

async function removeStoredAttachments(
  store: SupportAttachmentStore,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  await store.remove(keys).catch(() => {
    // The bucket lifecycle is the final cleanup boundary if cleanup itself fails.
  });
}

let defaultSupportAttachmentStore: SupportAttachmentStore | null = null;

function getDefaultSupportAttachmentStore(): SupportAttachmentStore {
  return (defaultSupportAttachmentStore ??= createSupportAttachmentStore());
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
    {
      bodyLimit: SUPPORT_ATTACHMENT_MAX_REQUEST_BYTES,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      let fields: Record<string, unknown>;
      let uploads: SupportAttachmentUpload[] = [];
      const multipart = typeof req.isMultipart === 'function' && req.isMultipart();
      if (multipart) {
        try {
          const parsed = await parseSupportMultipart(req);
          fields = parsed.fields;
          uploads = parsed.uploads;
        } catch (error) {
          const statusCode = error instanceof SupportMultipartError ? error.statusCode : 400;
          return reply.status(statusCode).send({ error: 'invalid_attachments' });
        }
      } else {
        fields = rawSupportFields(req);
      }

      if (typeof fields.website === 'string' && fields.website.length > 0) {
        return reply.status(202).send({ ok: true });
      }

      const parsed = supportSchema.safeParse(fields);
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

      let store: SupportAttachmentStore | null = null;
      const storedKeys: string[] = [];
      const attachments: AuthEmailAttachment[] = [];
      let enqueueStarted = false;
      try {
        if (uploads.length > 0) {
          store = deps.attachmentStore ?? getDefaultSupportAttachmentStore();
          for (const upload of uploads) {
            const attachment = await store.put({ ...upload, requestId });
            attachments.push(attachment);
            storedKeys.push(attachment.objectKey);
          }
        }

        const payload: SupportEmailPayload = {
          to: supportEmail,
          subject: supportSubject(parsed.data.topic),
          text: supportMessage({
            email: parsed.data.email,
            topic: parsed.data.topic,
            message: parsed.data.message,
            ...(parsed.data.orderId ? { orderId: parsed.data.orderId } : {}),
            attachments: attachments.length,
            requestId,
          }),
          ...(attachments.length > 0 ? { attachments } : {}),
          _reqId: requestId,
        };
        // Once enqueue starts, an error has an ambiguous commit outcome. Do not
        // delete objects that a committed outbox row may already reference.
        enqueueStarted = true;
        await (deps.enqueue ?? enqueueSupportEmail)(payload);
      } catch {
        // Before enqueue starts there cannot be a durable row, so clean up
        // partial uploads. After it starts, lifecycle cleanup is safer than
        // deleting objects from a possibly committed outbox row.
        if (store && !enqueueStarted) await removeStoredAttachments(store, storedKeys);
        // Do not echo message/email/provider details into logs or the response.
        req.log.error({ requestId }, 'support: enqueue failed');
        return reply.status(503).send({ error: 'support_unavailable' });
      }

      return reply.status(202).send({ ok: true });
    },
  );
}
