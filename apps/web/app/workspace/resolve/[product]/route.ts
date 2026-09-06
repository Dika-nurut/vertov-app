import { NextRequest, NextResponse } from 'next/server';
import {
  isResolvableProjectProduct,
  projectDocumentHref,
  projectListHref,
} from '@/lib/project-product-destinations';
import { parseProjectContext, withProjectContext } from '@/lib/project-context';
import { resolveTrustedWebOrigin } from '@/lib/trusted-web-origin';

const API_URL =
  process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

interface ResolveResponse {
  destination?: 'document' | 'list';
  id?: string;
}

export async function GET() {
  return new NextResponse(null, { status: 405, headers: { allow: 'POST' } });
}

export async function POST(req: NextRequest, context: { params: Promise<{ product: string }> }) {
  const { product } = await context.params;
  const projectContext = parseProjectContext(req.nextUrl.search);
  if (!isResolvableProjectProduct(product) || projectContext.mode !== 'project') {
    return new NextResponse(null, { status: 400 });
  }

  const projectId = projectContext.projectId;

  // Scenario is intent-first: opening the product from a desk is a navigation
  // to the start surface, never a reason to create an empty script row. The
  // user chooses an idea, paste, or import there; persistence begins only at
  // that meaningful action. Existing scripts remain available from the list.
  //
  // Every redirect below is pinned to the configured public origin, never to
  // req.nextUrl.origin. Behind a reverse proxy that host is the internal one
  // (localhost:3000), and a proxy that forwards an arbitrary Host would let a
  // caller choose where this 303 points. middleware.ts:121-128 pins for the
  // same reason; this route must not be the weaker of the two.
  const configuredOrigin = process.env.NEXT_PUBLIC_WEB_URL ?? process.env.WEB_PUBLIC_URL;
  const publicOrigin = resolveTrustedWebOrigin({
    nodeEnv: process.env.NODE_ENV,
    ...(configuredOrigin ? { configuredOrigin } : {}),
    requestOrigin: req.nextUrl.origin,
  });
  if (!publicOrigin) {
    return NextResponse.json({ error: 'public_origin_not_configured' }, { status: 503 });
  }
  const listHref = projectListHref(product, projectId);
  const seeOther = (href: string) =>
    NextResponse.redirect(new URL(href, publicOrigin), { status: 303 });
  if (product === 'scenario') {
    return seeOther(withProjectContext('/scenario/new', projectId));
  }

  const apiResponse = await fetch(
    `${API_URL}/v1/projects/${encodeURIComponent(projectId)}/resolve/${product}`,
    {
      method: 'POST',
      headers: { cookie: req.headers.get('cookie') ?? '' },
      cache: 'no-store',
    },
  ).catch(() => null);

  // A dock tile must never dead-end. This route is POST-only, so any failure
  // answered with a bare status leaves the user on a blank page with no way
  // back — every branch below therefore ends in a navigation.
  if (!apiResponse) return seeOther(listHref);
  if (apiResponse.status === 401) {
    const login = new URL('/login', publicOrigin);
    // Send them back to the desk, not here: this URL only answers POST, so a
    // post-login GET would 405.
    login.searchParams.set('next', `/workspace/${encodeURIComponent(projectId)}`);
    return NextResponse.redirect(login, { status: 303 });
  }
  // 404 = the project is gone, foreign or deleted. The list renders that as its
  // invalid-project-context state, which is the honest thing to show.
  if (!apiResponse.ok) return seeOther(listHref);

  const body = (await apiResponse.json().catch(() => null)) as ResolveResponse | null;
  return seeOther(
    body?.destination === 'document' && typeof body.id === 'string'
      ? projectDocumentHref(product, body.id, projectId)
      : listHref,
  );
}
