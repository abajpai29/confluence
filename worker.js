// Confluence — Cloudflare Worker (Secure API Proxy)
//
// Environment variables to set in Cloudflare dashboard (Settings → Variables):
//   ANTHROPIC_API_KEY  [Secret]  — your Anthropic API key
//   ALLOWED_ORIGIN     [Plain]   — your GitHub Pages URL, e.g. https://yourusername.github.io
//
// KV Namespace to create and bind (Settings → Variables → KV Namespace Bindings):
//   Variable name: RATE_LIMIT   → bind to a KV namespace you create called "confluence-rate-limit"
//
// That's it. No token needed in the HTML.

const MAX_REQUESTS_PER_IP_PER_DAY = 3;  // generous for daily habit app
const MAX_TOKENS_CAP = 1800;            // hard ceiling — cannot be overridden by client
const MAX_PROMPT_CHARS = 8000;          // prevent absurdly large prompts

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();

    // Restrict CORS to your domain only — not *
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    // ── Preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Only POST ──────────────────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // ── Origin check ───────────────────────────────────────────
    // Rejects any request not coming from your GitHub Pages domain.
    // Stops browser-based abuse immediately. Non-browser tools
    // cannot set Origin to your domain due to CORS security model.
    if (!allowedOrigin || origin !== allowedOrigin) {
      return json({ error: 'Forbidden' }, 403, corsHeaders);
    }

    // ── IP-based rate limiting via KV ──────────────────────────
    // Each unique IP is limited to MAX_REQUESTS_PER_IP_PER_DAY per day.
    // KV key auto-expires after 24 hours.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const rlKey = `rl:${ip}:${today}`;

    if (env.RATE_LIMIT) {
      const rawCount = await env.RATE_LIMIT.get(rlKey);
      const count = parseInt(rawCount || '0', 10);
      if (count >= MAX_REQUESTS_PER_IP_PER_DAY) {
        return json({ error: 'Daily limit reached. Come back tomorrow.' }, 429, corsHeaders);
      }
    }

    // ── Parse & validate request body ─────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    if (
      !body ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      typeof body.messages[0]?.content !== 'string'
    ) {
      return json({ error: 'Invalid request structure' }, 400, corsHeaders);
    }

    // ── Build a sanitised, server-controlled request ───────────
    // Client cannot override model, cannot request > MAX_TOKENS_CAP,
    // and prompt is capped at MAX_PROMPT_CHARS.
    const safePayload = {
      model: 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS_CAP,
      messages: [{
        role: 'user',
        content: body.messages[0].content.slice(0, MAX_PROMPT_CHARS),
      }],
    };

    // ── Forward to Anthropic ───────────────────────────────────
    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(safePayload),
      });
    } catch (err) {
      return json({ error: 'Failed to reach AI service' }, 502, corsHeaders);
    }

    const data = await anthropicRes.json();

    // ── Increment rate-limit counter only on success ───────────
    if (anthropicRes.ok && env.RATE_LIMIT) {
      const rawCount = await env.RATE_LIMIT.get(rlKey);
      const current = parseInt(rawCount || '0', 10);
      await env.RATE_LIMIT.put(rlKey, String(current + 1), { expirationTtl: 86400 });
    }

    return new Response(JSON.stringify(data), {
      status: anthropicRes.status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  },
};

// ── Helper ─────────────────────────────────────────────────────
function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
