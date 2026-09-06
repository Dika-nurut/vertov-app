'use client';

import { useTheme } from 'next-themes';
import { Toaster as Sonner, ToasterProps } from 'sonner';

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = 'system' } = useTheme();

  return (
    <Sonner
      theme={theme as 'light' | 'dark' | 'system'}
      style={{ fontFamily: 'inherit', overflowWrap: 'anywhere' }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            'bg-[color:var(--color-bg)] text-foreground border-[color:var(--color-line)] border-2 font-display shadow-[var(--offset-sm)] rounded-[var(--radius-sm)] text-[13px] flex items-center gap-2.5 p-4 w-[356px] [&:has(button)]:justify-between',
          description: 'font-base',
          actionButton:
            'font-base border-2 text-[12px] h-6 px-2 bg-[color:var(--color-accent)] text-[color:var(--color-primary-foreground)] border-[color:var(--color-line)] rounded-[var(--radius-sm)] shrink-0',
          cancelButton:
            'font-base border-2 text-[12px] h-6 px-2 bg-[color:var(--color-surface2)] text-foreground border-[color:var(--color-line)] rounded-[var(--radius-sm)] shrink-0',
          error: 'bg-destructive! text-destructive-foreground!',
          success: 'bg-positive! text-positive-foreground!',
          loading:
            '[&[data-sonner-toast]_[data-icon]]:flex [&[data-sonner-toast]_[data-icon]]:size-4 [&[data-sonner-toast]_[data-icon]]:relative [&[data-sonner-toast]_[data-icon]]:justify-start [&[data-sonner-toast]_[data-icon]]:items-center [&[data-sonner-toast]_[data-icon]]:flex-shrink-0',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
