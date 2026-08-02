/* ══════════════════ JOKER ROULETTE — game logic ══════════════════
   Rounds run automatically on a ~20 second cycle:
     betting window → commit to a future EOS block → wait for the chain
     to produce it → card = block ID (hex) mod 54 → spin → settle.
   One bet engine for both modes — every bet is a (spot, amount) pair
   deducted the moment it is placed and locked when betting closes:
     • simple panel: type an amount, click spots to apply it
     • advanced board: pick a chip, click spots on the table
   All payouts are total-return at 52 ÷ outcomes-covered (the 2 jokers
   losing every non-joker bet is the house edge). */

const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_ORDER = ['spades', 'hearts', 'clubs', 'diamonds'];
const SUITS = {
  spades:   { symbol: '♠', color: 'black' },
  hearts:   { symbol: '♥', color: 'red' },
  clubs:    { symbol: '♣', color: 'black' },
  diamonds: { symbol: '♦', color: 'red' },
};
const JOKERS = ['gold', 'purple'];
const START_BALANCE = 100;

/* board group definitions */
const GROUPS = { 'A-5': ['A', '2', '3', '4', '5'], '6-10': ['6', '7', '8', '9', '10'], 'J-K': ['J', 'Q', 'K'] };
const EVEN_VALUES = ['2', '4', '6', '8', '10', 'Q'];   /* A=1 … Q=12, K=13 */
const ODD_VALUES = ['A', '3', '5', '7', '9', 'J', 'K'];

/* round cycle (ms) — betting + EOS wait + spin + result ≈ 16s */
const BET_MS = 10000;
const SPIN_MS = 3600;
const RESULT_MS = 1200;

/* EOS provable fairness */
const EOS_API = 'https://eos.greymass.com';
const EOS_LOOKAHEAD = 21;    /* ~0.5s per block ⇒ produced just after the 10s betting window closes */
const TOTAL_CARDS = 54n;

/* ── State ───────────────────────────────── */
const state = {
  balance: START_BALANCE,
  lastCard: null,
  history: [],
  round: 0,
  phase: 'idle',              /* betting | resolving | spinning | result */
  boardBets: new Map(),       /* bet key → { total, stack: [chip colours] } */
  mode: 'simple',             /* simple | advanced */
  repeat: { on: false, rounds: 5, left: 0 },
  forceJoker: false,
  eos: { target: null, id: null, source: null },
};

/* snapshot of the most recent round that had money on it, for repeat-bet */
let lastRoundBets = null;     /* { board: Map, total } */

/* ── Persistence ─────────────────────────── */
function save() {
  localStorage.setItem('jokerRoulette', JSON.stringify({
    v: 2,
    balance: state.balance,
    lastCard: state.lastCard,
    history: state.history.slice(0, 10),
  }));
}
function load() {
  try {
    const data = JSON.parse(localStorage.getItem('jokerRoulette'));
    if (data && typeof data.balance === 'number') {
      state.balance = data.balance;
      state.lastCard = data.lastCard || null;
      state.history = Array.isArray(data.history) ? data.history : [];
      /* migrate pre-redesign joker names (green/gold -> gold/purple) */
      if (data.v !== 2) {
        const mig = (c) => {
          if (c && c.kind === 'joker') c.joker = c.joker === 'green' ? 'gold' : 'purple';
          return c;
        };
        state.lastCard = mig(state.lastCard);
        state.history = state.history.map(mig);
      }
    }
  } catch { /* fresh start */ }
}

/* ── Helpers ─────────────────────────────── */
const $ = (id) => document.getElementById(id);
const money = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    sleep(ms).then(() => { throw new Error('timeout'); }),
  ]);
}

function cardFromIndex(i) {
  if (i >= 52) return { kind: 'joker', joker: JOKERS[i - 52] };
  return {
    kind: 'standard',
    value: VALUES[i % 13],
    suit: SUIT_ORDER[Math.floor(i / 13)],
  };
}

const cardKey = (c) => c.kind === 'joker' ? 'j:' + c.joker : c.value + ':' + c.suit;

function cardFromKey(k) {
  const [a, b] = k.split(':');
  return a === 'j' ? { kind: 'joker', joker: b } : { kind: 'standard', value: a, suit: b };
}

