'use client';

import { useState } from 'react';

type Topic = 'general' | 'billing' | 'refund' | 'technical' | 'privacy' | 'legal';

const TOPICS: { value: Topic; label: string }[] = [
  { value: 'general', label: 'Общий вопрос' },
  { value: 'billing', label: 'Оплата' },
  { value: 'refund', label: 'Возврат денег' },
  { value: 'technical', label: 'Техническая проблема' },
  { value: 'privacy', label: 'Персональные данные' },
  { value: 'legal', label: 'Юридический вопрос' },
];

export function SupportForm({ apiUrl, initialEmail }: { apiUrl: string; initialEmail: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [topic, setTopic] = useState<Topic>('general');
  const [orderId, setOrderId] = useState('');
  const [message, setMessage] = useState('');
  const [website, setWebsite] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'success' | 'error'; text?: string }>({
    kind: 'idle',
  });
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setState({ kind: 'idle' });
    try {
      const response = await fetch(`${apiUrl}/v1/support`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, topic, orderId, message, website }),
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
