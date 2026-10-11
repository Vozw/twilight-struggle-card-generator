/*
 * Minimal .xlsx / .xlsm reader -- zip container plus the two XML parts we care
 * about. Node has zlib built in but no zip reader, so the container is walked
 * by hand. Enough for reading a plain data sheet; it ignores styles, formulas,
 * merged cells and everything else.
 */

const fs = require('node:fs');
const zlib = require('node:zlib');

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** Read a zip archive into a Map of filename -> Buffer. */
function readZip(path) {
  const buf = fs.readFileSync(path);

  // The end-of-central-directory record sits at the tail, after a comment of
  // unknown length, so scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip file (no end-of-central-directory record)');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_SIGNATURE) break;

    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLength = buf.readUInt16LE(offset + 28);
    const extraLength = buf.readUInt16LE(offset + 30);
    const commentLength = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra fields at its own lengths.
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith('/')) {
      files.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw));
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Turn a column reference such as "AB7" into a zero-based column index. */
function columnIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)[1];
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function textOf(fragment) {
  const parts = [...fragment.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeEntities(m[1]));
  return parts.join('');
}

/**
 * Read a workbook into { sheetName: rows }, where each row is an array of
 * strings padded out to the highest populated column.
 */
function readWorkbook(path) {
  const files = readZip(path);

  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = sharedXml
    ? [...sharedXml.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))
    : [];

  const workbook = files.get('xl/workbook.xml').toString('utf8');
  const relsXml = files.get('xl/_rels/workbook.xml.rels').toString('utf8');

  const targets = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0])?.[1];
    const target = /Target="([^"]+)"/.exec(m[0])?.[1];
    if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
  }

  const out = {};
  for (const m of workbook.matchAll(/<sheet\b[^>]*\/>/g)) {
    const name = decodeEntities(/name="([^"]+)"/.exec(m[0])?.[1] || '');
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1];
    const part = targets.get(rid);
    const sheetXml = part && files.get(part);
    if (!sheetXml) continue;

    const rows = [];
    for (const rowMatch of sheetXml.toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = new Map();
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cellMatch[1];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        if (!ref) continue;
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const body = cellMatch[2];

        let value;
        if (type === 's') {
          const idx = Number(/<v>(\d+)<\/v>/.exec(body)?.[1]);
          value = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = textOf(body);
        } else {
          value = decodeEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        }
        if (value !== '') cells.set(columnIndex(ref), value);
      }
      if (cells.size) {
        const width = Math.max(...cells.keys()) + 1;
        rows.push(Array.from({ length: width }, (_, i) => cells.get(i) ?? ''));
      } else {
        rows.push([]);
      }
    }
    out[name] = rows;
  }
  return out;
}

module.exports = { readZip, readWorkbook };