/* one full 54-card wheel in random order — every card exactly once */
function shuffledDeck() {
  const deck = Array.from({ length: 54 }, (_, i) => cardFromIndex(i));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardLabel(card) {
  if (card.kind === 'joker') {
    return (card.joker === 'gold' ? 'Gold' : 'Purple') + ' Joker';
  }
  return card.value + SUITS[card.suit].symbol;
}


/* ── Sound effects (synthesized, no assets) ─────────────────────
   Web Audio needs a user gesture before it can play; the engine
   unlocks on the first pointer press and stays silent until then. */
const SFX = (() => {
  let ctx = null, master = null, noiseBuf = null;
  let enabled = (localStorage.getItem('jrSound') || 'on') === 'on';
  const jokerClip = new Audio('assets/joker-event.mp3');
  jokerClip.preload = 'auto';
  jokerClip.volume = 0.55;
  const jokerLandClip = new Audio('assets/joker-land.mp3');
  jokerLandClip.preload = 'auto';
  jokerLandClip.volume = 0.6;

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { enabled = false; return null; }
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.22;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function env(g, t0, a, d, peak) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d);
  }

  function tone(freq, type, a, d, peak, when) {
    if (!enabled || !ctx) return;
    const t0 = ctx.currentTime + (when || 0);
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    env(g, t0, a, d, peak);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + a + d + 0.05);
  }

  function noise(dur, freq, peak, when, q, ftype) {
    if (!enabled || !ctx) return;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime + (when || 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = ftype || 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q || 1;
    const g = ctx.createGain();
    env(g, t0, 0.003, dur, peak);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.06);
  }

  function airWhoosh(when, fPeak, peak, dur) {
    if (!enabled || !ctx) return;
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(fPeak * 0.25, t0);
    f.frequency.exponentialRampToValueAtTime(fPeak, t0 + dur * 0.45);
    f.frequency.exponentialRampToValueAtTime(fPeak * 0.3, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.05);
  }

  return {
    unlock() { if (enabled) ensure(); },
    get on() { return enabled; },
    toggle() {
      enabled = !enabled;
      localStorage.setItem('jrSound', enabled ? 'on' : 'off');
      if (enabled) ensure();
      return enabled;
    },
    /* a poker chip landing on felt */
    chip() { noise(0.045, 4200, 0.5, 0, 2.2); tone(2050, 'sine', 0.002, 0.05, 0.22); },
    /* soft UI tick */
    click() { tone(1500, 'sine', 0.002, 0.03, 0.12); },
    /* card flip whoosh-snap */
    flip() { noise(0.07, 2500, 0.26, 0, 1.2); noise(0.03, 5200, 0.14, 0.05, 2); },
    /* shuffle swap: an airy whoosh (noise through a swept bandpass,
       swelling then falling like a card slicing through air) with two
       soft edge-snaps as the cards settle */
    swap() {
      if (!enabled || !ctx) return;
      if (!noiseBuf) {
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t0 = ctx.currentTime;
      const dur = 0.24 + Math.random() * 0.08;
      const src = ctx.createBufferSource();
      src.buffer = noiseBuf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = 0.9;
      f.frequency.setValueAtTime(420, t0);
      f.frequency.exponentialRampToValueAtTime(2100 + Math.random() * 700, t0 + dur * 0.45);
      f.frequency.exponentialRampToValueAtTime(650, t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.17, t0 + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0); src.stop(t0 + dur + 0.05);
      noise(0.008, 3600 + Math.random() * 1200, 0.06, dur * 0.72, 2.5, 'highpass');
      noise(0.008, 3000 + Math.random() * 1200, 0.05, dur * 0.88, 2.5, 'highpass');
    },
    /* one wheel tick as a card crosses the marker */
    tick() { tone(1120, 'square', 0.001, 0.028, 0.05); noise(0.016, 5200, 0.1, 0, 2); },
    /* the wheel coming to rest: a crisp edge transient, a pitch-dropping
       body thump, a warm knock, and a soft confirmation shimmer */
    land() {
      if (!enabled || !ctx) return;
      const t0 = ctx.currentTime;
      noise(0.012, 3200, 0.22, 0, 2, 'highpass');
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(210, t0);
      o.frequency.exponentialRampToValueAtTime(68, t0 + 0.16);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + 0.25);
      tone(340, 'triangle', 0.003, 0.07, 0.2);
      tone(1318.5, 'sine', 0.01, 0.22, 0.07, 0.03);
      tone(1975.5, 'sine', 0.01, 0.18, 0.045, 0.05);
    },
    /* a soft rising bell arpeggio with a warm underlay — gentle, not fanfare */
    win() {
      if (!enabled || !ctx) return;
      const notes = [1046.5, 1318.51, 1567.98, 2093.0];   /* C6 E6 G6 C7 */
      notes.forEach((f, i) => {
        const w = i * 0.07;
        tone(f, 'sine', 0.008, 0.38, 0.11 - i * 0.012, w);
        tone(f * 2, 'sine', 0.008, 0.22, 0.028, w);        /* bell partial */
      });
      tone(523.25, 'triangle', 0.02, 0.32, 0.05);          /* warm C5 underlay */
    },
    lose() { tone(185, 'sine', 0.005, 0.18, 0.12); },
    clear() { tone(700, 'sine', 0.008, 0.1, 0.11); tone(430, 'sine', 0.008, 0.14, 0.11, 0.06); },
    /* joker event sound: the user's RawAnimate clip, played once at the
       start of the ceremony (assets/joker-event.mp3) */
    jokerRise() {
      if (!enabled) return;
      try {
        jokerClip.currentTime = 0;
        jokerClip.play().catch(() => {});
      } catch (e) { /* not ready yet */ }
      /* one air whoosh per rotation, pitch climbing with the spin */
      ensure();
      [0.60, 0.95, 1.30].forEach((w, i) => airWhoosh(w, 1500 + i * 550, 0.13, 0.22));
    },
    /* joker slam: the user's RawLand clip (assets/joker-land.mp3) */
    jokerSlam() {
      if (!enabled) return;
      try {
        jokerLandClip.currentTime = 0;
        jokerLandClip.play().catch(() => {});
      } catch (e) { /* not ready yet */ }
    },
  };
})();
document.addEventListener('pointerdown', () => SFX.unlock());

/* ── Bet spot definitions ────────────────── */
/* key → { mult, label, wins(card) } */
function boardMeta(key) {
  const [type, a, b] = key.split(':');
  switch (type) {
    case 'card': return {
      mult: 52,
      label: a + SUITS[b].symbol,
      wins: c => c.kind === 'standard' && c.value === a && c.suit === b,
    };
    case 'value': return {
      mult: 13,
      label: a,
      wins: c => c.kind === 'standard' && c.value === a,
    };
    case 'suit': return {
      mult: 4,
      label: SUITS[a].symbol,
      wins: c => c.kind === 'standard' && c.suit === a,
    };
    case 'joker':
      if (a === 'both') return {
        mult: 26,
        label: 'Any Joker',
        wins: c => c.kind === 'joker',
      };
      return {
        mult: 52,
        label: a === 'gold' ? 'Gold' : 'Purple',
        wins: c => c.kind === 'joker' && c.joker === a,
      };
    case 'colour': return {
      mult: 2,
      label: a === 'red' ? 'Green' : 'White',
      wins: c => c.kind === 'standard' && SUITS[c.suit].color === a,
    };
    case 'group': return {
      mult: 13 / GROUPS[a].length,
      label: a,
      wins: c => c.kind === 'standard' && GROUPS[a].includes(c.value),
    };
    case 'pairh': {
      /* split between two horizontally adjacent cards (same suit) — 26x */
      const vi = VALUES.indexOf(a);
      const v2 = VALUES[vi + 1];
      return {
        mult: 26,
        label: a + '+' + v2 + SUITS[b].symbol,
        wins: c => c.kind === 'standard' && c.suit === b && (c.value === a || c.value === v2),
      };
    }
    case 'pairv': {
      /* split between two vertically adjacent cards (same value) — 26x */
      const si = SUIT_ORDER.indexOf(b);
      const s2 = SUIT_ORDER[si + 1];
      return {
        mult: 26,
        label: a + SUITS[b].symbol + SUITS[s2].symbol,
        wins: c => c.kind === 'standard' && c.value === a && (c.suit === b || c.suit === s2),
      };
    }
    case 'quad': {
      /* corner between four cards — 13x */
      const vi = VALUES.indexOf(a);
      const v2 = VALUES[vi + 1];
      const si = SUIT_ORDER.indexOf(b);
      const s2 = SUIT_ORDER[si + 1];
      return {
        mult: 13,
        label: a + '-' + v2 + SUITS[b].symbol + SUITS[s2].symbol,
        wins: c => c.kind === 'standard' && (c.value === a || c.value === v2) && (c.suit === b || c.suit === s2),
      };
    }
    case 'parity': {
      const set = a === 'even' ? EVEN_VALUES : ODD_VALUES;
      return {
        mult: 13 / set.length,
        label: a === 'even' ? 'Even' : 'Odd',
        wins: c => c.kind === 'standard' && set.includes(c.value),
      };
    }
  }
}

