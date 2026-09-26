import { Skeleton } from '@/components/ui/skeleton';

export default function GalleryLoading() {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 py-10" data-testid="gallery-loading">
      <Skeleton className="h-3 w-36" />
      <Skeleton className="mt-3 h-12 w-56" />
      <div className="mt-8 grid gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {Array.from({ length: 10 }, (_, index) => (
          <Skeleton key={index} className="aspect-square" />
        ))}
      </div>
    </div>
  );
}
