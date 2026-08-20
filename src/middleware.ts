// src/middleware.ts
// Lane A — Attribution core. Runs on every HTML request before any page renders.
// Sets cookies: htl_lead_uuid, htl_attr_first, htl_attr_last.
// Skips /api/* and static assets.

import { defineMiddleware } from 'astro:middleware';
import { handleAttribution } from './lib/attribution';

export const onRequest = defineMiddleware(async (context, next) => {
  const { request, url } = context;

  // Skip API routes and static assets
  const accept = request.headers.get('accept') || '';
  if (!accept.includes('text/html')) {
    return next();
  }
  if (url.pathname.startsWith('/api/')) {
    return next();
  }
  // Skip static asset extensions
  if (/\.(ico|png|jpg|jpeg|webp|svg|css|js|json|txt|xml|webmanifest|woff2?)$/i.test(url.pathname)) {
    return next();
  }

  // 301 redirect /ppr → /check-territory (preserves query string)
  if (url.pathname === '/ppr') {
    const target = '/check-territory' + url.search;
    return new Response(null, {
      status: 301,
      headers: { Location: target },
    });
  }

  const cookies = request.headers.get('cookie') || '';
  const { setCookies } = handleAttribution(url, cookies);

  // If no cookies need setting, just continue
  if (setCookies.length === 0) {
    return next();
  }

  // Set cookies on the response
  const res = await next();
  const newRes = new Response(res.body, res);
  for (const cookie of setCookies) {
    newRes.headers.append('Set-Cookie', cookie);
  }
  return newRes;
});
