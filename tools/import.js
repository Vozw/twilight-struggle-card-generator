#!/usr/bin/env node
/*
 * Bulk-import cards into the library.
 *
 *   node tools/import.js --lua <twilight_cards.lua> [--out vanilla]
 *   node tools/import.js --lua <...> --xlsm <my_reskin.xlsx> \
 *                        --sheet "My Reskin" --out my-reskin
 *
 * The lua file is the Steam client's own card table, which makes it a complete
 * and authoritative 114-card manifest. Only the fields this generator needs to
 * *draw* a card are read; the effect opcodes are deliberately left alone. They
 * belong to a rules engine, and copying them in here would couple two things
 * that are better off sharing data than code.
 *
 * Flags:
 *   --lua <path>       card manifest to read (required)
 *   --out <folder>     destination inside library/ (default: "vanilla")
 *   --xlsm <path>      workbook holding a reskin overlay
 *   --sheet <name>     sheet within that workbook
 *   --images <dir>     folder to copy overlay artwork from
 *   --dry-run          report what would be written, write nothing
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const { readWorkbook } = require('./xlsx.js');

const ROOT = path.resolve(__dirname, '..');
const LIBRARY = path.join(ROOT, 'library');
const IMAGES = path.join(LIBRARY, '_images');

// ------------------------------------------------------------------- args

function parseArgs(argv) {
  const args = { out: 'vanilla' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    if (key === 'dry-run') args.dryRun = true;
    else args[key] = argv[++i];
  }
  return args;
}

// -------------------------------------------------------------- lua parsing

/**
 * Pull the concatenated Lua string literals out of `key = "a" .. "b";`
 * and return the joined, unescaped result.
 */
function luaString(body, key) {
  const match = new RegExp(
    `${key}\\s*=\\s*((?:"(?:[^"\\\\]|\\\\.)*"\\s*(?:\\.\\.)?\\s*)+)`,
    'm'
  ).exec(body);
  if (!match) return '';
  const pieces = [...match[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1]
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
  );
  return pieces.join('');
}

function luaNumber(body, key) {
  const m = new RegExp(`${key}\\s*=\\s*(-?\\d+)`, 'm').exec(body);
  return m ? Number(m[1]) : null;
}

function luaFlag(body, key) {
  return new RegExp(`^\\s*${key}\\s*=\\s*true`, 'm').test(body);
}

const ERA_BY_STAGE = { 'Early War': 'early', 'Mid War': 'mid', 'Late War': 'late' };
const ASSOCIATION_BY_OWNER = { USA: 'usa', USSR: 'ussr', Neutral: 'neutral' };

/**
 * The red underline, per the rulebook.
 *
 *   7.3  "Some Event cards have an underlined title, e.g. Flower Power. This
 *         indicates that the effects of these Events last for the duration of
 *         the game."
 *   2.2.5 "Cards that have their Event title underlined are displayed face-up
 *         on the side of the game board until they are cancelled (or the game
 *         ends)."
 *
 * So the test is *permanence*, not merely "has a lasting effect" -- an event
 * that expires at end of turn does not qualify, however much bookkeeping it
 * needs. The manifest encodes exactly this in the argument to
 * `PutThisCardInPlay`: 0 puts the card in play indefinitely, 1 puts it in play
 * for the turn.
 *
 * The pattern tolerates a trailing `condition={...}` inside the braces, which
 * The Reformer uses -- missing it is what previously left that card out.
 */
const PUT_IN_PLAY = /\{\s*"PutThisCardInPlay"\s*,\s*(\d+)\s*[,}]/;

/**
 * Shuttle Diplomacy sits in play until the next Asia/Middle East scoring
 * cancels it, which 2.2.5 covers ("until they are cancelled"). Chernobyl's
 * variant, `PutThisCardInPlayWithRegionChoice`, clears at end of turn and so
 * does not qualify -- hence matching the exact opcode rather than a prefix.
 */
const PUT_IN_PLAY_SPECIAL = /"PutThisCardInPlaySpecial"/;

/**
 * Quagmire and Bear Trap stay in effect until the trapped player rolls out of
 * them, which can span turns -- "until they are cancelled" under 2.2.5. They
 * use bespoke opcodes rather than the generic in-play machinery, so nothing
 * structural catches them. Both are underlined on the printed cards.
 */
const LASTING_EXTRAS = new Set(['Quagmire', 'Bear Trap']);

/** Does this card's Event last for the duration of the game? */
function isPermanentEvent(name, body) {
  if (LASTING_EXTRAS.has(name)) return true;
  if (PUT_IN_PLAY_SPECIAL.test(body)) return true;
  const m = PUT_IN_PLAY.exec(body);
  return Boolean(m) && m[1] === '0';
}

/**
 * Manual corrections, applied last. Lives in a JSON file rather than in code so
 * the list can be tuned by eye against the rendered cards.
 */
