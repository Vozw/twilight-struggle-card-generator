/*
 * Mini-card rendering -- the small hand-display cards the Steam client shows
 * along the bottom of the screen.
 *
 * Structure, taken from the client: title at the top (keeping the red
 * lasting-effect underline), artwork below it, and a coloured strip along the
 * bottom carrying the operations value flanked by a pair of association stars.
 * Scoring cards swap the artwork for a red "may not be held" band.
 *
 * These are for a board UI rather than for print, so the design space is small
 * and roughly square; render at a scale that suits wherever they are displayed.
 */

import { GEOMETRY, SCORING, resolveStyle, normalise } from './cardmodel.js';
import { layoutBlock, drawBlock, ensureFontsLoaded } from './text.js';
import { loadImage } from './render.js';

export const MINI = {
  width: 180,
  height: 190,
  padding: 7,
  radius: 9,
  frame: '#8FA3B0',
  face: '#E7EEF3',
  stripHeight: 36,
  titleSize: 19,
  titleMinSize: 11,
  titleMaxLines: 3,
};

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

function starPath(ctx, cx, cy, outer, innerRatio = 0.382) {
  const inner = outer * innerRatio;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outer : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** One small association star, split down the middle when neutral. */
function drawMiniStar(ctx, cx, cy, radius, style) {
  starPath(ctx, cx, cy, radius);
  ctx.fillStyle = style.starOutline;
  ctx.strokeStyle = style.starOutline;
  ctx.lineWidth = Math.max(1.5, radius * 0.22);
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();

  const inner = radius - ctx.lineWidth * 0.8;
  if (style.starFillRight) {
    for (const [colour, from] of [
      [style.starFill, cx - radius - 1],
      [style.starFillRight, cx],
    ]) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(from, cy - radius - 1, radius + 1, radius * 2 + 2);
      ctx.clip();
      starPath(ctx, cx, cy, inner);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.restore();
    }
  } else {
    starPath(ctx, cx, cy, inner);
    ctx.fillStyle = style.starFill;
    ctx.fill();
  }
}

/** Draw one mini-card into an already-scaled context. */
export async function drawMiniCard(ctx, rawCard) {
  const card = normalise(rawCard);
  const style = resolveStyle(card);
  const { width, height, padding, radius, stripHeight } = MINI;

  ctx.clearRect(0, 0, width, height);

  // Frame and face.
  roundedRect(ctx, 0.5, 0.5, width - 1, height - 1, radius);
  ctx.fillStyle = MINI.face;
  ctx.fill();
  ctx.strokeStyle = MINI.frame;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.save();
  roundedRect(ctx, 1, 1, width - 2, height - 2, radius - 1);
  ctx.clip();

  let top = padding;

  // --- "may not be held" band, above the title on scoring cards ------------
  if (card.mayNotBeHeld) {
    const bandHeight = 20;
    ctx.fillStyle = SCORING.heldBar;
    ctx.fillRect(padding - 2, top, width - (padding - 2) * 2, bandHeight);
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = SCORING.heldText;
    ctx.font = `700 12px "Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif`;
    ctx.fillText(SCORING.heldLabel, width / 2, top + 14);
    ctx.restore();
    top += bandHeight + 5;
  }

  // --- title ----------------------------------------------------------------
  const titleText =
    (card.title || '').toUpperCase() + (card.removedOnEvent || card.permanent ? '\\*' : '');
  const innerWidth = width - padding * 2 - 4;

  const layTitle = (size) =>
    layoutBlock(ctx, titleText, {
      maxWidth: innerWidth,
      size,
      family: style.fontFamily,
      base: { bold: true },
      lineHeight: Math.round(size * 1.1),
    });

  let titleSize = MINI.titleSize;
  let titleBlock = layTitle(titleSize);
  while (titleBlock.lines.length > MINI.titleMaxLines && titleSize > MINI.titleMinSize) {
    titleSize -= 1;
    titleBlock = layTitle(titleSize);
  }

  drawBlock(ctx, titleBlock, width / 2, top + titleSize, {
    color: style.inkColor,
    underline: card.permanent ? { color: style.accentColor, width: 1.5, offset: 3 } : null,
  });
  top += titleBlock.height + 8;

  // --- artwork --------------------------------------------------------------
  const artTop = top;
  const artBottom = height - stripHeight - padding + 2;
  const artHeight = artBottom - artTop;

  if (!card.scoring && card.art?.src && artHeight > 12) {
    const image = await loadImage(card.art.src);
    if (image) {
      const boxWidth = width - padding * 2;
      // Cover the box and crop the overflow, so small panels still look full.
      const scale = Math.max(boxWidth / image.width, artHeight / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padding, artTop, boxWidth, artHeight);
      ctx.clip();
      ctx.drawImage(image, padding + (boxWidth - w) / 2, artTop + (artHeight - h) / 2, w, h);
      ctx.restore();
      ctx.strokeStyle = '#5A6B77';
      ctx.lineWidth = 1;
      ctx.strokeRect(padding + 0.5, artTop + 0.5, boxWidth - 1, artHeight - 1);
    }
  }

  // --- bottom strip: star, ops, star ---------------------------------------
  const stripTop = height - stripHeight - padding + 4;
  const stripLeft = padding;
  const stripWidth = width - padding * 2;

  ctx.fillStyle = style.barColor;
  ctx.fillRect(stripLeft, stripTop, stripWidth, stripHeight - 4);
  ctx.strokeStyle = style.barKeyline;
  ctx.lineWidth = 1;
  ctx.strokeRect(stripLeft + 0.5, stripTop + 0.5, stripWidth - 1, stripHeight - 5);

  const stripMid = stripTop + (stripHeight - 4) / 2;
  const starRadius = (stripHeight - 4) * 0.44;
  drawMiniStar(ctx, stripLeft + starRadius + 4, stripMid, starRadius, style);
  drawMiniStar(ctx, stripLeft + stripWidth - starRadius - 4, stripMid, starRadius, style);

  if (!card.scoring && card.ops) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `700 ${Math.round(stripHeight * 0.78)}px "Franklin Gothic Medium", Arial, sans-serif`;
    ctx.strokeText(String(card.ops), width / 2, stripMid + 1);
    ctx.fillStyle = '#1B1E22';
    ctx.fillText(String(card.ops), width / 2, stripMid + 1);
    ctx.restore();
  }

  ctx.restore();
}

/** Render a mini-card to its own canvas. */
export async function renderMiniToCanvas(card, scale = 1) {
  await ensureFontsLoaded();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(MINI.width * scale);
  canvas.height = Math.round(MINI.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  await drawMiniCard(ctx, card);
  return canvas;
}
