/*
 * Twilight Struggle Card Generator - local server
 *
 * Zero dependencies. Node 18+ (uses built-in fetch). Binds to 127.0.0.1 only.
 *
 * Exists to give the browser three things it cannot do on its own:
 *   1. write files to a folder you choose (a plain <a download> can only hit Downloads)
 *   2. fetch remote images without tainting the canvas (server-side fetch dodges CORS)
 *   3. keep a human-editable card library as real files in a real directory tree
 *
 * Rendering deliberately stays in the browser canvas so there is exactly one
 * rendering path -- the TTS atlas is pixel-identical to the live preview.
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const LIBRARY = path.join(ROOT, 'library');
const IMAGES = path.join(LIBRARY, '_images');
const OUTPUT_DEFAULT = path.join(ROOT, 'output');
const CONFIG_PATH = path.join(ROOT, 'config.json');

const PORT = Number(process.env.TSCG_PORT) || 8731;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const IMAGE_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
};

// ---------------------------------------------------------------- utilities

/**
 * Resolve `rel` inside `base`, refusing anything that escapes it.
 * Every filesystem path that originates from the browser goes through here.
 */
function safeJoin(base, rel) {
  const target = path.resolve(base, rel || '');
  const normalisedBase = path.resolve(base);
  if (target !== normalisedBase && !target.startsWith(normalisedBase + path.sep)) {
    throw Object.assign(new Error('Path escapes its root'), { statusCode: 400 });
  }
  return target;
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  res.writeHead(status, {
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj, null, 2), { 'Content-Type': MIME['.json'] });
}

// Generous, because a TTS atlas sheet arrives as one base64 payload.
function readBody(req, limitBytes = 512 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 });
  }
}

/** Split a `data:` URL into its mime type and decoded bytes. */
function decodeDataUrl(dataUrl) {
  const match = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!match) throw Object.assign(new Error('Not a data: URL'), { statusCode: 400 });
  const [, mime, isBase64, payload] = match;
  const bytes = isBase64
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf8');
  return { mime, bytes };
}

/**
 * Strip characters that are illegal or hostile in a filename.
 *
 * Slashes become dashes rather than vanishing, so "US/Japan Mutual Defense
 * Pact" stays readable instead of collapsing to "USJapan".
 */
function sanitiseName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * Sanitise a filename while keeping its extension intact.
 *
 * Truncating the whole string would eat the extension on very long titles --
 * which silently produced one extensionless file in a 114-card batch.
 */
function sanitiseFilename(filename, fallback = 'card', defaultExt = '.png') {
  const raw = String(filename || '');
  const ext = path.extname(raw).toLowerCase() || defaultExt;
  const stem = ext && raw.toLowerCase().endsWith(ext) ? raw.slice(0, -ext.length) : raw;
  return sanitiseName(stem, fallback) + ext;
}

async function fileExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------- config

const DEFAULT_CONFIG = {
  outputDir: OUTPUT_DEFAULT,
  ttsDir: '',
};