function loadOverrides(file) {
  if (!file || !fs.existsSync(file)) return { underline: new Set(), noUnderline: new Set() };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const norm = (list) => new Set((list || []).map((v) => String(v).trim().toLowerCase()));
  return { underline: norm(raw.underline), noUnderline: norm(raw.noUnderline) };
}

/**
 * Clauses the printed cards set in italics on their own line, ahead of the
 * effect proper. Matching only these specific openers keeps the rewrite
 * predictable; anything else is left exactly as written.
 */
const PREAMBLE = /^((?:Play(?:able)? (?:after|only|in)|Unplayable|Prerequisite|May only be played|This card may|Playable as an event only)\b[^.]*\.)\s*/i;

function formatEventText(raw) {
  let text = raw.trim().replace(/\s+\n/g, '\n');
  const match = PREAMBLE.exec(text);
  if (match) {
    const rest = text.slice(match[0].length).trim();
    text = `*${match[1].trim()}*` + (rest ? `\n\n${rest}` : '');
  }
  return text;
}

function parseLua(source, overrides = { underline: new Set(), noUnderline: new Set() }) {
  const cards = [];
  for (const [, name, body] of source.matchAll(
    /g_twilight_cards\["([^"]+)"\]\s*=\s*\{([\s\S]*?)\n\}/g
  )) {
    const isScoring = /card_type\s*=\s*"Scoring"/.test(body);
    const owner = /event_owner\s*=\s*"([^"]+)"/.exec(body)?.[1];
    const number = luaNumber(body, 'card_number');

    let lasting = isPermanentEvent(name, body);

    const key = name.toLowerCase();
    if (overrides.underline.has(key) || overrides.underline.has(String(number))) lasting = true;
    if (overrides.noUnderline.has(key) || overrides.noUnderline.has(String(number))) lasting = false;

    cards.push({
      luaName: name,
      number,
      ops: isScoring ? 0 : luaNumber(body, 'operations_points') ?? 0,
      era: ERA_BY_STAGE[/stage\s*=\s*"([^"]+)"/.exec(body)?.[1]] || 'early',
      association: ASSOCIATION_BY_OWNER[owner] || 'neutral',
      title: luaString(body, 'card_name') || name,
      text: formatEventText(luaString(body, 'event_text')),
      removedOnEvent: luaFlag(body, 'remove_if_used_as_event'),
      optional: luaFlag(body, 'optional_card'),
      permanent: lasting,
      scoring: isScoring,
      // Each scoring card is tinted to match its region on the map.
      scoringRegion: /scoring_region\s*=\s*"([^"]+)"/.exec(body)?.[1] || '',
      mayNotBeHeld: isScoring && /may_be_held\s*=\s*false/.test(body),
    });
  }
  cards.sort((a, b) => a.number - b.number);
  return cards;
}

// ------------------------------------------------------------ xlsm overlay

/**
 * Read a reskin overlay keyed by vanilla card number. Columns are located by
 * header name so the sheet can gain or lose columns without breaking this.
 */
function parseOverlay(rows) {
  const headers = (rows[0] || []).map((h) => String(h).trim().toLowerCase());
  const find = (...names) => {
    for (const name of names) {
      const i = headers.indexOf(name);
      if (i !== -1) return i;
    }
    return -1;
  };

  // The number and the reskin fields; the reskin title/text sit in the second
  // half of the sheet, after the vanilla reference columns.
  const colNumber = find('#', 'number', 'no');
  const colName = headers.lastIndexOf('name');
  const colText = headers.lastIndexOf('text');
  const colImage = find('image', 'art');

  const overlay = new Map();
  for (const row of rows.slice(1)) {
    const number = Number(row[colNumber]);
    if (!Number.isFinite(number)) continue;
    const entry = {
      title: colName !== -1 ? String(row[colName] || '').trim() : '',
      text: colText !== -1 ? String(row[colText] || '').trim() : '',
      image: colImage !== -1 ? String(row[colImage] || '').trim() : '',
    };
    // Only rows that actually carry a reskin are interesting.
    if (entry.title || entry.text || entry.image) overlay.set(number, entry);
  }
  return overlay;
}

/** Copy overlay artwork into library/_images with a content-addressed name. */
async function adoptImage(sourceDir, filename) {
  const source = path.join(sourceDir, filename);
  if (!fs.existsSync(source)) return null;
  const bytes = await fsp.readFile(source);
  const digest = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  const ext = path.extname(filename) || '.png';
  const base = path.basename(filename, ext).replace(/[^A-Za-z0-9._-]/g, '-');
  const stored = `${base}-${digest}${ext}`;
  await fsp.mkdir(IMAGES, { recursive: true });
  const target = path.join(IMAGES, stored);
  if (!fs.existsSync(target)) await fsp.writeFile(target, bytes);
  return `_images/${stored}`;
}