const multLabel = (m) => (Math.round(m * 100) / 100).toFixed(2).replace(/\.?0+$/, '') + 'x';

/* ── EOS provable fairness ───────────────── */
function eosRpc(path, body) {
  /* plain-text body avoids a CORS preflight; EOS APIs accept it */
  return fetch(EOS_API + path, { method: 'POST', body: body ? JSON.stringify(body) : undefined })
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
}

async function prepareEos() {
  try {
    const info = await withTimeout(eosRpc('/v1/chain/get_info'), 2500);
    state.eos.target = info.head_block_num + EOS_LOOKAHEAD;
  } catch {
    state.eos.target = null;
  }
  renderFairBar();
}

async function resolveCard() {
  if (state.eos.target) {
    for (let attempt = 0; attempt < 16; attempt++) {
      try {
        const block = await withTimeout(eosRpc('/v1/chain/get_block', { block_num_or_id: state.eos.target }), 2500);
        if (block && block.id) return finish(block.id, 'eos');
      } catch { /* block not produced yet — keep polling */ }
      await sleep(400);
    }
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return finish(hex, 'local');

  function finish(idHex, source) {
    const index = Number(BigInt('0x' + idHex) % TOTAL_CARDS);
    state.eos = { target: source === 'eos' ? state.eos.target : null, id: idHex, source };
    return cardFromIndex(index);
  }
}

function renderFairBar() {
  const e = state.eos;
  let html = '<b>ROUND #' + state.round + '</b>';
  if (e.id) {
    const short = e.id.slice(0, 8) + '…' + e.id.slice(-6);
    if (e.source === 'eos') {
      html += ' • EOS BLOCK #' + e.target + ' • ' + short
        + ' • <a href="https://bloks.io/block/' + e.id + '" target="_blank" rel="noopener">VERIFY</a>';
    } else {
      html += ' • LOCAL FALLBACK (EOS unreachable) • ' + short;
    }
  } else if (e.target) {
    html += ' • EOS BLOCK #' + e.target + ' • waiting for block…';
  } else {
    html += ' • EOS BLOCK • connecting…';
  }
  $('fairBar').innerHTML = html;
}

/* ── Placing bets (shared engine) ────────── */
const boardCells = new Map();    /* bet key → advanced board cell element */
const simpleOpts = new Map();    /* bet key → simple panel button element */

function betAmountValue() {
  const v = parseFloat($('betAmount').value);
  return isNaN(v) || v <= 0 ? 0 : round2(v);
}

function selectedChip() {
  const sel = document.querySelector('.bchip.selected');
  if (!sel) return null;
  const color = sel.dataset.color || 'custom';
  let amount;
  if (sel.dataset.chip === 'custom') {
    const v = parseFloat($('customChip').value);
    amount = isNaN(v) || v <= 0 ? 0 : round2(v);
  } else {
    amount = parseFloat(sel.dataset.chip);
  }
  return { amount, color };
}

function cloneBoard(map) {
  return new Map([...map].map(([k, v]) => [k, { total: v.total, stack: [...v.stack] }]));
}

function denyBalance() {
  const el = $('balance');
  el.classList.remove('deny');
  void el.offsetWidth;
  el.classList.add('deny');
}

function placeBetOn(key, amount, color) {
  if (state.phase !== 'betting' || amount <= 0) return;
  if (amount > state.balance) { denyBalance(); return; }
  state.balance = round2(state.balance - amount);
  const bet = state.boardBets.get(key) || { total: 0, stack: [] };
  bet.total = round2(bet.total + amount);
  bet.stack.push(color);
  if (bet.stack.length > 8) bet.stack.shift();
  state.boardBets.set(key, bet);
  save();
  renderBalance(false);
  renderBets();
  SFX.chip();
}

function placeChip(key) {
  const chip = selectedChip();
  if (chip) placeBetOn(key, chip.amount, chip.color);
}

/* pick the chip colour that matches an amount, so a simple-panel bet
   shows the same chip a player would grab from the advanced tray */
const CHIP_TIERS = [
  [1000, 'c1k'], [500, 'c500'], [100, 'c100'], [50, 'c50'],
  [5, 'c5'], [2, 'c2'], [1, 'c1'],
];
function chipColorFor(amount) {
  for (const [v, cls] of CHIP_TIERS) if (amount >= v) return cls;
  return 'custom';
}

function placeSimple(key) {
  const amt = betAmountValue();
  placeBetOn(key, amt, chipColorFor(amt));
}

function clearBets() {
  if (state.phase !== 'betting' || state.boardBets.size === 0) return;
  let refund = 0;
  for (const bet of state.boardBets.values()) refund = round2(refund + bet.total);
  state.boardBets.clear();
  state.balance = round2(state.balance + refund);
  save();
  renderBalance(false);
  renderBets();
  SFX.clear();
}

function boardTotal() {
  let total = 0;
  for (const bet of state.boardBets.values()) total = round2(total + bet.total);
  return total;
}

function stakeText(n) {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : Math.round(k * 10) / 10) + 'K';
  }
  if (n >= 100) return Math.round(n).toString();
  return n.toFixed(2).replace(/^0/, '').replace(/\.?0+$/, '') || '0';
}

/* ── Rendering bets everywhere ───────────── */
const SECTION_OF = (key) => key.split(':')[0];

