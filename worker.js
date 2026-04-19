// Confluence — Cloudflare Worker (Secure API Proxy + Email)
//
// Environment variables (Cloudflare dashboard → Settings → Variables):
//   ANTHROPIC_API_KEY  [Secret]  — Anthropic API key
//   RESEND_API_KEY     [Secret]  — Resend API key
//   ALLOWED_ORIGIN     [Plain]   — GitHub Pages URL
//   FROM_EMAIL         [Plain]   — Verified sender email in Resend (e.g. lens@yourdomain.com)
//   SITE_URL           [Plain]   — Public site URL (e.g. https://abajpai29.github.io/confluence/)
//
// KV Namespace bindings (Settings → Variables → KV Namespace Bindings):
//   RATE_LIMIT  → confluence-rate-limit  (existing, also stores subscribers)
//
// Cron schedule (set via wrangler.toml):
//   "30 1 * * 1-5"  → 7:00 AM IST, Mon–Fri

const MAX_REQUESTS_PER_IP_PER_DAY = 50;
const MAX_TOKENS_CAP = 2200;
const MAX_PROMPT_CHARS = 32000;

export default {
  // ── HTTP handler ────────────────────────────────────────────────
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = (env.ALLOWED_ORIGIN || '').trim();

    const corsHeaders = {
      'Access-Control-Allow-Origin': allowedOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!allowedOrigin || origin !== allowedOrigin) {
      return json({ error: 'Forbidden' }, 403, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    // ── Test email action (temporary) ─────────────────────────────
    if (body.action === 'test-email') {
      await sendDailyReminders(env);
      return json({ ok: true }, 200, corsHeaders);
    }

    // ── Subscribe action ───────────────────────────────────────────
    if (body.action === 'subscribe') {
      const email = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        return json({ error: 'Invalid email' }, 400, corsHeaders);
      }
      if (env.RATE_LIMIT) {
        await env.RATE_LIMIT.put(
          `sub:${email}`,
          JSON.stringify({ email, name: body.name || '', subscribedAt: new Date().toISOString(), source: body.source || 'unknown' })
        );
      }
      return json({ ok: true }, 200, corsHeaders);
    }

    // ── AI proxy ───────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const today = new Date().toISOString().split('T')[0];
    const rlKey = `rl:${ip}:${today}`;

    if (env.RATE_LIMIT) {
      const rawCount = await env.RATE_LIMIT.get(rlKey);
      const count = parseInt(rawCount || '0', 10);
      if (count >= MAX_REQUESTS_PER_IP_PER_DAY) {
        return json({ error: 'Daily limit reached. Come back tomorrow.' }, 429, corsHeaders);
      }
    }

    if (
      !body ||
      !Array.isArray(body.messages) ||
      body.messages.length === 0 ||
      typeof body.messages[0]?.content !== 'string'
    ) {
      return json({ error: 'Invalid request structure' }, 400, corsHeaders);
    }

    const safePayload = {
      model: 'claude-sonnet-4-6',
      max_tokens: MAX_TOKENS_CAP,
      messages: [{
        role: 'user',
        content: body.messages[0].content.slice(0, MAX_PROMPT_CHARS),
      }],
    };

    if (body.system && typeof body.system === 'string') {
      safePayload.system = body.system.slice(0, MAX_PROMPT_CHARS);
    }

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

  // ── Cron handler — runs Mon–Fri 7am IST ─────────────────────────
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDailyReminders(env));
  },
};

async function sendDailyReminders(env) {
  if (!env.RATE_LIMIT || !env.RESEND_API_KEY) return;

  // List all subscriber keys
  const list = await env.RATE_LIMIT.list({ prefix: 'sub:' });
  if (!list.keys.length) return;

  const siteUrl = (env.SITE_URL || 'https://eneth.co').trim();
  const fromEmail = (env.FROM_EMAIL || 'Confluence <onboarding@resend.dev>').trim();
  const subject = 'Think differently today.';

  for (const key of list.keys) {
    const raw = await env.RATE_LIMIT.get(key.name);
    if (!raw) continue;
    let subscriber;
    try { subscriber = JSON.parse(raw); } catch { continue; }
    if (!subscriber.email) continue;

    const html = emailTemplate(siteUrl, subscriber.name || '');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: subscriber.email,
        subject,
        html,
      }),
    });
  }
}

function emailTemplate(siteUrl, name) {
  const greeting = name ? `<div style="font-size:16px;font-weight:300;color:#8a6f52;margin-bottom:16px;">Hi ${name},</div>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>See something new today.</title>
</head>
<body style="margin:0;padding:0;background:#f5f0e8;">
  <div style="max-width:480px;margin:0 auto;padding:48px 32px 56px;font-family:Georgia,'Times New Roman',serif;">
    <div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:500;color:#1a1614;margin-bottom:56px;letter-spacing:0.04em;">Eneth</div>
    ${greeting}<div style="font-size:22px;font-weight:400;color:#1a1614;line-height:1.5;margin-bottom:44px;">See something new today.</div>
    <a href="${siteUrl}" style="display:inline-block;background:#1a1614;color:#f5f0e8;font-family:Georgia,serif;font-size:15px;font-style:italic;padding:14px 32px;text-decoration:none;letter-spacing:0.01em;">Open →</a>
    <div style="margin-top:48px;font-family:Georgia,'Times New Roman',serif;font-size:13px;font-style:italic;font-weight:300;color:#8a6f52;">Think to the nth degree.</div>
  </div>
</body>
</html>`;
}

// ── Helper ─────────────────────────────────────────────────────────
function json(body, status, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}