// -------------------------------------------------------------------- main

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Matches the sanitiser in cardmodel.js so library and output names agree. */
function safeName(s) {
  return String(s)
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Longest overlay name still treated as a card title. */
const MAX_TITLE_LENGTH = 48;

/**
 * Reject overlay "names" that are really planning notes.
 *
 * A workspace sheet tends to double as a scratchpad, so unfinished rows can
 * carry a paragraph of ideas in the Name column. Used as a card title that
 * produces an absurd filename, so such rows are skipped and reported. Length is
 * the only test: anything cleverer (a trailing "?", words like "maybe") would
 * reject perfectly good titles.
 */
function looksLikeNote(value) {
  return String(value || '').trim().length > MAX_TITLE_LENGTH;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.lua) {
    console.error('Usage: node tools/import.js --lua <twilight_cards.lua> [--out vanilla]');
    console.error('       [--xlsm <book.xlsm> --sheet "<sheet name>"] [--images <dir>] [--dry-run]');
    process.exit(1);
  }

  const overrideFile = args.overrides || path.join(__dirname, 'underline-overrides.json');
  const overrides = loadOverrides(overrideFile);
  if (overrides.underline.size || overrides.noUnderline.size) {
    console.log(
      `Underline overrides from ${path.basename(overrideFile)}: ` +
        `+${overrides.underline.size} / -${overrides.noUnderline.size}`
    );
  }

  const cards = parseLua(fs.readFileSync(args.lua, 'utf8'), overrides);
  console.log(`Parsed ${cards.length} cards from ${path.basename(args.lua)}`);
  console.log(`  ${cards.filter((c) => c.removedOnEvent).length} removed on event`);
  console.log(`  ${cards.filter((c) => c.permanent).length} with lasting effects (red underline)`);
  console.log(`  ${cards.filter((c) => c.scoring).length} scoring, ${cards.filter((c) => c.optional).length} optional`);

  let overlay = new Map();
  if (args.xlsm) {
    const book = readWorkbook(args.xlsm);
    const sheetName = args.sheet || Object.keys(book)[0];
    if (!book[sheetName]) {
      console.error(`No sheet named "${sheetName}". Available: ${Object.keys(book).join(', ')}`);
      process.exit(1);
    }
    overlay = parseOverlay(book[sheetName]);
    console.log(`Overlay "${sheetName}": ${overlay.size} reskinned card(s)`);
  }

  const outDir = path.join(LIBRARY, args.out);
  if (!args.dryRun) await fsp.mkdir(outDir, { recursive: true });

  let written = 0;
  let withArt = 0;
  const notes = [];

  for (const card of cards) {
    const skin = overlay.get(card.number);

    // A reskin overrides title, text and artwork; everything mechanical --
    // ops, era, association, the removal and underline flags -- carries over.
    let title = card.title;
    if (skin?.title) {
      if (looksLikeNote(skin.title)) {
        notes.push(`#${card.number} (${card.title}): "${skin.title.slice(0, 60)}…"`);
      } else {
        title = skin.title;
      }
    }
    const text = skin?.text ? formatEventText(skin.text) : card.text;

    let art = null;
    if (skin?.image && args.images) {
      const stored = await adoptImage(args.images, skin.image);
      if (stored) {
        art = { src: stored, mode: 'photo' };
        withArt++;
      } else {
        console.warn(`  ! missing image for #${card.number}: ${skin.image}`);
      }
    }

    const record = {
      schema: 1,
      id: slugify(title),
      number: card.number,
      ops: card.ops,
      era: card.era,
      association: card.association,
      title,
      text,
      removedOnEvent: card.removedOnEvent,
      optional: card.optional,
      permanent: card.permanent,
      scoring: card.scoring,
      scoringRegion: card.scoringRegion,
      mayNotBeHeld: card.mayNotBeHeld,
      art,
      presentation: {},
    };
    // Keep the link back to the vanilla card a reskin is standing in for.
    if (skin && card.title !== title) record.vanillaTitle = card.title;

    const filename = `${String(card.number).padStart(3, '0')} - ${safeName(title)}.json`;
    if (!args.dryRun) {
      await fsp.writeFile(path.join(outDir, filename), JSON.stringify(record, null, 2) + '\n', 'utf8');
    }
    written++;
  }

  if (notes.length) {
    console.log(`\n${notes.length} overlay row(s) look like planning notes, not titles -- kept the vanilla name:`);
    for (const note of notes) console.log(`  ${note}`);
  }

  console.log(
    args.dryRun
      ? `\nDry run: would write ${written} cards to library/${args.out}/`
      : `\nWrote ${written} cards to library/${args.out}/${withArt ? ` (${withArt} with artwork)` : ''}`
  );
}

// Only run as a CLI when invoked directly, so tests can require() this file.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  parseLua,
  parseOverlay,
  isPermanentEvent,
  formatEventText,
  looksLikeNote,
  luaString,
  safeName,
  MAX_TITLE_LENGTH,
};