function renderBets(resultCard) {
  /* advanced board: chip stacks on cells */
  for (const [key, el] of boardCells) {
    let stackEl = el.querySelector('.stake-stack');
    const bet = state.boardBets.get(key);
    if (bet && bet.total > 0) {
      if (!stackEl) {
        stackEl = document.createElement('span');
        stackEl.className = 'stake-stack';
        el.appendChild(stackEl);
      }
      const layers = bet.stack.slice(-6);
      stackEl.innerHTML = layers.map((color, i) => {
        const top = i === layers.length - 1;
        return '<span class="pchip pchip-' + color + '" style="--i:' + i + '">'
          + (top ? '<b>' + stakeText(bet.total) + '</b>' : '')
          + '</span>';
      }).join('');
    } else if (stackEl) {
      stackEl.remove();
    }
  }

  /* simple panel: real chip stacks on the option buttons + value grid tiles */
  for (const [key, btn] of simpleOpts) {
    let stackEl = btn.querySelector('.opt-chips');
    const bet = state.boardBets.get(key);
    if (bet && bet.total > 0) {
      if (!stackEl) {
        stackEl = document.createElement('span');
        stackEl.className = 'opt-chips';
        btn.appendChild(stackEl);
      }
      const layers = bet.stack.slice(-4);
      stackEl.innerHTML = layers.map((color, i) => {
        const top = i === layers.length - 1;
        return '<span class="pchip pchip-' + color + '" style="--i:' + i + '">'
          + (top ? '<b>' + stakeText(bet.total) + '</b>' : '')
          + '</span>';
      }).join('');
      const won = !!resultCard && boardMeta(key).wins(resultCard);
      stackEl.classList.toggle('win', won);
      stackEl.classList.toggle('lose', !!resultCard && !won);
      btn.classList.add('has-bet');
    } else {
      if (stackEl) stackEl.remove();
      btn.classList.remove('has-bet');
    }
  }

  /* per-section summaries where the amount inputs used to sit */
  const sections = { joker: [], value: [], suit: [], colour: [] };
  for (const [key, bet] of state.boardBets) {
    const section = SECTION_OF(key);
    if (sections[section]) sections[section].push([key, bet]);
  }
  for (const section of Object.keys(sections)) {
    const wrap = $('sum-' + section);
    if (!wrap) continue;
    wrap.innerHTML = '';
    if (sections[section].length === 0) {
      wrap.innerHTML = '<span class="summary-empty">No bets</span>';
      continue;
    }
    for (const [key, bet] of sections[section]) {
      const meta = boardMeta(key);
      const chip = document.createElement('span');
      chip.className = 'chip';
      let suffix = '';
      if (resultCard) {
        const won = meta.wins(resultCard);
        chip.classList.add(won ? 'chip-win' : 'chip-lose');
        suffix = won ? ' ✔ +' + money(round2(bet.total * meta.mult)) : ' ✘';
      }
      chip.innerHTML = meta.label + ' <b>' + money(bet.total) + '</b>' + suffix;
      wrap.appendChild(chip);
    }
  }

  /* combined bet summary at the bottom of the simple panel */
  const sumWrap = $('summaryChips');
  if (sumWrap) {
    sumWrap.innerHTML = '';
    if (state.boardBets.size === 0) {
      sumWrap.innerHTML = '<span class="summary-empty">No bets placed yet</span>';
    } else {
      const PREFIX = { joker: 'Joker', value: 'Value', suit: 'Suit', colour: 'Colour', card: 'Card', group: 'Group', parity: '', pairh: 'Split', pairv: 'Split', quad: 'Corner' };
      for (const [key, bet] of state.boardBets) {
        const meta = boardMeta(key);
        const prefix = PREFIX[SECTION_OF(key)];
        const chip = document.createElement('span');
        chip.className = 'chip';
        let suffix = '';
        if (resultCard) {
          const won = meta.wins(resultCard);
          chip.classList.add(won ? 'chip-win' : 'chip-lose');
          suffix = won ? ' ✔ +' + money(round2(bet.total * meta.mult)) : ' ✘';
        }
        chip.innerHTML = (prefix ? prefix + ': ' : '') + meta.label + ' <b>' + money(bet.total) + '</b>' + suffix;
        sumWrap.appendChild(chip);
      }
    }
    $('summaryTotal').textContent = money(boardTotal());
    $('summaryMax').textContent = money(maxPotentialWin());
  }

  /* value button label: which values carry bets */
  const valueBets = [...state.boardBets.keys()]
    .filter(k => k.startsWith('value:'))
    .map(k => k.split(':')[1]);
  $('valueBtnLabel').textContent = valueBets.length === 0 ? 'Pick'
    : valueBets.length <= 4 ? valueBets.join(' ')
    : valueBets.slice(0, 3).join(' ') + ' +' + (valueBets.length - 3);

  /* totals + wheel highlights */
  const total = money(boardTotal());
  $('boardTotal').textContent = total;
  $('simpleTotal').textContent = total;
  renderStripHighlights();
}

/* best possible payout over all 54 outcomes — one card settles every bet */
function maxPotentialWin() {
  let best = 0;
  for (let i = 0; i < 54; i++) {
    const card = cardFromIndex(i);
    let w = 0;
    for (const [key, bet] of state.boardBets) {
      if (boardMeta(key).wins(card)) w += bet.total * boardMeta(key).mult;
    }
    if (w > best) best = w;
  }
  return round2(best);
}

function clearRoundMarks() {
  for (const el of boardCells.values()) el.classList.remove('cell-hit', 'cell-win', 'cell-lose');
}

function markBoardResults(card) {
  for (const [key, el] of boardCells) {
    if (key.startsWith('card:') && boardMeta(key).wins(card)) el.classList.add('cell-hit');
    if (state.boardBets.has(key)) {
      el.classList.add(boardMeta(key).wins(card) ? 'cell-win' : 'cell-lose');
    }
  }
}

/* does any active bet cover this card? */
function cardHasBet(card) {
  for (const key of state.boardBets.keys()) {
    if (boardMeta(key).wins(card)) return true;
  }
  return false;
}

/* lime outline on wheel tiles the player has money on */
function renderStripHighlights() {
  document.querySelectorAll('#strip .tile').forEach(el => {
    const k = el.dataset.key;
    el.classList.toggle('mine', !!k && cardHasBet(cardFromKey(k)));
  });
}

