import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
  return (
    <main
      className="mx-auto w-full max-w-5xl px-4 py-6 md:px-6 md:py-10"
      data-testid="settings-loading"
    >
      <Skeleton className="h-8 w-40" />
      <Skeleton className="mt-2 h-4 w-72" />
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Skeleton className="h-28" />
        <Skeleton className="h-56" />
        <Skeleton className="h-40" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-28" />
      </div>
    </main>
  );
}
