export const revalidate = 3600; // hourly

export default function sitemap(): { url: string; lastModified?: string }[] {
  const base = 'https://vertov.space';
  const routes = [
    '',
    '/pricing',
    '/faq',
    '/support',
    '/legal/offer',
    '/legal/privacy',
    '/legal/tos',
    '/legal/refund',
    '/legal/aup',
    '/legal/requisites',
    '/legal/consent',
  ].map((path) => ({ url: base + path }));
  return routes;
}
