import type { MetadataRoute } from 'next';

const webUrl = process.env.NEXT_PUBLIC_WEB_URL ?? 'https://vertov.space';

// Public marketing + showcase are indexable; authed/transactional surfaces are
// kept out of search results (they 401 for crawlers anyway, but be explicit).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/settings',
          '/return',
          '/billing',
          '/styleguide',
          '/showcase',
          '/presets',
        ],
      },
    ],
    sitemap: `${webUrl}/sitemap.xml`,
    host: webUrl,
  };
}