/* ── Advanced board construction ─────────── */
function buildBoard() {
  const grid = $('boardGrid');

  const makeCell = (key, className, html, title, colStart, colSpan, rowStart, rowSpan) => {
    const el = document.createElement('button');
    el.className = 'cell ' + className;
    el.innerHTML = html;
    el.title = title;
    if (colStart) el.style.gridColumn = colStart + (colSpan > 1 ? ' / span ' + colSpan : '');
    if (rowStart) el.style.gridRow = rowStart + (rowSpan > 1 ? ' / span ' + rowSpan : '');
    el.addEventListener('click', () => placeChip(key));
    el.addEventListener('mouseenter', () => highlightCoverage(key, true));
    el.addEventListener('mouseleave', () => highlightCoverage(key, false));
    boardCells.set(key, el);
    return el;
  };
  const title = (key) => {
    const meta = boardMeta(key);
    return meta.label + ' — pays ' + multLabel(meta.mult);
  };

  grid.appendChild(makeCell('joker:both', 'cell-joker j-both', '<span class="g">♛</span><span class="y">♛</span>', title('joker:both'), 1, 1, 1, 1));
  VALUES.forEach((v, i) =>
    grid.appendChild(makeCell('value:' + v, 'cell-head', v, title('value:' + v), i + 2, 1, 1, 1)));

  grid.appendChild(makeCell('joker:gold', 'cell-joker j-gold', '♛', title('joker:gold'), 1, 1, 2, 2));
  grid.appendChild(makeCell('joker:purple', 'cell-joker j-purple', '♛', title('joker:purple'), 1, 1, 4, 2));

  SUIT_ORDER.forEach((suit, si) => {
    const red = SUITS[suit].color === 'red';
    VALUES.forEach((v, vi) => {
      const key = 'card:' + v + ':' + suit;
      grid.appendChild(makeCell(key, red ? 'cell-red' : '', '', title(key), vi + 2, 1, si + 2, 1));
    });
    grid.appendChild(makeCell('suit:' + suit, 'cell-suit' + (red ? ' s-red' : ''), SUITS[suit].symbol, title('suit:' + suit), 15, 1, si + 2, 1));
  });

  const groupRow = document.createElement('div');
  groupRow.className = 'row-span';
  groupRow.style.gridColumn = '2 / span 13';
  groupRow.style.gridRow = '6';
  for (const g of Object.keys(GROUPS)) {
    groupRow.appendChild(makeCell('group:' + g, 'cell-wide ' + (GROUPS[g].length === 5 ? 'w5' : 'w3'),
      g + '<em>' + multLabel(boardMeta('group:' + g).mult) + '</em>', title('group:' + g)));
  }
  grid.appendChild(groupRow);

  const outsideRow = document.createElement('div');
  outsideRow.className = 'row-span';
  outsideRow.style.gridColumn = '2 / span 13';
  outsideRow.style.gridRow = '7';
  const outside = [
    ['parity:even', '', 'Even'],
    ['colour:red', 'cell-colour-red', 'Green'],
    ['colour:black', 'cell-colour-black', 'White'],
    ['parity:odd', '', 'Odd'],
  ];
  for (const [key, cls, name] of outside) {
    outsideRow.appendChild(makeCell(key, 'cell-wide ' + cls,
      name + '<em>' + multLabel(boardMeta(key).mult) + '</em>', title(key)));
  }
  grid.appendChild(outsideRow);
}

/* card object for a board cell key, if the cell IS a single card */
function cellCard(k) {
  const p = k.split(':');
  if (p[0] === 'card') return { kind: 'standard', value: p[1], suit: p[2] };
  if (p[0] === 'joker' && p[1] !== 'both') return { kind: 'joker', joker: p[1] };
  return null;
}

/* hovering any bet spot lights up every card it covers */
function highlightCoverage(key, on) {
  const meta = boardMeta(key);
  for (const [k, el] of boardCells) {
    if (k === key) continue;
    const card = cellCard(k);
    if (!card) continue;
    el.classList.toggle('cover-hi', on && !!meta.wins(card));
  }
}

/* split & corner hit-zones overlaid on the card grid boundaries.
   Built lazily the first time the board is shown (it needs layout). */
let zonesBuilt = false;
function buildZones() {
  if (zonesBuilt) return;
  const probe = boardCells.get('card:A:spades');
  if (!probe || probe.offsetWidth === 0) return;   /* board not laid out yet — retried on next show */
  zonesBuilt = true;
  const grid = $('boardGrid');
  grid.style.position = 'relative';
  const S = 18;
  const mk = (key, x, y, w, h, z) => {
    const meta = boardMeta(key);
    const el = document.createElement('button');
    el.className = 'zone';
    el.title = meta.label + ' — pays ' + multLabel(meta.mult);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.zIndex = z;
    el.addEventListener('click', () => placeChip(key));
    el.addEventListener('mouseenter', () => highlightCoverage(key, true));
    el.addEventListener('mouseleave', () => highlightCoverage(key, false));
    boardCells.set(key, el);
    grid.appendChild(el);
  };
  SUIT_ORDER.forEach((suit, si) => {
    VALUES.forEach((v, vi) => {
      const cell = boardCells.get('card:' + v + ':' + suit);
      const L = cell.offsetLeft, T = cell.offsetTop, w = cell.offsetWidth, h = cell.offsetHeight;
      if (vi < 12) mk('pairh:' + v + ':' + suit, L + w + 2 - S / 2, T + 4, S, h - 8, 6);
      if (si < 3) mk('pairv:' + v + ':' + suit, L + 4, T + h + 2 - S / 2, w - 8, S, 6);
      if (vi < 12 && si < 3) mk('quad:' + v + ':' + suit, L + w - S / 2, T + h - S / 2, S + 4, S + 4, 7);
    });
  });
}

/* the joker celebration plays on a CLONE in an overlay above the wheel,
   outside the strip's overflow clipping, so the enlarged flips never cut off */
function jokerPopOut(tileEl) {
  const area = document.querySelector('.spin-area');
  const mm = /scale\(([-0-9.]+)\)/.exec(document.querySelector('.app').style.transform);
  const scale = mm ? parseFloat(mm[1]) : 1;
  const tr = tileEl.getBoundingClientRect();
  const ar = area.getBoundingClientRect();
  const clone = tileEl.cloneNode(true);
  clone.classList.remove('land');
  clone.classList.add('jpop');
  clone.style.position = 'absolute';
  clone.style.left = ((tr.left - ar.left) / scale) + 'px';
  clone.style.top = ((tr.top - ar.top) / scale) + 'px';
  clone.style.width = (tr.width / scale) + 'px';
  clone.style.height = (tr.height / scale) + 'px';
  clone.style.zIndex = 50;
  area.appendChild(clone);
  tileEl.style.visibility = 'hidden';
  setTimeout(() => {
    clone.remove();
    if (tileEl.isConnected) tileEl.style.visibility = '';
  }, 3150);
}

/* ── Strip rendering ─────────────────────── */
function tileHTML(card) {
  if (!card) return '<div class="tile back"><img class="bk-logo" src="assets/gamdom-logo.png" alt=""></div>';
  if (card.kind === 'joker') {
    return '<div class="tile joker-tile ' + card.joker + '" data-key="' + cardKey(card) + '">'
      + '<span class="hexb"><span class="hex"><img src="assets/joker-' + card.joker + '.png" alt=""></span></span>'
      + '<span class="jname">JOKER</span>'
      + '</div>';
  }
  const suit = SUITS[card.suit];
  return '<div class="tile face ' + suit.color + '" data-key="' + cardKey(card) + '">'
    + '<span class="ix"><b>' + card.value + '</b><i>' + suit.symbol + '</i></span>'
    + '<span class="pip">' + suit.symbol + '</span>'
    + '</div>';
}

function stripPitch(strip) {
  return strip.children.length > 1
    ? strip.children[1].offsetLeft - strip.children[0].offsetLeft
    : 60;
}