async function loadConfig() {
  try {
    const raw = await fsp.readFile(CONFIG_PATH, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(patch) {
  const next = { ...(await loadConfig()), ...patch };
  await fsp.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Where exported PNGs go. Falls back to ./output if the configured dir is unusable. */
async function resolveOutputDir(override) {
  const config = await loadConfig();
  const dir = override || config.outputDir || OUTPUT_DEFAULT;
  const expanded = dir.replace(/^~(?=$|[/\\])/, os.homedir());
  await ensureDir(expanded);
  return expanded;
}

// ------------------------------------------------------------------ library

/**
 * Walk the library directory into a nested tree the sidebar can render.
 * `_images` is skipped -- it is storage, not part of the card hierarchy.
 */
async function readTree(dir, relative = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const folders = [];
  const cards = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '_images') continue;
    const childRel = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      folders.push({
        type: 'folder',
        name: entry.name,
        path: childRel,
        ...(await readTree(path.join(dir, entry.name), childRel)),
      });
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      let card = {};
      try {
        card = JSON.parse(await fsp.readFile(path.join(dir, entry.name), 'utf8'));
      } catch {
        card = { title: `${entry.name} (unreadable)`, _broken: true };
      }
      cards.push({
        type: 'card',
        name: entry.name.replace(/\.json$/, ''),
        path: childRel,
        title: card.title || '',
        number: card.number ?? null,
        ops: card.ops ?? null,
        era: card.era || '',
        association: card.association || '',
        broken: Boolean(card._broken),
      });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  folders.sort(byName);
  cards.sort((a, b) => {
    if (a.number != null && b.number != null && a.number !== b.number) return a.number - b.number;
    return byName(a, b);
  });
  return { folders, cards };
}

// -------------------------------------------------------------- CSV parsing

/**
 * Parse delimited text into rows, honouring RFC-4180 quoting so that card
 * effect text containing commas and newlines survives a round trip.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const source = text.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function detectDelimiter(text) {
  const firstLine = text.split('\n')[0] || '';
  const tabs = (firstLine.match(/\t/g) || []).length;
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

// ------------------------------------------------------------------- routes

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

// --- config -----------------------------------------------------------------

route('GET', '/api/config', async (req, res) => {
  const config = await loadConfig();
  sendJson(res, 200, { ...config, defaultOutputDir: OUTPUT_DEFAULT, root: ROOT });
});

route('PUT', '/api/config', async (req, res) => {
  const patch = await readJsonBody(req);
  const allowed = {};
  if (typeof patch.outputDir === 'string') allowed.outputDir = patch.outputDir.trim();
  if (typeof patch.ttsDir === 'string') allowed.ttsDir = patch.ttsDir.trim();
  sendJson(res, 200, await saveConfig(allowed));
});

// --- library tree -----------------------------------------------------------

route('GET', '/api/library', async (req, res) => {
  await ensureDir(LIBRARY);
  sendJson(res, 200, await readTree(LIBRARY));
});

route('GET', '/api/card', async (req, res, url) => {
  const file = safeJoin(LIBRARY, url.searchParams.get('path') || '');
  try {
    const raw = await fsp.readFile(file, 'utf8');
    sendJson(res, 200, JSON.parse(raw));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'Card not found' });
    throw err;
  }
});

route('PUT', '/api/card', async (req, res, url) => {
  const relative = url.searchParams.get('path') || '';
  if (!relative.endsWith('.json')) {
    return sendJson(res, 400, { error: 'Card path must end in .json' });
  }
  const file = safeJoin(LIBRARY, relative);
  const card = await readJsonBody(req);
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(card, null, 2) + '\n', 'utf8');
  sendJson(res, 200, { ok: true, path: relative });
});

route('DELETE', '/api/card', async (req, res, url) => {
  const file = safeJoin(LIBRARY, url.searchParams.get('path') || '');
  await fsp.rm(file, { recursive: true, force: true });
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/folder', async (req, res) => {
  const { path: relative } = await readJsonBody(req);
  await ensureDir(safeJoin(LIBRARY, relative));
  sendJson(res, 200, { ok: true });
});

/** Move or rename a card or a whole folder. Used by drag-and-drop in the sidebar. */
route('POST', '/api/move', async (req, res) => {
  const { from, to } = await readJsonBody(req);
  const source = safeJoin(LIBRARY, from);
  const destination = safeJoin(LIBRARY, to);
  if (await fileExists(destination)) {
    return sendJson(res, 409, { error: 'Something already exists at that path' });
  }
  await ensureDir(path.dirname(destination));
  await fsp.rename(source, destination);
  sendJson(res, 200, { ok: true, path: to });
});

// --- images -----------------------------------------------------------------

/**
 * Fetch a remote image server-side and store it locally. Doing this here rather
 * than in the browser is what makes web URLs usable at all: a cross-origin
 * image drawn into a canvas taints it and blocks toDataURL().
 */
route('POST', '/api/image/url', async (req, res) => {
  const { url: remote, name } = await readJsonBody(req);
  let parsed;
  try {
    parsed = new URL(remote);
  } catch {
    return sendJson(res, 400, { error: 'Not a valid URL' });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return sendJson(res, 400, { error: 'Only http and https URLs are supported' });
  }

  const response = await fetch(parsed, {
    headers: { 'User-Agent': 'TSCardGenerator/1.0', Accept: 'image/*,*/*' },
    redirect: 'follow',
  });
  if (!response.ok) {
    return sendJson(res, 502, { error: `Remote server returned ${response.status}` });
  }
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) {
    return sendJson(res, 415, { error: `That URL returned ${mime || 'unknown content'}, not an image` });
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const stored = await storeImage(bytes, mime, name || path.basename(parsed.pathname));
  sendJson(res, 200, stored);
});

/** Store raw image bytes (from a paste, a drop, or a file picker). */
route('POST', '/api/image/blob', async (req, res, url) => {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim();
  if (!mime.startsWith('image/')) {
    return sendJson(res, 415, { error: 'Body must be an image' });
  }
  const bytes = await readBody(req);
  sendJson(res, 200, await storeImage(bytes, mime, url.searchParams.get('name')));
});

async function storeImage(bytes, mime, suggestedName) {
  await ensureDir(IMAGES);
  const ext = IMAGE_EXT[mime] || path.extname(suggestedName || '') || '.png';
  const base = sanitiseName(path.basename(suggestedName || 'image', path.extname(suggestedName || '')), 'image');

  // Content-addressed suffix so re-pasting the same picture reuses one file
  // while genuinely different images never collide.
  const { createHash } = require('node:crypto');
  const digest = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  const filename = `${base}-${digest}${ext}`;

  const target = path.join(IMAGES, filename);
  if (!(await fileExists(target))) await fsp.writeFile(target, bytes);
  return { path: `_images/${filename}`, url: `/library/_images/${filename}`, bytes: bytes.length };
}

// --- export -----------------------------------------------------------------

/** Write one rendered card PNG into the configured output folder. */
route('POST', '/api/export', async (req, res) => {
  const { filename, dataUrl, subfolder, outputDir } = await readJsonBody(req);
  const { bytes } = decodeDataUrl(dataUrl);
  const baseDir = await resolveOutputDir(outputDir);
  const dir = subfolder ? safeJoin(baseDir, subfolder) : baseDir;
  await ensureDir(dir);
  const target = path.join(dir, sanitiseFilename(filename));
  await fsp.writeFile(target, bytes);
  sendJson(res, 200, { ok: true, path: target });
});

/**
 * Batch export -- used by "Render selected" over a folder of cards.
 *
 * `files` may name a `subdir` per entry so mini-cards land beside, not among,
 * the full-size faces.
 */
route('POST', '/api/export/batch', async (req, res) => {
  const { files, subfolder, outputDir } = await readJsonBody(req);
  const baseDir = await resolveOutputDir(outputDir);
  const dir = subfolder ? safeJoin(baseDir, subfolder) : baseDir;
  await ensureDir(dir);
  const written = [];
  for (const { filename, dataUrl, subdir } of files || []) {
    const { bytes } = decodeDataUrl(dataUrl);
    const name = sanitiseFilename(filename);
    const target = subdir ? safeJoin(dir, subdir) : dir;
    await ensureDir(target);
    await fsp.writeFile(path.join(target, name), bytes);
    written.push(subdir ? `${subdir}/${name}` : name);
  }
  sendJson(res, 200, { ok: true, dir, written });
});

/**
 * Write the manifest that accompanies a batch render.
 *
 * This is the handoff to anything that consumes the rendered images -- a rules
 * engine or board UI can look a card up by number instead of guessing at
 * filenames. Deliberately the only coupling between this tool and whatever
 * reads its output.
 */
route('POST', '/api/export/index', async (req, res) => {
  const { cards, subfolder, outputDir, generatedAt } = await readJsonBody(req);
  const baseDir = await resolveOutputDir(outputDir);
  const dir = subfolder ? safeJoin(baseDir, subfolder) : baseDir;
  await ensureDir(dir);

  const manifest = {
    schema: 1,
    generatedAt: generatedAt || null,
    count: (cards || []).length,
    cards: cards || [],
  };
  const target = path.join(dir, 'index.json');
  await fsp.writeFile(target, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  sendJson(res, 200, { ok: true, path: target, count: manifest.count });
});

// --- spreadsheet import -----------------------------------------------------

/**
 * Turn a pasted CSV/TSV table into card JSON files. Column headers are matched
 * loosely so a manifest exported straight out of Excel usually just works.
 */
route('POST', '/api/import', async (req, res) => {
  const { text, folder = '', dryRun = false } = await readJsonBody(req);
  if (!text || !text.trim()) return sendJson(res, 400, { error: 'Nothing to import' });

  const rows = parseDelimited(text, detectDelimiter(text));
  if (rows.length < 2) return sendJson(res, 400, { error: 'Need a header row plus at least one card' });

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const pick = (row, ...names) => {
    for (const name of names) {
      const idx = headers.indexOf(name);
      if (idx !== -1 && row[idx] != null && row[idx].trim() !== '') return row[idx].trim();
    }
    return '';
  };
  const truthy = (v) => /^(1|y|yes|t|true|x|\*)$/i.test(v.trim());

  const cards = [];
  for (const row of rows.slice(1)) {
    const title = pick(row, 'title', 'name', 'cardname');
    if (!title) continue;

    const eraRaw = pick(row, 'era', 'deck', 'period', 'phase').toLowerCase();
    const era = /mid/.test(eraRaw) ? 'mid' : /late/.test(eraRaw) ? 'late' : 'early';

    const sideRaw = pick(row, 'association', 'side', 'faction', 'owner', 'affiliation').toLowerCase();
    const association = /ussr|soviet|red/.test(sideRaw)
      ? 'ussr'
      : /usa|us|american|blue/.test(sideRaw)
        ? 'usa'
        : 'neutral';

    cards.push({
      number: Number(pick(row, 'number', 'no', 'num', 'cardnumber', 'id', 'cardid')) || null,
      ops: Number(pick(row, 'ops', 'opspoints', 'operationpoints', 'points', 'value')) || 0,
      title,
      era,
      association,
      text: pick(row, 'text', 'effect', 'event', 'eventtext', 'description', 'body'),
      removedOnEvent: truthy(pick(row, 'removed', 'removedonevent', 'remove', 'star')),
      optional: truthy(pick(row, 'optional', 'opt')),
      permanent: truthy(pick(row, 'permanent', 'perm')),
      scoring: truthy(pick(row, 'scoring', 'score')) || /scoring/i.test(title),
    });
  }

  if (dryRun) return sendJson(res, 200, { count: cards.length, cards: cards.slice(0, 25) });

  const targetDir = safeJoin(LIBRARY, folder);
  await ensureDir(targetDir);
  const written = [];
  for (const card of cards) {
    const prefix = card.number != null ? String(card.number).padStart(3, '0') + ' - ' : '';
    const filename = sanitiseName(prefix + card.title, 'card') + '.json';
    const full = { schema: 1, id: slugify(card.title), ...card, art: null, presentation: {} };
    await fsp.writeFile(path.join(targetDir, filename), JSON.stringify(full, null, 2) + '\n', 'utf8');
    written.push(filename);
  }
  sendJson(res, 200, { ok: true, count: written.length, written });
});

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// --- Tabletop Simulator export ---------------------------------------------

/**
 * Write a TTS deck: face atlas sheets, a shared back, and a saved-object JSON
 * that TTS can load directly. The browser composites the atlases (same renderer
 * as the preview); this endpoint only puts the bytes on disk.
 */
route('POST', '/api/tts', async (req, res) => {
  const { name, atlases, back, cardNames, outputDir } = await readJsonBody(req);
  const deckName = sanitiseName(name, 'CustomDeck');
  const baseDir = await resolveOutputDir(outputDir);
  const dir = path.join(baseDir, 'TTS', deckName);
  await ensureDir(dir);

  const written = [];
  const customDeck = {};
  let deckIds = [];
  let cardIndex = 0;

  const backFile = `${deckName}-back.png`;
  await fsp.writeFile(path.join(dir, backFile), decodeDataUrl(back).bytes);
  written.push(backFile);

  for (let i = 0; i < atlases.length; i++) {
    const sheet = atlases[i];
    const faceFile = `${deckName}-faces-${i + 1}.png`;
    await fsp.writeFile(path.join(dir, faceFile), decodeDataUrl(sheet.dataUrl).bytes);
    written.push(faceFile);

    const deckId = i + 1;
    customDeck[deckId] = {
      FaceURL: `file:///${path.join(dir, faceFile).replace(/\\/g, '/')}`,
      BackURL: `file:///${path.join(dir, backFile).replace(/\\/g, '/')}`,
      NumWidth: sheet.columns,
      NumHeight: sheet.rows,
      BackIsHidden: true,
      UniqueBack: false,
      Type: 0,
    };
    for (let slot = 0; slot < sheet.count; slot++) {
      deckIds.push(deckId * 100 + slot);
      cardIndex++;
    }
  }

  const containedObjects = deckIds.map((cardId, i) => ({
    Name: 'Card',
    Nickname: (cardNames && cardNames[i]) || '',
    CardID: cardId,
    Transform: {
      posX: 0, posY: 0, posZ: 0,
      rotX: 0, rotY: 180, rotZ: 180,
      scaleX: 1, scaleY: 1, scaleZ: 1,
    },
    CustomDeck: customDeck,
  }));

  const saved = {
    SaveName: deckName,
    GameMode: deckName,
    Date: '',
    VersionNumber: '',
    ObjectStates: [
      {
        Name: 'Deck',
        Nickname: deckName,
        Transform: {
          posX: 0, posY: 1, posZ: 0,
          rotX: 0, rotY: 180, rotZ: 180,
          scaleX: 1, scaleY: 1, scaleZ: 1,
        },
        DeckIDs: deckIds,
        CustomDeck: customDeck,
        ContainedObjects: containedObjects,
      },
    ],
  };

  const jsonFile = `${deckName}.json`;
  await fsp.writeFile(path.join(dir, jsonFile), JSON.stringify(saved, null, 2), 'utf8');
  written.push(jsonFile);

  sendJson(res, 200, { ok: true, dir, written, cards: cardIndex });
});

// ------------------------------------------------------------ static serving

async function serveStatic(req, res, url) {
  let relative = decodeURIComponent(url.pathname);
  if (relative === '/') relative = '/index.html';

  // The library folder is exposed read-only so the canvas can draw stored art.
  let file;
  if (relative.startsWith('/library/')) {
    file = safeJoin(LIBRARY, relative.slice('/library/'.length));
  } else {
    file = safeJoin(PUBLIC, relative.slice(1));
  }

  try {
    const stat = await fsp.stat(file);
    if (stat.isDirectory()) return sendJson(res, 404, { error: 'Not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.ttf' || ext === '.otf' ? 'public, max-age=86400' : 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: `Not found: ${relative}` });
    throw err;
  }
}

// -------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    const match = routes.find((r) => r.method === req.method && r.pattern === url.pathname);
    if (match) return await match.handler(req, res, url);
    if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'No such endpoint' });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
    await serveStatic(req, res, url);
  } catch (err) {
    const status = err.statusCode || 500;
    if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'Server error' });
  }
});

async function start() {
  await ensureDir(LIBRARY);
  await ensureDir(IMAGES);
  await ensureDir(OUTPUT_DEFAULT);

  server.listen(PORT, '127.0.0.1', () => {
    const address = `http://127.0.0.1:${PORT}/`;
    console.log('');
    console.log('  Twilight Struggle Card Generator');
    console.log('  --------------------------------');
    console.log(`  Running at   ${address}`);
    console.log(`  Library      ${LIBRARY}`);
    console.log(`  Output       ${OUTPUT_DEFAULT}`);
    console.log('');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Either the generator is already running, or set TSCG_PORT to something else.\n`);
    process.exit(1);
  }
  throw err;
});

start();
