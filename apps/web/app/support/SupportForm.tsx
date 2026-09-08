'use client';

import { useRef, useState } from 'react';
import {
  SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES,
  SUPPORT_ATTACHMENT_MAX_FILE_BYTES,
  SUPPORT_ATTACHMENT_MAX_FILES,
  SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES,
} from '@seed/shared/support-attachments';

type Topic = 'general' | 'billing' | 'refund' | 'technical' | 'privacy' | 'legal';

const TOPICS: { value: Topic; label: string }[] = [
  { value: 'general', label: 'Общий вопрос' },
  { value: 'billing', label: 'Оплата' },
  { value: 'refund', label: 'Возврат денег' },
  { value: 'technical', label: 'Техническая проблема' },
  { value: 'privacy', label: 'Персональные данные' },
  { value: 'legal', label: 'Юридический вопрос' },
];

const ATTACHMENT_ACCEPT = SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES.join(',');

function isBrowserAttachmentTypeAllowed(file: File): boolean {
  if (
    SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES.includes(
      file.type as (typeof SUPPORT_ATTACHMENT_ALLOWED_CONTENT_TYPES)[number],
    )
  ) {
    return true;
  }
  return /\.(?:pdf|jpe?g|png|gif|webp)$/i.test(file.name);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function SupportForm({ apiUrl, initialEmail }: { apiUrl: string; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [topic, setTopic] = useState<Topic>('general');
  const [orderId, setOrderId] = useState('');
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'success' | 'error'; text?: string }>({
    kind: 'idle',
  });
  const [busy, setBusy] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  function onAttachmentsChange(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    const totalBytes = selected.reduce((sum, file) => sum + file.size, 0);
    const invalidType = selected.some((file) => !isBrowserAttachmentTypeAllowed(file));
    const tooLarge = selected.some((file) => file.size > SUPPORT_ATTACHMENT_MAX_FILE_BYTES);
    const tooMany = selected.length > SUPPORT_ATTACHMENT_MAX_FILES;
    const totalTooLarge = totalBytes > SUPPORT_ATTACHMENT_MAX_TOTAL_BYTES;

    if (tooMany || tooLarge || totalTooLarge || invalidType) {
      setAttachments([]);
      event.currentTarget.value = '';
      setAttachmentError(
        tooMany
          ? `Можно прикрепить не больше ${SUPPORT_ATTACHMENT_MAX_FILES} файлов.`
          : tooLarge || totalTooLarge
            ? 'Размер вложений должен быть не больше 10 МБ на файл и 30 МБ суммарно.'
            : 'Поддерживаются только изображения JPG, PNG, GIF, WEBP и PDF.',
      );
      return;
    }

    setAttachments(selected);
    setAttachmentError(null);
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (attachmentError) {
      setState({ kind: 'error', text: attachmentError });
      return;
    }
    setBusy(true);
    setState({ kind: 'idle' });
    try {
      const formData = new FormData();
      formData.set('email', email);
      formData.set('topic', topic);
      formData.set('orderId', orderId);
      formData.set('message', message);
      formData.set('website', website);
      for (const file of attachments) formData.append('attachments', file, file.name);

      const response = await fetch(`${apiUrl}/v1/support`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setState({
          kind: 'error',
          text:
            response.status === 429
              ? 'Слишком много обращений. Попробуйте позже.'
              : response.status === 503
                ? 'Поддержка временно недоступна. Попробуйте позже.'
                : response.status === 413 || body.error === 'invalid_attachments'
                  ? 'Проверьте формат и размер вложений.'
                  : body.error === 'invalid_body'
                    ? 'Проверьте email и заполните сообщение.'
                    : 'Не удалось отправить обращение.',
        });
        return;
      }
      setState({
        kind: 'success',
        text: 'Обращение отправлено. Ответим в течение 5 рабочих дней.',
      });
      setOrderId('');
      setMessage('');
      setAttachments([]);
      setAttachmentError(null);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      setWebsite('');
    } catch {
      setState({ kind: 'error', text: 'Сетевая ошибка. Попробуйте ещё раз.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      data-testid="support-form"
      onSubmit={submit}
      className="mt-5 grid gap-4 border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-surface2)] p-4 sm:p-5"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1.5">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
            Email для ответа
          </span>
          <input
            data-testid="support-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-3 py-2.5 text-sm outline-none focus:shadow-[3px_3px_0_0_var(--color-accent)]"
            placeholder="you@example.com"
          />
        </label>
        <label className="grid gap-1.5">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">Тема</span>
          <select
            data-testid="support-topic"
            value={topic}
            onChange={(event) => setTopic(event.target.value as Topic)}
            className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-3 py-2.5 text-sm outline-none focus:shadow-[3px_3px_0_0_var(--color-accent)]"
          >
            {TOPICS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
          Order ID{' '}
          <span className="font-normal normal-case tracking-normal text-faint">
            (если вопрос об оплате)
          </span>
        </span>
        <input
          data-testid="support-order-id"
          value={orderId}
          onChange={(event) => setOrderId(event.target.value)}
          className="border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-3 py-2.5 text-sm outline-none focus:shadow-[3px_3px_0_0_var(--color-accent)]"
          placeholder="например, IGyTnGFPxCUOzU73TxJuR"
        />
      </label>
      <label className="grid gap-1.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
          Сообщение
        </span>
        <textarea
          data-testid="support-message"
          required
          minLength={10}
          maxLength={5000}
          rows={6}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          className="resize-y border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-3 py-2.5 text-sm outline-none focus:shadow-[3px_3px_0_0_var(--color-accent)]"
          placeholder="Опишите, что произошло и какой результат вы ожидали."
        />
      </label>
      <label className="grid gap-1.5">
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.12em]">
          Вложения{' '}
          <span className="font-normal normal-case tracking-normal text-faint">
            (необязательно, до 3 файлов)
          </span>
        </span>
        <input
          ref={attachmentInputRef}
          data-testid="support-attachments"
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={onAttachmentsChange}
          className="block w-full border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-card)] px-3 py-2.5 text-sm file:mr-3 file:border-0 file:bg-transparent file:font-bold"
        />
        <span className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
          JPG, PNG, GIF, WEBP или PDF; максимум 10 МБ на файл, 30 МБ суммарно.
        </span>
        {attachmentError && (
          <span
            data-testid="support-attachment-error"
            className="text-[13px] font-bold text-destructive"
          >
            {attachmentError}
          </span>
        )}
        {attachments.length > 0 && (
          <ul data-testid="support-attachment-list" className="grid gap-1 text-sm">
            {attachments.map((file) => (
              <li key={`${file.name}-${file.lastModified}`}>
                {file.name} <span className="text-faint">({formatFileSize(file.size)})</span>
              </li>
            ))}
          </ul>
        )}
      </label>
      <label aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
        Website
        <input
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          data-testid="support-submit"
          disabled={busy}
          className="press border-[2.5px] border-[color:var(--color-line)] bg-[color:var(--color-accent)] px-5 py-3 text-sm font-bold text-[color:var(--color-primary-foreground)] shadow-[3px_3px_0_0_var(--color-shadow)] disabled:opacity-60"
        >
          {busy ? 'Отправляем…' : 'Отправить обращение'}
        </button>
        <span className="text-[11px] leading-relaxed text-[color:var(--color-faint)]">
          Не указывайте номер карты, срок действия или CVC. Для платежей достаточно Order ID.
        </span>
      </div>
      {state.text && (
        <p
          data-testid="support-status"
          aria-live="polite"
          className={
            state.kind === 'success'
              ? 'text-[13px] font-bold text-[color:var(--color-positive)]'
              : 'text-[13px] font-bold text-destructive'
          }
        >
          {state.text}
        </p>
      )}
    </form>
  );
}
