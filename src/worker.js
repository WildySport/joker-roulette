/* THE PORTAL'S WORKER. Static assets, plus:
 *   GET  /<game>/     — the game's page, with a small tracker script injected
 *                       (HTMLRewriter) so EVERY game reports who is playing:
 *                       a view on open, a ping every 30s while visible, taps
 *   GET  /wl-track.js — that tracker
 *   POST /api/hit     — a beacon (view, ping, tap, or a game's own open /
 *                       throw / bonus / bonuswin): logged and written to D1
 *   GET  /api/stats   — aggregates for the stats page; needs ?k=<STATS_KEY>
 * No IPs are kept: country and city from Cloudflare, a coarse user agent,
 * and a per-tab session id the page makes up. */
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
const JSONH = { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' };
const str = (v, n) => String(v ?? '').slice(0, n);
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: JSONH });
const GAME_RE = /^\/([a-z][a-z0-9-]*)\/(index\.html)?$/;
const NOT_GAMES = new Set(['assets', 'stats', 'api']);

/* THE TRACKER every game page gets. One session id per tab (the same key a
   game's own beacons use, so its throws join the same session). */
const TRACK_JS = `(function(){
  if (!/wildylabs\\.com$/.test(location.hostname)) return;
  var game = (location.pathname.split('/')[1] || 'portal');
  var sid; try { sid = sessionStorage.getItem('sid'); if (!sid) { sid = Math.random().toString(36).slice(2, 10); sessionStorage.setItem('sid', sid); } } catch (e) { sid = 'na'; }
  var taps = 0;
  function send(event, extra) {
    try {
      var body = JSON.stringify(Object.assign({ game: game, event: event, sid: sid, w: innerWidth, ref: document.referrer.slice(0, 80) }, extra || {}));
      if (navigator.sendBeacon) navigator.sendBeacon('/api/hit', new Blob([body], { type: 'application/json' }));
      else fetch('/api/hit', { method: 'POST', body: body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(function(){});
    } catch (e) {}
  }
  send('view');
  addEventListener('pointerdown', function(){ taps++; }, { passive: true, capture: true });
  setInterval(function(){ if (document.visibilityState === 'visible') { send('ping', { n: taps }); taps = 0; } }, 30000);
  addEventListener('pagehide', function(){ if (taps) send('ping', { n: taps }); });
})();`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/wl-track.js') return new Response(TRACK_JS, { headers: { 'content-type': 'application/javascript', 'cache-control': 'public, max-age=3600' } });
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
      const game = str(url.searchParams.get('game') || 'all', 24);
      const days = Math.max(1, Math.min(90, Number(url.searchParams.get('days')) || 7));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const today = new Date().toISOString().slice(0, 10);
      const G = game === 'all' ? '' : ' AND game=?';
      const gb = (...args) => (game === 'all' ? args : [...args, game]);
      const q = (sql, ...args) => env.DB.prepare(sql).bind(...args).all().then((r) => r.results);
      const SESS = "COUNT(DISTINCT CASE WHEN event IN ('open','view') THEN sid END)";
      const [totals, todayTotals, perDay, steps, countries, sessions, all, games] = await Promise.all([
        q(`SELECT ${SESS} sessions, SUM(event='throw') throws, SUM(event='throw' AND n=10) strikes, SUM(event='bonus') bonuses, MAX(CASE WHEN event='bonuswin' THEN n END) bigwin, SUM(event='ping') pings, SUM(CASE WHEN event='ping' THEN n ELSE 0 END) taps FROM events WHERE t>=?${G}`, ...gb(since)),
        q(`SELECT ${SESS} sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses, SUM(event='ping') pings FROM events WHERE t>=?${G}`, ...gb(today)),
        q(`SELECT substr(t,1,10) d, ${SESS} sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses, SUM(event='ping') pings FROM events WHERE t>=?${G} GROUP BY d ORDER BY d`, ...gb(since)),
        q(`SELECT mode, COUNT(*) c FROM events WHERE event='throw' AND t>=?${G} GROUP BY mode ORDER BY c DESC`, ...gb(since)),
        q(`SELECT country, COUNT(DISTINCT sid) sessions, SUM(event='throw') throws, SUM(event='ping') pings FROM events WHERE t>=?${G} GROUP BY country ORDER BY sessions DESC LIMIT 12`, ...gb(since)),
        q(`SELECT sid, MAX(game) game, MIN(t) started, MAX(t) last, MAX(country) country, MAX(city) city, MAX(ua) ua, MAX(w) w, SUM(event='throw') throws, SUM(event='throw' AND n=10) strikes, SUM(event='bonus') bonuses, MAX(CASE WHEN event='bonuswin' THEN n END) bigwin, SUM(event='ping') pings, SUM(CASE WHEN event='ping' THEN n ELSE 0 END) taps, MAX(ref) ref FROM events WHERE 1=1${G} GROUP BY sid ORDER BY started DESC LIMIT 80`, ...gb()),
        q(`SELECT ${SESS} sessions, SUM(event='throw') throws, SUM(event='bonus') bonuses, SUM(event='ping') pings, MIN(t) first FROM events WHERE 1=1${G}`, ...gb()),
        q(`SELECT game, ${SESS} sessions, SUM(event='ping') pings FROM events WHERE t>=? GROUP BY game ORDER BY sessions DESC`, since),
      ]);
      return json({ game, days, since, now: new Date().toISOString(), totals: totals[0], today: todayTotals[0], perDay, steps, countries, sessions, all: all[0], games });
    }
    /* a game's page: the asset, with the tracker injected */
    const m = url.pathname.match(GAME_RE);
    if (m && !NOT_GAMES.has(m[1]) && request.method === 'GET') {
      const res = await env.ASSETS.fetch(request);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('text/html')) return res;
      return new HTMLRewriter().on('head', { element(el) { el.append('<script src="/wl-track.js" defer></script>', { html: true }); } }).transform(res);
    }
    return env.ASSETS.fetch(request);
  },
};