function centerOffset(strip, index) {
  const winW = $('stripWindow').clientWidth;
  /* offsetWidth, NOT getBoundingClientRect(): the frame is CSS-scaled to fit
     the window, so the rect is in scaled px while clientWidth/offsetLeft are
     layout px. Mixing them lands the card off-centre by tileW*(1-scale)/2. */
  const tileW = strip.children[0].offsetWidth;
  return index * stripPitch(strip) + tileW / 2 - winW / 2;
}

function renderIdleStrip() {
  const strip = $('strip');
  const mid = 15;
  const tiles = Array.from({ length: 31 }, (_, i) =>
    i === mid && state.lastCard ? state.lastCard : null);
  strip.innerHTML = tiles.map(tileHTML).join('');
  strip.style.transition = 'none';
  strip.style.transform = 'translateX(' + (-centerOffset(strip, mid)) + 'px)';
  if (state.lastCard) strip.children[mid].classList.add('land');
}

/* at T-4s every card flips face-down in a wave — betting is closing.
   True two-phase flip, in place: rotate to edge-on, swap to the back
   at 90°, rotate out — no strip rebuild, no re-centering jump. */
function flipStripToBacks() {
  SFX.flip();
  const strip = $('strip');
  const winW = $('stripWindow').clientWidth;
  const mm = /translateX\((-?[0-9.]+)px\)/.exec(strip.style.transform);
  const stripX = mm ? parseFloat(mm[1]) : 0;
  const holder = document.createElement('div');
  const toBack = (el) => {
    holder.innerHTML = tileHTML(null);
    const back = holder.firstChild;
    el.className = back.className;
    el.innerHTML = back.innerHTML;
    el.removeAttribute('data-key');
  };
  let vi = 0;
  [...strip.children].forEach((el) => {
    const x = stripX + el.offsetLeft;
    if (x <= -160 || x >= winW + 160) { toBack(el); return; }   /* offscreen: instant, no layer */
    el.style.willChange = 'transform';
    const out = el.animate(
      [{ transform: 'perspective(680px) rotateY(0deg)' },
       { transform: 'perspective(680px) rotateY(90deg)' }],
      { duration: 190, delay: vi * 26, easing: 'cubic-bezier(0.45, 0, 0.75, 0.45)', fill: 'forwards' });
    vi++;
    out.finished.then(() => {
      toBack(el);
      const inn = el.animate(
        [{ transform: 'perspective(680px) rotateY(-90deg)' },
         { transform: 'perspective(680px) rotateY(0deg)' }],
        { duration: 250, easing: 'cubic-bezier(0.2, 0.55, 0.25, 1)' });
      out.cancel();
      inn.finished.then(() => { el.style.willChange = ''; }).catch(() => {});
    }).catch(() => {});
  });
}

/* after the flip: individual pair swaps — two cards at a time slide
   horizontally past each other (one in front, one behind), staying on
   the row line the whole time */
async function shuffleStrip() {
  const strip = $('strip');
  const winW = $('stripWindow').clientWidth;
  const mm = /translateX\((-?[0-9.]+)px\)/.exec(strip.style.transform);
  const stripX = mm ? parseFloat(mm[1]) : 0;
  const tiles = [...strip.children].filter(el => {
    const x = stripX + el.offsetLeft;
    return x > -160 && x < winW + 160;
  });
  const n = tiles.length;
  if (n < 2) return;
  const pitch = stripPitch(strip);
  tiles.forEach(el => { el.style.willChange = 'transform'; });
  const pos = tiles.map((_, i) => i);   /* current visual slot of each tile */

  /* the slot sitting under the centre marker — it must keep changing hands */
  let centerSlot = 0, best = Infinity;
  tiles.forEach((el, i) => {
    const d = Math.abs(stripX + el.offsetLeft + el.offsetWidth / 2 - winW / 2);
    if (d < best) { best = d; centerSlot = i; }
  });

  for (let k = 0; k < 7; k++) {
    /* every other swap grabs the card currently in the centre slot */
    const a = k % 2 === 0 ? pos.indexOf(centerSlot) : Math.floor(Math.random() * n);
    let b = -1;
    for (let tries = 0; tries < 20 && b < 0; tries++) {
      const c = Math.floor(Math.random() * n);
      const d = Math.abs(pos[c] - pos[a]);
      if (c !== a && d >= 1 && d <= 4) b = c;
    }
    if (b < 0) continue;
    [pos[a], pos[b]] = [pos[b], pos[a]];
    tiles[a].style.zIndex = 4;
    tiles[b].style.zIndex = 2;
    [a, b].forEach(t => {
      tiles[t].style.transition = 'transform 0.3s cubic-bezier(0.45, 0, 0.3, 1)';
      tiles[t].style.transform = 'translateX(' + ((pos[t] - t) * pitch) + 'px)'
        + (t === a ? ' scale(1.04)' : ' scale(0.97)');
    });
    await sleep(310);
    [a, b].forEach(t => { tiles[t].style.transform = 'translateX(' + ((pos[t] - t) * pitch) + 'px)'; });
    SFX.swap();
  }
  await sleep(200);
  /* backs are identical — snap everything home invisibly */
  tiles.forEach(el => { el.style.transition = ''; el.style.transform = ''; el.style.zIndex = ''; el.style.willChange = ''; });
}

