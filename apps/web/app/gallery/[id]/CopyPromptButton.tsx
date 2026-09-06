'use client';

import { useState } from 'react';
import { Check, Copy } from '@/components/ui/icons';

export function CopyPromptButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      data-testid="copy-prompt"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="inline-flex items-center gap-1.5 text-xs text-[color:var(--color-muted-foreground)] transition-colors hover:text-[color:var(--color-fg)]"
      title="Скопировать промпт"
    >
      {copied ? <Check size={13} className="text-positive" /> : <Copy size={13} />}
      {copied ? 'Скопировано' : 'Копировать'}
    </button>
  );
}
