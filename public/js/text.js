/*
 * Styled-text engine for canvas.
 *
 * The original generator drew every block in a single uniform font, so italics
 * could only ever apply to a whole field. This replaces that with a run-based
 * pipeline:
 *
 *   markup string -> styled runs -> word tokens -> wrapped lines -> drawn segments
 *
 * Wrapping happens across style boundaries, so "*Play after* Marshall Plan" can
 * break mid-phrase and still render correctly.
 */

export const FAMILY_TEXT = 'TSCaslon';
export const FAMILY_DISPLAY = 'TSCaslonDisplay';

// ---------------------------------------------------------------- 1. markup

/**
 * Parse inline markup into styled runs.
 *
 *   *italic*        **bold**        ***bold italic***
 *   \* renders a literal asterisk
 *
 * Markers toggle rather than nest strictly, which is forgiving of the way
 * people actually type. An unclosed marker simply runs to the end of the text.
 */
export function parseMarkup(text) {
  const runs = [];
  let buffer = '';
  let bold = false;
  let italic = false;

  const flush = () => {
    if (buffer) runs.push({ text: buffer, bold, italic });
    buffer = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\\' && text[i + 1] === '*') {
      buffer += '*';
      i++;
      continue;
    }

    if (ch === '*') {
      let count = 1;
      while (text[i + count] === '*' && count < 3) count++;
      flush();
      if (count === 1) italic = !italic;
      else if (count === 2) bold = !bold;
      else {
        bold = !bold;
        italic = !italic;
      }
      i += count - 1;
      continue;
    }

    buffer += ch;
  }
  flush();
  return runs.length ? runs : [{ text: '', bold: false, italic: false }];
}

/** Strip markup without rendering it -- used for filenames and list labels. */
export function stripMarkup(text) {
  return parseMarkup(String(text || ''))
    .map((r) => r.text)
    .join('');
}

// ----------------------------------------------------------------- 2. fonts

/** Build a CSS font shorthand for a run's style at a given size. */
export function fontString({ bold, italic }, size, family = FAMILY_TEXT) {
  const style = italic ? 'italic ' : '';
  const weight = bold ? '700 ' : '';
  return `${style}${weight}${size}px "${family}", Georgia, serif`;
}

/**
 * Canvas silently substitutes a fallback face for a font that has not finished
 * loading, which is exactly how the original tool lost its italics. Waiting on
 * every variant we intend to use removes that failure mode.
 */
export async function ensureFontsLoaded() {
  if (!document.fonts) return;
  const probes = [];
  for (const family of [FAMILY_TEXT, FAMILY_DISPLAY]) {
    for (const weight of ['400', '700']) {
      for (const style of ['normal', 'italic']) {
        probes.push(document.fonts.load(`${style} ${weight} 24px "${family}"`).catch(() => {}));
      }
    }
  }
  await Promise.all(probes);
  await document.fonts.ready;
}

// ------------------------------------------------------- 3. tokens and lines

/**
 * Split runs into words and spaces, each carrying its own style.
 * `base` lets a whole block default to bold or italic (card titles are bold;
 * markup inside them still toggles relative to that).
 */
function tokenize(runs, base = {}) {
  const tokens = [];
  for (const run of runs) {
    const parts = run.text.split(/(\s+)/);
    for (const part of parts) {
      if (!part) continue;
      tokens.push({
        text: part,
        bold: run.bold || Boolean(base.bold),
        italic: run.italic || Boolean(base.italic),
        isSpace: /^\s+$/.test(part),
      });
    }
  }
  return tokens;
}

/** Merge neighbouring same-style tokens so kerning survives within a span. */
function coalesce(tokens) {
  const segments = [];
  for (const token of tokens) {
    const last = segments[segments.length - 1];
    if (last && last.bold === token.bold && last.italic === token.italic) {
      last.text += token.text;
    } else {
      segments.push({ text: token.text, bold: token.bold, italic: token.italic });
    }
  }
  return segments;
}

/** Measure a line's true width by measuring each styled segment as a unit. */
function measureSegments(ctx, segments, size, family) {
  let width = 0;
  for (const segment of segments) {
    ctx.font = fontString(segment, size, family);
    segment.width = ctx.measureText(segment.text).width;
    width += segment.width;
  }
  return width;
}