async function spinStrip(card) {
  const strip = $('strip');
  /* unroll one shuffled deck like a circular wheel, rotated so the winning
     card sits at the landing index. The travel is 2+ full wheels PLUS a
     random 8-45 card offset — never a multiple of 54, so the cards shown
     when the deck flips face-up can't preview the landing neighbourhood. */
  const target = 176 + Math.floor(Math.random() * 38);   /* ~3.2-3.8 full wheels of travel */
  const deck = shuffledDeck();
  const p = deck.findIndex(c => cardKey(c) === cardKey(card));
  const shift = (p - (target % 54) + 54) % 54;
  const cards = Array.from({ length: target + 16 }, (_, i) => deck[(i + shift) % 54]);
  /* lay the new deck face-down at the start position (an all-backs row,
     seamless against the shuffled backs), then wave-flip it face-up */
  strip.innerHTML = cards.map(() => tileHTML(null)).join('');
  strip.style.transition = 'none';
  const startX = -centerOffset(strip, 6);   /* deep enough in that the window is full on both sides */
  strip.style.transform = 'translateX(' + startX + 'px)';
  void strip.offsetWidth;

  const winW = $('stripWindow').clientWidth;
  const holder = document.createElement('div');
  const setFace = (el, i) => {
    holder.innerHTML = tileHTML(cards[i]);
    const face = holder.firstChild;
    el.className = face.className;
    el.innerHTML = face.innerHTML;
    if (face.dataset.key) el.dataset.key = face.dataset.key;
    else el.removeAttribute('data-key');
  };
  let vi = 0;
  [...strip.children].forEach((el, i) => {
    const x = startX + el.offsetLeft;
    if (x <= -160 || x >= winW + 160) { setFace(el, i); return; }
    el.style.willChange = 'transform';
    const out = el.animate(
      [{ transform: 'perspective(680px) rotateY(0deg)' },
       { transform: 'perspective(680px) rotateY(90deg)' }],
      { duration: 180, delay: vi * 24, easing: 'cubic-bezier(0.45, 0, 0.75, 0.45)', fill: 'forwards' });
    vi++;
    out.finished.then(() => {
      setFace(el, i);
      const inn = el.animate(
        [{ transform: 'perspective(680px) rotateY(-90deg)' },
         { transform: 'perspective(680px) rotateY(0deg)' }],
        { duration: 240, easing: 'cubic-bezier(0.2, 0.55, 0.25, 1)' });
      out.cancel();
      inn.finished.then(() => { el.style.willChange = ''; }).catch(() => {});
    }).catch(() => {});
  });
  SFX.flip();
  await sleep(950);
  renderStripHighlights();

  /* case-opening bait: one long smooth deceleration that dies with the
     marker right ON the edge between two cards — ambiguous — holds there,
     then a single half-card resolve onto the winner (back or over). */
  const pitch = stripPitch(strip);
  const finalX = -centerOffset(strip, target);
  const side = Math.random() < 0.5 ? 1 : -1;            /* 1 = die just short, -1 = just past */
  const edge = (0.44 + Math.random() * 0.1) * pitch;    /* ~half a card = boundary line */

  /* wheel ticks: one per card crossing the marker, naturally rate-limited
     to the display frame rate during the launch blur */
  let lastTickIdx = null, ticking = true;
  const tickWatch = () => {
    if (!ticking) return;
    const x = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m41;
    const idx = Math.round(-x / pitch);
    if (lastTickIdx !== null && idx !== lastTickIdx) SFX.tick();
    lastTickIdx = idx;
    requestAnimationFrame(tickWatch);
  };
  requestAnimationFrame(tickWatch);

  strip.style.transition = 'transform 6500ms cubic-bezier(0.03, 0.92, 0.04, 1)';
  strip.style.transform = 'translateX(' + (finalX + side * edge) + 'px)';
  await sleep(6560);

  await sleep(450 + Math.random() * 400);               /* the hold — pure bait */

  strip.style.transition = 'transform 360ms cubic-bezier(0.3, 1, 0.4, 1)';
  strip.style.transform = 'translateX(' + finalX + 'px)';
  await sleep(400);
  ticking = false;

  const winner = strip.children[target];
  winner.classList.add('land');
  if (card.kind === 'joker') {
    jokerPopOut(winner);
    SFX.jokerRise();                       /* RawAnimate from ceremony start */
    setTimeout(() => SFX.jokerSlam(), 1800);  /* RawLand: its 0.35s transient hits the 2.15s visual slam */
    setTimeout(() => {
      $('stripWindow').animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(5px)' },
         { transform: 'translateY(-2px)' }, { transform: 'translateY(0)' }],
        { duration: 200, easing: 'ease-out' });
    }, 2150);
    setTimeout(() => {
      $('stripWindow').animate(
        [{ transform: 'translateY(0)' }, { transform: 'translateY(2px)' }, { transform: 'translateY(0)' }],
        { duration: 140, easing: 'ease-out' });
    }, 2840);                              /* mini-bounce on RawLand's second hit */
  } else {
    winner.classList.add('pop');
    SFX.land();
  }
}

/* ── UI rendering ────────────────────────── */
function renderBalance(bump) {
  const el = $('balance');
  el.textContent = money(state.balance);
  if (bump) {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }
  $('resetBalance').hidden = state.balance >= 0.01;
}

function renderPrevCards() {
  const wrap = $('prevCards');
  wrap.innerHTML = '';
  for (const card of state.history.slice(0, 8)) {
    const el = document.createElement('div');
    if (card.kind === 'joker') {
      el.className = 'pcard joker ' + card.joker;
      el.innerHTML = '<img class="pj" src="assets/joker-' + card.joker + '.png" alt="">';
    } else {
      const suit = SUITS[card.suit];
      el.className = 'pcard ' + suit.color;
      el.innerHTML = '<span>' + card.value + '</span><span>' + suit.symbol + '</span>';
    }
    wrap.appendChild(el);
  }
}

/* ── Round loop ──────────────────────────── */
async function runRound() {
  state.round++;
  state.phase = 'betting';
  state.boardBets.clear();
  state.eos = { target: null, id: null, source: null };
  clearRoundMarks();
  setControlsDisabled(false);
  autoRepeatPlace();               /* re-place last round's bets if repeat is on */
  renderBets();
  renderFairBar();

  const prep = prepareEos();       /* commit to a future block while bets are open */

  const status = $('statusText');
  status.className = 'status-text';
  const spinAt = performance.now() + BET_MS;
  let flipped = false;
  let shuffled = false;
  await new Promise(resolve => {
    const timer = setInterval(() => {
      const left = spinAt - performance.now();
      if (left <= 0) { clearInterval(timer); resolve(); return; }
      if (!flipped && left <= 5000) { flipped = true; flipStripToBacks(); }
      if (!shuffled && left <= 3900) { shuffled = true; shuffleStrip(); }
      status.innerHTML = 'PLACE YOUR BETS <span class="tick">• ' + (left / 1000).toFixed(1) + 's</span>';
    }, 100);
  });

  state.phase = 'resolving';
  closeValueMenu();
  setControlsDisabled(true);
  status.textContent = 'WAITING ON EOS…';

  await prep;
  let card = await resolveCard();
  if (state.forceJoker) {
    /* preview toggle: override the result with a random joker */
    card = cardFromIndex(52 + Math.floor(Math.random() * 2));
  }
  renderFairBar();

  state.phase = 'spinning';
  status.textContent = 'SPINNING…';
  await spinStrip(card);

  /* settle */
  state.phase = 'result';
  let staked = 0;
  let winnings = 0;
  for (const [key, bet] of state.boardBets) {
    staked = round2(staked + bet.total);
    if (boardMeta(key).wins(card)) winnings = round2(winnings + bet.total * boardMeta(key).mult);
  }

  state.balance = round2(state.balance + winnings);
  state.lastCard = card;
  state.history.unshift(card);
  state.history = state.history.slice(0, 10);
  renderPrevCards();
  if (staked > 0) {
    lastRoundBets = { board: cloneBoard(state.boardBets), total: staked };
  }
  save();

  renderBalance(winnings > 0);
  renderBets(card);
  markBoardResults(card);

  if (staked > 0) { if (winnings > 0) SFX.win(); else SFX.lose(); }
  status.textContent = cardLabel(card) + '  —  '
    + (staked === 0 ? 'NO BET' : winnings > 0 ? 'WON ' + money(winnings) : 'NO WIN');
  status.className = 'status-text ' + (staked > 0 && winnings > 0 ? 'win' : staked > 0 ? 'lose' : '');

  await sleep(RESULT_MS);
}

