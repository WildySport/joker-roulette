/* THE PORTAL'S WORKER. Everything is static assets except one endpoint:
 * POST /api/hit — a game's beacon (open, throw, bonus, win). Each hit is
 * written to the Worker's logs (observability is on), where they can be read
 * in the Cloudflare dashboard: Workers & Pages → joker-roulette → Logs.
 * No IPs are kept: country and city from Cloudflare, a coarse user agent,
 * and a per-tab session id the game makes up. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const str = (v, n) => String(v ?? '').slice(0, n);
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/hit') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: CORS });
      let body = {};
      try { body = await request.json(); } catch { body = {}; }
      const cf = request.cf || {};
      const hit = {
        t: new Date().toISOString(),
        game: str(body.game, 24), event: str(body.event, 24), sid: str(body.sid, 16),
        n: Number(body.n) || 0, mode: str(body.mode, 12), w: Number(body.w) || 0,
        country: str(cf.country, 4), city: str(cf.city, 40), ua: str(request.headers.get('user-agent'), 90), ref: str(body.ref, 80),
      };
      console.log('HIT ' + JSON.stringify(hit));
      return new Response(null, { status: 204, headers: CORS });
    }
    return env.ASSETS.fetch(request);
  },
};