/**
 * Wrap one paragraph of markup into lines that fit `maxWidth`.
 * Returns lines of coalesced, measured segments ready to draw.
 */
export function layoutParagraph(ctx, markup, { maxWidth, size, family = FAMILY_TEXT, base = {} }) {
  const tokens = tokenize(parseMarkup(markup), base);
  const lines = [];
  let current = [];

  const widthOf = (list) => {
    const segments = coalesce(list);
    return measureSegments(ctx, segments, size, family);
  };

  for (const token of tokens) {
    if (token.isSpace && current.length === 0) continue; // no leading space on a line

    const candidate = current.concat(token);
    if (!token.isSpace && current.length && widthOf(candidate) > maxWidth) {
      while (current.length && current[current.length - 1].isSpace) current.pop();
      lines.push(current);
      current = [token];
    } else {
      current = candidate;
    }
  }
  while (current.length && current[current.length - 1].isSpace) current.pop();
  if (current.length) lines.push(current);
  if (!lines.length) lines.push([]);

  return lines.map((tokenList) => {
    const segments = coalesce(tokenList);
    const width = measureSegments(ctx, segments, size, family);
    return { segments, width };
  });
}

/**
 * Lay out a whole block: newline-separated paragraphs, each wrapped in turn.
 * A blank line produces a wider gap, mirroring how the printed cards space
 * their separate effect clauses.
 */
export function layoutBlock(ctx, text, opts) {
  const {
    maxWidth,
    size,
    family = FAMILY_TEXT,
    base = {},
    lineHeight = size + 4,
    paragraphGap = Math.round(size * 0.45),
    blankLineGap = Math.round(size * 0.9),
  } = opts;

  const paragraphs = String(text || '').split('\n');
  const lines = [];
  let height = 0;
  let pendingGap = 0;
  let seenContent = false;

  for (const paragraph of paragraphs) {
    if (!paragraph.trim()) {
      if (seenContent) pendingGap = Math.max(pendingGap, blankLineGap);
      continue;
    }
    if (seenContent) height += pendingGap || paragraphGap;
    pendingGap = 0;

    for (const line of layoutParagraph(ctx, paragraph, { maxWidth, size, family, base })) {
      lines.push({ ...line, offsetY: height });
      height += lineHeight;
    }
    seenContent = true;
  }

  // The block's height is the distance from the first baseline to the last,
  // plus one line's worth of descent -- not an extra full line.
  return { lines, height: Math.max(0, height), lineHeight, size, family };
}

// ---------------------------------------------------------------- 4. drawing

/**
 * Draw a laid-out block centred on `centreX`, with `topBaseline` as the
 * baseline of its first line.
 */
export function drawBlock(ctx, block, centreX, topBaseline, opts = {}) {
  const { color = '#211D1E', underline = null } = opts;
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  ctx.fillStyle = color;

  for (const line of block.lines) {
    const baseline = topBaseline + line.offsetY;
    let x = centreX - line.width / 2;

    for (const segment of line.segments) {
      ctx.font = fontString(segment, block.size, block.family);
      ctx.fillText(segment.text, x, baseline);
      x += segment.width;
    }

    if (underline && line.width > 0) {
      const start = centreX - line.width / 2;
      ctx.beginPath();
      ctx.moveTo(start, baseline + underline.offset);
      ctx.lineTo(start + line.width, baseline + underline.offset);
      ctx.strokeStyle = underline.color;
      ctx.lineWidth = underline.width;
      ctx.stroke();
    }
  }

  ctx.textAlign = previousAlign;
  return topBaseline + block.height;
}

/**
 * Find the largest font size in `[min, max]` whose laid-out block fits within
 * `maxHeight`. Lets the single free-form effect box stay readable without the
 * user hand-tuning a size dropdown for every card.
 */
export function fitBlock(ctx, text, opts, maxHeight, { min = 11, max = 20 } = {}) {
  let best = null;
  for (let size = max; size >= min; size--) {
    const lineHeight = opts.lineHeightFor ? opts.lineHeightFor(size) : size + 4;
    const block = layoutBlock(ctx, text, { ...opts, size, lineHeight });
    if (!best) best = block;
    if (block.height <= maxHeight) return block;
  }
  return best;
}
