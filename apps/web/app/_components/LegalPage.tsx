import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cookies } from 'next/headers';
import { renderMarkdown } from '../../lib/render-md';

interface LegalPageProps {
  page: 'faq' | 'tos' | 'privacy' | 'refund' | 'offer' | 'requisites' | 'aup' | 'consent';
  searchParams?: Promise<{ lang?: string }>;
}

export async function LegalPageContent({ page, searchParams }: LegalPageProps) {
  const sp = searchParams ? await searchParams : {};
  const cookieStore = await cookies();
  const langParam = sp.lang ?? cookieStore.get('lang')?.value ?? 'ru';
  const lang = langParam === 'en' ? 'en' : 'ru';

  // Absolute path: resolve from repo root at build time.
  const filePath = join(process.cwd(), 'app/legal/copy', lang, `${page}.md`);
  let markdown: string;
  try {
    markdown = await readFile(filePath, 'utf8');
  } catch {
    // Fallback to RU if EN file missing.
    const fallback = join(process.cwd(), 'app/legal/copy/ru', `${page}.md`);
    markdown = await readFile(fallback, 'utf8');
  }

  const html = renderMarkdown(markdown);

  return (
    <article
      className="legal-prose max-w-none"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
