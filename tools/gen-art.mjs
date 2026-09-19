#!/usr/bin/env node
/* JOKER ROULETTE art — the same codex → image → sharp pipeline as the other
 * games. One item so far: the castle behind the wheel (user 2026-09-20:
 * "make it a very very subtle medieval castle looking background").
 *   node tools/gen-art.mjs castle_bg
 */
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const sharp = require('C:/Users/Admin/Desktop/Projects/kahuna/node_modules/sharp');
const ART = path.resolve('art'); fs.mkdirSync(ART, { recursive: true });
const SCHEMA_PATH = 'C:/Users/Admin/AppData/Local/Temp/claude/C--Users-Admin/cac0bf38-ae84-4e80-8561-c16874ee3de0/scratchpad/_joker_schema.json';   /* no spaces: the repo path has one and codex is spawned through the shell */
fs.writeFileSync(SCHEMA_PATH, JSON.stringify({ type: 'object', properties: { imagePath: { type: 'string' } }, required: ['imagePath'], additionalProperties: false }));
const OUT = path.resolve('public/joker/assets');
const MINES_REF = 'C:/Users/Admin/Desktop/Projects/References/Mines.PNG';
const ITEMS = {
  castle_bg: {
    ref: [MINES_REF], w: 2000,
    refNote: 'the reference shows the studio\'s look for a game backdrop (the castle dungeon behind the Mines grid: painted, flat, dim) — match that finish and palette, much darker and quieter',
    prompt: `A very wide painted backdrop, landscape about 3:1, of the inside of a MEDIEVAL CASTLE GREAT HALL seen straight on: grey stone block walls, tall arched windows, a row of stone columns, hanging banners, a few wall torches — all EXTREMELY DIM AND LOW CONTRAST, as if lit by moonlight, in desaturated charcoal and deep navy-grey (#0e1420 to #1a2230) with only the faintest warm glow from the torches. Flat painted cel style with soft shapes, no fine detail, no people, no text, nothing bright; the whole image must read as an almost-black texture that will sit behind a row of playing cards without competing with them.`,
  },
};
function codexImage(prompt, ref, refNote) {
  const full = `Generate ONE image. Use your image generation tool with referenced_image_paths set to ${JSON.stringify(ref)} ${refNote}. Image prompt: "${prompt}" After generating, respond with the absolute path of the generated PNG file.`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const out = execFileSync('codex', ['exec', '--skip-git-repo-check', '--output-schema', SCHEMA_PATH, '-'], { input: full, encoding: 'utf8', timeout: 420000, windowsHide: true, shell: true });
      const m = out.match(/\{"imagePath":\s*"[^"]+"\}/g);
      if (m) { const p = JSON.parse(m[m.length - 1]).imagePath; if (fs.existsSync(p)) return p; }
    } catch (err) { console.error(`  attempt ${attempt}: ${String(err.message).slice(0, 120)}`); }
  }
  throw new Error('generation failed');
}
const key = process.argv[2];
if (!ITEMS[key]) { console.error('keys: ' + Object.keys(ITEMS).join(', ')); process.exit(1); }
const cfg = ITEMS[key];
console.log(key + '...');
const raw = codexImage(cfg.prompt, cfg.ref, cfg.refNote);
fs.copyFileSync(raw, path.join(ART, key + '_raw.png'));
await sharp(raw).resize({ width: cfg.w, withoutEnlargement: true }).webp({ quality: 82 }).toFile(path.join(OUT, key + '.webp'));
console.log(key + ' ok');
