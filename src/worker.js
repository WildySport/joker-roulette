/* THE PORTAL'S WORKER. Everything is static assets except two endpoints:
 *   POST /api/hit    — a game's beacon (open, throw, bonus, bonuswin): logged
 *                      and written to D1 (binding DB, database bowling-stats)
 *   GET  /api/stats  — aggregates for the stats page; needs ?k=<STATS_KEY>
 * No IPs are kept: country and city from Cloudflare, a coarse user agent,
 * and a per-tab session id the game makes up. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const JSONH = { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' };
const str = (v, n) => String(v ?? '').slice(0, n);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: JSONH });

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
      if (env.DB && hit.game && hit.event) {
        try {
          await env.DB.prepare('INSERT INTO events (t, game, event, sid, n, mode, w, country, city, ua, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .bind(hit.t, hit.game, hit.event, hit.sid, hit.n, hit.mode, hit.w, hit.country, hit.city, hit.ua, hit.ref).run();
        } catch (e) { console.log('D1 insert failed: ' + (e && e.message)); }
      }
      return new Response(null, { status: 204, headers: CORS });
    }
    if (url.pathname === '/api/stats') {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      if (!env.STATS_KEY || url.searchParams.get('k') !== env.STATS_KEY) return json({ error: 'no' }, 403);
      if (!env.DB) return json({ error: 'no database bound' }, 500);
      const game = str(url.searchParams.get('game') || 'bowling', 24);
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const today = new Date().toISOString().slice(0, 10);
      const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
      const [totals, todayTotals, perDay, steps, countries, sessions, all] = await Promise.all([
        q("SELECT COUNT(DISTINCT CASE WHEN event='open' THEN sid END) sessions, SUM(event='throw') throws, SUM(event='throw' AND n=10) strikes, SUM(event='bonus') bonuses, MAX(CASE WHEN event='bonuswin' THEN n END) bigwin FROM events WHERE game=? AND t>=?", game, since),
        q("SELECT COUNT(DISTINCT CASE WHEN event='open' THEN sid END) sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses FROM events WHERE game=? AND t>=?", game, today),
        q("SELECT substr(t,1,10) d, COUNT(DISTINCT CASE WHEN event='open' THEN sid END) sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses FROM events WHERE game=? AND t>=? GROUP BY d ORDER BY d", game, since),
        q("SELECT mode, COUNT(*) c FROM events WHERE game=? AND event='throw' AND t>=? GROUP BY mode ORDER BY c DESC", game, since),
        q("SELECT country, COUNT(DISTINCT sid) sessions, SUM(event='throw') throws FROM events WHERE game=? AND t>=? GROUP BY country ORDER BY sessions DESC LIMIT 12", game, since),
        q("SELECT sid, MIN(t) started, MAX(t) last, MAX(country) country, MAX(city) city, MAX(ua) ua, MAX(w) w, SUM(event='throw') throws, SUM(event='throw' AND n=10) strikes, SUM(event='bonus') bonuses, MAX(CASE WHEN event='bonuswin' THEN n END) bigwin, MAX(ref) ref FROM events WHERE game=? GROUP BY sid ORDER BY started DESC LIMIT 60", game),
        q("SELECT COUNT(DISTINCT CASE WHEN event='open' THEN sid END) sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses, MIN(t) first FROM events WHERE game=?", game),
      ]);
      return json({ game, days, since, now: new Date().toISOString(), totals: totals[0], today: todayTotals[0], perDay, steps, countries, sessions, all: all[0] });
    }
    return env.ASSETS.fetch(request);
  },
};
