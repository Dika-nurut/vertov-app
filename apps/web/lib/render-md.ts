import { marked } from 'marked';

/**
 * Parse markdown string to sanitized HTML.
 *
 * marked converts markdown → raw HTML. The output is then scrubbed with a
 * lightweight allowlist sanitizer that removes <script>, <style>, inline
 * event-handler attributes, and javascript: hrefs before the result is
 * passed to dangerouslySetInnerHTML.
 *
 * We intentionally avoid isomorphic-dompurify here: it pulls in jsdom which
 * tries to load a browser stylesheet from the Next.js process working
 * directory and throws ENOENT in Server Components. All legal-copy markdown
 * is operator-authored (trusted), so a simple tag/attribute allowlist is
 * sufficient (#10 audit fix).
 */

// Tags that are safe to keep in rendered legal/FAQ markdown.
const ALLOWED_TAGS =
  /^(a|b|blockquote|br|code|em|h[1-6]|hr|i|li|ol|p|pre|s|strong|table|tbody|td|th|thead|tr|ul)$/i;

// Attributes allowed on ANY tag.
const ALLOWED_ATTRS_GLOBAL = new Set(['class', 'id']);
// Additional attributes allowed only on <a>.
const ALLOWED_ATTRS_A = new Set(['href', 'target', 'rel']);

function stripDangerousHtml(html: string): string {
  // Remove <script …>…</script> and <style …>…</style> blocks entirely.
  let out = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove all tags not in the allowlist. Replace with their inner content
  // where possible (for inline elements this is fine; block elements will
  // just lose their wrapper which is acceptable).
  out = out.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi, (match, tag, attrs) => {
    if (!ALLOWED_TAGS.test(tag)) return '';

    // Re-build the opening tag keeping only safe attributes.
    if (match.startsWith('</')) return `</${tag}>`;

    const safeAttrs: string[] = [];
    // Match attribute="value" or attribute='value' or attribute=value or standalone
    const attrRe = /([a-z][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/gi;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(attrs)) !== null) {
      if (!m[1]) continue;
      const name = m[1].toLowerCase();
      const value: string = m[2] ?? m[3] ?? m[4] ?? '';

      const allowedForTag =
        tag.toLowerCase() === 'a'
          ? new Set([...ALLOWED_ATTRS_GLOBAL, ...ALLOWED_ATTRS_A])
          : ALLOWED_ATTRS_GLOBAL;

      if (!allowedForTag.has(name)) continue;

      // Reject javascript: URIs in href.
      if (name === 'href' && /^\s*javascript:/i.test(value)) continue;

      safeAttrs.push(value ? `${name}="${value.replace(/"/g, '&quot;')}"` : name);
    }

    const selfClosing = /\/$/.test(attrs.trimEnd()) ? ' /' : '';
    return `<${tag}${safeAttrs.length ? ' ' + safeAttrs.join(' ') : ''}${selfClosing}>`;
  });

  return out;
}

export function renderMarkdown(markdown: string): string {
  const raw = marked.parse(markdown, { async: false }) as string;
  return stripDangerousHtml(raw);
}