async function roundLoop() {
  while (true) await runRound();
}

function setControlsDisabled(disabled) {
  document.querySelectorAll('.opt, .x2-btn, .value-btn, .value-item, #betAmount, #customChip')
    .forEach(el => { el.disabled = disabled; });
  $('board').classList.toggle('locked', disabled);
}

/* ── Repeat bet ──────────────────────────── */
function renderRepeat() {
  const check = $('repeatCheck');
  check.classList.toggle('checked', state.repeat.on);
  check.setAttribute('aria-checked', String(state.repeat.on));
  $('repeatCount').textContent = '×' + (state.repeat.on ? state.repeat.left : state.repeat.rounds);
}

function autoRepeatPlace() {
  if (!state.repeat.on || state.repeat.left <= 0 || !lastRoundBets || lastRoundBets.total <= 0) return;
  if (lastRoundBets.total > state.balance) {
    state.repeat.on = false;
    renderRepeat();
    denyBalance();
    return;
  }
  state.balance = round2(state.balance - lastRoundBets.total);
  state.boardBets = cloneBoard(lastRoundBets.board);
  state.repeat.left--;
  if (state.repeat.left <= 0) state.repeat.on = false;
  save();
  renderBalance(false);
  renderRepeat();
}

function closeValueMenu() {
  $('valueMenu').hidden = true;
}

/* ── Init ────────────────────────────────── */
function init() {
  load();
  buildBoard();

  // simple panel option buttons place the typed amount on their spot
  document.querySelectorAll('#simplePanel .opt').forEach(btn => {
    const key = btn.dataset.key;
    simpleOpts.set(key, btn);
    btn.addEventListener('click', () => placeSimple(key));
  });

  // value grid: each tile is a 13× bet on that value
  const menu = $('valueMenu');
  for (const v of VALUES) {
    const item = document.createElement('button');
    item.className = 'value-item';
    item.dataset.value = v;
    item.textContent = v;
    simpleOpts.set('value:' + v, item);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      placeSimple('value:' + v);   /* menu stays open for more bets */
    });
    menu.appendChild(item);
  }

  $('valueBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.phase !== 'betting') return;
    menu.hidden = !menu.hidden;
    SFX.click();
  });
  document.addEventListener('click', closeValueMenu);
  menu.addEventListener('click', (e) => e.stopPropagation());

  // advanced chip tray
  document.querySelectorAll('.bchip[data-chip]').forEach(chip =>
    chip.addEventListener('click', () => {
      document.querySelectorAll('.bchip[data-chip]').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      SFX.click();
      if (chip.dataset.chip === 'custom') $('customChip').focus();
    }));
  $('customChip').addEventListener('click', (e) => e.stopPropagation());
  $('clearBoard').addEventListener('click', clearBets);
  $('clearSimple').addEventListener('click', clearBets);

  // mode toggle — off (left) = simple betting (default), on = advanced board
  $('modeToggle').addEventListener('click', () => {
    const advanced = state.mode !== 'advanced';
    state.mode = advanced ? 'advanced' : 'simple';
    const toggle = $('modeToggle');
    toggle.classList.toggle('on', advanced);
    toggle.setAttribute('aria-checked', String(advanced));
    $('board').hidden = !advanced;
    $('simplePanel').hidden = advanced;
    if (advanced) setTimeout(buildZones, 60);
    SFX.click();
  });

  document.querySelectorAll('.x2-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.target);
      const v = parseFloat(input.value);
      input.value = (isNaN(v) || v <= 0 ? 0.01 : round2(v * 2)).toFixed(2);
      SFX.click();
    }));

  // repeat-bet control
  $('repeatCheck').addEventListener('click', () => {
    SFX.click();
    state.repeat.on = !state.repeat.on;
    if (state.repeat.on) state.repeat.left = state.repeat.rounds;
    renderRepeat();
  });
  const repeatInput = $('repeatInput');
  $('repeatEdit').addEventListener('click', () => {
    repeatInput.hidden = false;
    repeatInput.value = state.repeat.rounds;
    $('repeatCount').hidden = true;
    repeatInput.focus();
    repeatInput.select();
  });
  const commitRepeat = () => {
    if (repeatInput.hidden) return;
    const n = Math.max(1, Math.min(999, Math.round(parseFloat(repeatInput.value) || state.repeat.rounds)));
    state.repeat.rounds = n;
    if (state.repeat.on) state.repeat.left = n;
    repeatInput.hidden = true;
    $('repeatCount').hidden = false;
    renderRepeat();
  };
  repeatInput.addEventListener('blur', commitRepeat);
  repeatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitRepeat(); });
  renderRepeat();

  const soundBtn = $('soundToggle');
  const soundIcon = () => { soundBtn.textContent = SFX.on ? '\u{1F50A}' : '\u{1F507}'; soundBtn.classList.toggle('muted', !SFX.on); };
  soundBtn.addEventListener('click', () => { SFX.toggle(); soundIcon(); });
  soundIcon();

  $('forceJoker').addEventListener('click', () => {
    state.forceJoker = !state.forceJoker;
    $('forceJoker').classList.toggle('on', state.forceJoker);
  });

  $('resetBalance').addEventListener('click', () => {
    state.balance = START_BALANCE;
    save();
    renderBalance(true);
  });

  renderBalance(false);
  renderIdleStrip();
  renderPrevCards();
  renderBets();

  /* scale the fixed 1080x700 frame to fit the window — no internal scrolling */
  const fitFrame = () => {
    const pad = 28;
    const scale = Math.min(
      1.35,
      (window.innerWidth - pad * 2) / 1080,
      (window.innerHeight - pad * 2) / 700
    );
    document.querySelector('.app').style.transform = 'scale(' + scale + ')';
  };
  fitFrame();
  window.addEventListener('resize', () => {
    fitFrame();
    if (state.phase === 'betting') renderIdleStrip();
  });

  roundLoop();
}

init();
