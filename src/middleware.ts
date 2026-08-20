// src/middleware.ts
// Lane A — Attribution core. Runs on every HTML request before any page renders.
// Sets cookies: htl_lead_uuid, htl_attr_first, htl_attr_last.
// Exposes the merged attribution to pages via context.locals.attribution.
// Skips /api/* and static assets.
//
// Also sets the Client-Hints response headers (Lane D3): UA strings are being
// throttled industry-wide; these restore device model / platform version for
// Meta's matching. Free lift on mobile.

import { defineMiddleware } from 'astro:middleware';
import { handleAttribution } from './lib/attribution';

const PERMISSIONS_POLICY =
  'ch-ua-model=(*), ch-ua-platform-version=(*), ch-ua-full-version=(*)';
// Permissions-Policy delegates the hints; Accept-CH asks the browser to send them at all.
const ACCEPT_CH = 'Sec-CH-UA-Model, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version';

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;

  // 301 redirect /ppr → /check-territory (preserves query string).
  // Before the Accept gate so every client gets it, curl included.
  if (url.pathname === '/ppr' || url.pathname === '/ppr/') {
    return new Response(null, {
      status: 301,
      headers: { Location: '/check-territory' + url.search },
    });
  }

  // Skip API routes and static assets
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) {
    return next();
  }
  if (url.pathname.startsWith('/api/')) {
    return next();
  }
  // Skip static asset extensions
  if (/\.(ico|png|jpg|jpeg|webp|svg|css|js|json|txt|xml|webmanifest|woff2?|mp4)$/i.test(url.pathname)) {
    return next();
  }

  const cookies = request.headers.get('cookie') || '';
  const { setCookies, attribution } = handleAttribution(url, cookies);
  context.locals.attribution = attribution;

  const res = await next();
  const newRes = new Response(res.body, res);
  for (const cookie of setCookies) {
    newRes.headers.append('Set-Cookie', cookie);
  }
  // Lane D3 — Client Hints for Meta matching
  newRes.headers.set('Permissions-Policy', PERMISSIONS_POLICY);
  newRes.headers.set('Accept-CH', ACCEPT_CH);
  return newRes;
});
