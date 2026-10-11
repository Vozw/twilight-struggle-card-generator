/*
 * Card renderer.
 *
 * Everything is drawn procedurally -- the era banner and star included -- so a
 * reskin can rename "EARLY WAR" and recolour the bar and star without anyone
 * having to open an image editor. The era and association colours are the
 * presets in cardmodel.js, sampled from the printed cards.
 *
 * Rendering runs at a caller-supplied scale so the same code produces the 375px
 * live preview, a 750px print export, and the TTS atlas tiles.
 */

import { GEOMETRY, SCORING, resolveStyle, normalise } from './cardmodel.js';
import {
  layoutBlock,
  drawBlock,
  fitBlock,
  ensureFontsLoaded,
  FAMILY_TEXT,
  FAMILY_DISPLAY,
} from './text.js';

const imageCache = new Map();

/**
 * Card JSON stores art as a library-relative path (`_images/foo.png`) so the
 * files stay portable if the whole folder moves. Turn that into a URL the
 * server actually serves.
 */
export function resolveArtSrc(src) {
  if (!src) return '';
  if (/^(https?:|data:|blob:|\/)/.test(src)) return src;
  return `/library/${src}`;
}

/** Load an image once and reuse it. Same-origin only, so the canvas stays clean. */
export function loadImage(src) {
  if (!src) return Promise.resolve(null);
  const url = resolveArtSrc(src);
  if (imageCache.has(url)) return imageCache.get(url);

  const promise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

export function forgetImage(src) {
  imageCache.delete(resolveArtSrc(src));
}

// ------------------------------------------------------------------ banner

/** Trace a point-up five-pointed star. */
function starPath(ctx, cx, cy, outerRadius, innerRatio = 0.382) {
  const inner = outerRadius * innerRatio;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? outerRadius : inner;
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Draw the era bar: a flat colour band with a soft drop shadow and a darker
 * lower edge, matching the printed cards' slight relief.
 */
function drawBar(ctx, style) {
  const { bannerInset, width } = GEOMETRY;
  const barHeight = style.barHeight;
  // Keep the bar centred on the star as it grows or shrinks.
  const barTop = Math.round(GEOMETRY.starCentreY - barHeight / 2);
  const barLeft = bannerInset;
  const barWidth = width - bannerInset * 2;

  ctx.save();
  ctx.shadowColor = 'rgba(30, 65, 87, 0.45)';
  ctx.shadowBlur = 3;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = style.barColor;
  ctx.fillRect(barLeft, barTop, barWidth, barHeight);
  ctx.restore();

  // Subtle darker lower edge for depth.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#000000';
  ctx.fillRect(barLeft, barTop + barHeight - 2, barWidth, 2);
  ctx.restore();

  // Thin dark keyline around the whole bar, as on the printed cards.
  ctx.save();
  ctx.strokeStyle = style.barKeyline;
  ctx.lineWidth = 1;
  ctx.strokeRect(barLeft + 0.5, barTop + 0.5, barWidth - 1, barHeight - 1);
  ctx.restore();

  return { barTop, barHeight, barLeft, barWidth };
}

/** Draw the banner text inside the bar, clear of the star. */
function drawBannerText(ctx, style, bar) {
  const text = String(style.bannerText || '').toUpperCase();
  if (!text) return;

  const textLeft = GEOMETRY.starCentreX + GEOMETRY.starRadius + 8;
  const available = bar.barLeft + bar.barWidth - textLeft - 10;
  const centreX = textLeft + available / 2;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = style.bannerTextColor;

  // Shrink to fit rather than overflow when a reskin uses a long era name.
  let size = style.bannerTextSize;
  const setFont = () => {
    ctx.font = `700 ${size}px "Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${style.bannerTextSpacing}px`;
  };
  setFont();
  while (ctx.measureText(text).width > available && size > 9) {
    size -= 0.5;
    setFont();
  }

  // Centre by cap height rather than the em box, so the text sits optically
  // centred in the bar the way the printed cards do.
  const capHeight = ctx.measureText(text).actualBoundingBoxAscent || size * 0.71;
  ctx.fillText(text, centreX, bar.barTop + bar.barHeight / 2 + capHeight / 2);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  ctx.restore();
}

/**
 * Draw the star and the operations-points number sitting on it.
 *
 * The outline is a stroke *under* a slightly smaller fill rather than an
 * outline drawn on top, so the points stay sharp instead of being rounded off
 * by a wide stroke join.
 */
function drawStar(ctx, card, style) {
  const { starCentreX } = GEOMETRY;
  // Neutral stars are drawn slightly smaller and sit a touch lower on the
  // printed cards than the superpower ones.
  const starRadius = GEOMETRY.starRadius * style.starScale;
  const starCentreY = GEOMETRY.starCentreY + style.starOffsetY;
  const outlineWidth = style.starOutlineWidth;

  // Silhouette layer, which also casts the drop shadow. Stars with an outline
  // paint it here; the neutral star has none and so paints its own fill.
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.42)';
  ctx.shadowBlur = 2.5;
  ctx.shadowOffsetX = 1;
  ctx.shadowOffsetY = 2.5;
  starPath(ctx, starCentreX, starCentreY, starRadius);
  ctx.fillStyle = outlineWidth > 0 ? style.starOutline : style.starFill;
  ctx.fill();
  if (outlineWidth > 0) {
    ctx.strokeStyle = style.starOutline;
    ctx.lineWidth = outlineWidth;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.restore();

  // Fill layer: inset by the outline width so the outline reads as a border.
  const innerRadius = starRadius - outlineWidth * 0.9;

  if (style.starFillRight) {
    // Neutral: split along a line through the centre, tilted off vertical.
    const angle = (style.starSplitAngle * Math.PI) / 180;
    const reach = starRadius * 2 + 4;
    for (const [colour, side] of [
      [style.starFill, -1],
      [style.starFillRight, 1],
    ]) {
      ctx.save();
      ctx.translate(starCentreX, starCentreY);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.rect(side < 0 ? -reach : 0, -reach, reach, reach * 2);
      ctx.clip();
      ctx.rotate(-angle);
      ctx.translate(-starCentreX, -starCentreY);
      starPath(ctx, starCentreX, starCentreY, innerRadius);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.restore();
    }
  } else {
    starPath(ctx, starCentreX, starCentreY, innerRadius);
    ctx.fillStyle = style.starFill;
    ctx.fill();
  }

  const ops = card.ops === 0 || card.ops == null ? '' : String(card.ops);
  if (ops) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.opsColor;
    ctx.font = `700 ${Math.round(starRadius * 1.05)}px "Franklin Gothic Medium", Arial, sans-serif`;
    ctx.fillText(ops, starCentreX, starCentreY + 1);
    ctx.restore();
  }
}

// ------------------------------------------------------------------ artwork

/** Scale artwork to fit the image box while preserving its aspect ratio. */
function fitArt(image) {
  const { imageMaxWidth, imageMaxHeight } = GEOMETRY;
  const scale = Math.min(imageMaxWidth / image.width, imageMaxHeight / image.height, 1);
  return { width: image.width * scale, height: image.height * scale };
}

// ------------------------------------------------------------- card surface

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

// ------------------------------------------------------- scoring card body

/**
 * Draw the scoring-card panel: a bordered box whose first band carries the
 * title, followed by one banded row per scoring line, alternating white and
 * pale blue.
 *
 * The text convention matches what the card manifest already produces -- a
 * leading line ending in a colon becomes the panel's header, and every line
 * after it becomes a row:
 *
 *   Both sides score:
 *   Presence: 3
 *   Domination: 5
 *   Control: 7
 *   +1 per controlled Battleground Country in Region
 */
function drawScoringPanel(ctx, card, style) {
  const g = GEOMETRY;
  const left = g.scoringPanelLeft;
  const panelWidth = g.scoringPanelWidth;
  const centreX = left + panelWidth / 2;
  const innerWidth = panelWidth - 24;

  const lines = String(card.text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // A leading "Both sides score:" style line rides in the header band.
  const hasHeader = lines.length > 1 && /:$/.test(lines[0]);
  const header = hasHeader ? lines[0] : '';
  const rows = hasHeader ? lines.slice(1) : lines;

  // --- lay the panel out at a candidate size -------------------------------
  const titleText = (card.title || '').toUpperCase() + (card.removedOnEvent || card.permanent ? '\\*' : '');
  const panelTop = g.scoringPanelTop;

  const measure = (rowSize, titleMax) => {
    const layTitle = (size) =>
      layoutBlock(ctx, titleText, {
        maxWidth: innerWidth,
        size,
        family: style.fontFamily,
        base: { bold: true },
        lineHeight: Math.round(size * 1.12),
      });
    let titleSize = titleMax;
    let titleBlock = layTitle(titleSize);
    while (titleBlock.lines.length > 2 && titleSize > 16) {
      titleSize -= 1;
      titleBlock = layTitle(titleSize);
    }

    const rowOpts = {
      maxWidth: innerWidth,
      size: rowSize,
      family: style.fontFamily,
      lineHeight: rowSize + 5,
    };
    const headerBlock = header ? layoutBlock(ctx, header, rowOpts) : null;
    const headerHeight =
      12 + titleBlock.height + (headerBlock ? headerBlock.height + 4 : 0) + 8;

    // One fixed band height per line of text, which is what the printed cards
    // do -- a two-line entry gets exactly two rows' worth of space.
    const lineHeight = Math.round(g.scoringRowLineHeight * (rowSize / g.scoringRowSize));
    const rowBlocks = rows.map((row) => layoutBlock(ctx, row, rowOpts));
    const rowHeights = rowBlocks.map((b) => Math.max(1, b.lines.length) * lineHeight);
    return {
      titleSize, titleBlock, headerBlock, headerHeight, rowBlocks, rowHeights,
      totalHeight: headerHeight + rowHeights.reduce((a, b) => a + b, 0),
    };
  };

  // Scoring regions vary from three rows to five, so shrink until the panel
  // and the "may not be held" bar both fit on the card.
  const bottomLimit = card.mayNotBeHeld
    ? GEOMETRY.height - 22 - g.scoringHeldBarHeight - 12
    : GEOMETRY.height - 30;

  let layout = null;
  for (let rowSize = g.scoringRowSize; rowSize >= 11; rowSize -= 1) {
    layout = measure(rowSize, Math.min(g.scoringTitleSize, rowSize + 9));
    if (panelTop + layout.totalHeight <= bottomLimit) break;
  }
  const { titleSize, titleBlock, headerBlock, headerHeight, rowBlocks, rowHeights, totalHeight } = layout;

  // --- paint the bands ------------------------------------------------------
  // Colours come from the card's scoring region, which each card tints itself
  // with to match the map.
  ctx.save();
  ctx.fillStyle = style.scoringHeader;
  ctx.fillRect(left, panelTop, panelWidth, headerHeight);

  let y = panelTop + headerHeight;
  rowHeights.forEach((h, i) => {
    ctx.fillStyle = i % 2 === 0 ? style.scoringAlt : style.scoringBand;
    ctx.fillRect(left, y, panelWidth, h);
    y += h;
  });

  ctx.strokeStyle = SCORING.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(left + 0.5, panelTop + 0.5, panelWidth - 1, totalHeight - 1);
  ctx.restore();

  // --- draw the text --------------------------------------------------------
  // These offsets must mirror the headerHeight formula above, or the header
  // line drifts out of its band and collides with the first row.
  const HEADER_PAD_TOP = 12;
  const HEADER_GAP = 4;

  drawBlock(ctx, titleBlock, centreX, panelTop + HEADER_PAD_TOP + titleSize, {
    color: style.inkColor,
  });
  if (headerBlock) {
    const headerBaseline =
      panelTop + HEADER_PAD_TOP + titleBlock.height + HEADER_GAP + headerBlock.size;
    drawBlock(ctx, headerBlock, centreX, headerBaseline, { color: style.inkColor });
  }

  y = panelTop + headerHeight;
  rowBlocks.forEach((block, i) => {
    const h = rowHeights[i];
    const baseline = y + (h - block.height) / 2 + block.size;
    drawBlock(ctx, block, centreX, baseline, { color: style.inkColor });
    y += h;
  });

  // --- removal note ---------------------------------------------------------
  // Southeast Asia Scoring is the one scoring card removed after play (7.2),
  // and says so in red above the bar rather than carrying the usual footer.
  if (card.removedOnEvent) {
    const barTop = Math.min(
      GEOMETRY.height - 22 - g.scoringHeldBarHeight,
      Math.max(g.scoringHeldBarTop, panelTop + totalHeight + 18)
    );
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = style.accentColor;
    let size = 16;
    const note = style.scoringRemovalText;
    const setNoteFont = () => {
      ctx.font = `italic 700 ${size}px "${style.fontFamily}", Georgia, serif`;
    };
    setNoteFont();
    while (ctx.measureText(note).width > panelWidth && size > 10) {
      size -= 1;
      setNoteFont();
    }
    ctx.fillText(note, centreX, barTop - 12);
    ctx.restore();
  }

  // --- "MAY NOT BE HELD" ----------------------------------------------------
  if (card.mayNotBeHeld) {
    // Sits at its printed position when the panel is short, and is pushed down
    // only as far as the card allows when the panel runs long.
    const barTop = Math.min(
      GEOMETRY.height - 22 - g.scoringHeldBarHeight,
      Math.max(g.scoringHeldBarTop, panelTop + totalHeight + 18)
    );
    ctx.save();
    ctx.fillStyle = SCORING.heldBar;
    ctx.fillRect(left - 1, barTop, panelWidth + 1, g.scoringHeldBarHeight);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = SCORING.heldText;
    ctx.font = `700 17px "Franklin Gothic Medium", "Arial Narrow", Arial, sans-serif`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '1px';
    const label = style.heldLabel ?? SCORING.heldLabel;
    ctx.fillText(label, centreX, barTop + g.scoringHeldBarHeight / 2 + 6);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    ctx.restore();
  }
}

// ---------------------------------------------------------------- main draw

/**
 * Render a card face into `ctx`. The context is expected to already be scaled;
 * all coordinates below are in the card's 375x525 design space.
 */
export async function drawCardFace(ctx, rawCard, options = {}) {
  const card = normalise(rawCard);
  const style = resolveStyle(card);
  const { width, height } = GEOMETRY;
  // Atlas tiles are square-cornered: Tabletop Simulator applies its own card
  // mask, so transparent rounded corners would show through on the table.
  const cornerRadius = options.squareCorners ? 0 : GEOMETRY.cornerRadius;

  ctx.clearRect(0, 0, width, height);
  roundedRect(ctx, 0, 0, width, height, cornerRadius);
  ctx.fillStyle = style.cardColor;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // --- artwork -------------------------------------------------------------
  // Scoring cards carry no artwork; their panel occupies that space instead.
  let artHeight = 0;
  if (!card.scoring && card.art?.src) {
    const image = await loadImage(card.art.src);
    if (image) {
      const { width: w, height: h } = fitArt(image);
      const x = (width - w) / 2;
      ctx.drawImage(image, x, GEOMETRY.imageTop, w, h);
      if (card.art.mode !== 'logo') {
        ctx.beginPath();
        ctx.rect(x, GEOMETRY.imageTop, w, h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = style.inkColor;
        ctx.stroke();
      }
      artHeight = h;
    }
  }

  // --- banner (drawn over the artwork, as on the printed cards) ------------
  if (style.showBanner) {
    const bar = drawBar(ctx, style);
    drawBannerText(ctx, style, bar);
  }
  if (style.showStar) drawStar(ctx, card, style);

  // --- card number ---------------------------------------------------------
  const numberText = [
    card.number == null || card.number === '' ? '' : String(card.number),
    card.optional ? 'OPTIONAL' : '',
  ]
    .filter(Boolean)
    .join(' - ');
  if (numberText) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = style.inkColor;
    ctx.font = `14px "${style.fontFamily}", Georgia, serif`;
    ctx.fillText(numberText, width / 2, GEOMETRY.numberBaseline);
    ctx.restore();
  }

  // Scoring cards diverge completely from here: a banded panel replaces the
  // title, effect text and footer.
  if (card.scoring) {
    drawScoringPanel(ctx, card, style);
    ctx.restore();
    return { artHeight: 0 };
  }

  // --- footer --------------------------------------------------------------
  const starred = card.removedOnEvent || card.permanent;
  if (starred && style.footerText) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = style.accentColor;

    // Shrink to fit rather than run off the card, since a reskin may want a
    // longer line here than the stock "Remove from play…".
    let size = GEOMETRY.footerSize;
    const setFooterFont = () => {
      ctx.font = `italic 700 ${size}px "${style.fontFamily}", Georgia, serif`;
    };
    setFooterFont();
    while (ctx.measureText(style.footerText).width > width - 34 && size > 10) {
      size -= 1;
      setFooterFont();
    }
    ctx.fillText(style.footerText, width / 2, GEOMETRY.footerBaseline);
    ctx.restore();
  }

  // --- title ---------------------------------------------------------------
  const centreX = width / 2;
  // The trailing star is escaped so the markup parser treats it as a literal
  // asterisk rather than an italic marker -- titles support *markup* too.
  const titleText = (card.title || '').toUpperCase() + (starred ? '\\*' : '');
  const layOutTitle = (size) =>
    layoutBlock(ctx, titleText, {
      maxWidth: GEOMETRY.textMaxWidth,
      size,
      family: style.fontFamily,
      base: { bold: true },
      lineHeight: Math.round(size * (GEOMETRY.titleLineHeight / GEOMETRY.titleSize)),
    });

  // Treat the configured title size as a maximum and shrink to avoid wrapping.
  // The bundled Caslon substitute runs wider than the original cards' face, so
  // titles that fit on one line there would otherwise break onto two here.
  let titleSize = style.titleSize;
  let titleBlock = layOutTitle(titleSize);
  const titleFloor = Math.max(18, Math.round(style.titleSize * 0.72));
  while (titleBlock.lines.length > 1 && titleSize > titleFloor) {
    titleSize -= 1;
    titleBlock = layOutTitle(titleSize);
  }
  const titleTop = GEOMETRY.imageTop + artHeight + GEOMETRY.titleGap;
  drawBlock(ctx, titleBlock, centreX, titleTop, {
    color: style.inkColor,
    underline: card.permanent ? { color: style.accentColor, width: 2, offset: 5 } : null,
  });

  // --- effect text ---------------------------------------------------------
  const bodyTop = titleTop + titleBlock.height + GEOMETRY.textTopPadding;
  const bodyBottom = (starred ? GEOMETRY.footerBaseline - 26 : height - 34);
  const available = bodyBottom - bodyTop;

  if (card.text && card.text.trim()) {
    const bodyOptions = {
      maxWidth: GEOMETRY.textMaxWidth,
      family: style.fontFamily,
      lineHeightFor: (size) => size + 4,
    };
    const block =
      style.fontSize === 'auto'
        ? fitBlock(ctx, card.text, bodyOptions, available, { min: 11, max: 20 })
        : layoutBlock(ctx, card.text, {
            ...bodyOptions,
            size: Number(style.fontSize),
            lineHeight: Number(style.fontSize) + 4,
          });

    // Nudge short text down a little so it sits in its space rather than
    // clinging to the title, but cap the drift so it never floats away.
    const slack = Math.max(0, available - block.height);
    drawBlock(ctx, block, centreX, bodyTop + Math.min(slack / 2, 18), { color: style.inkColor });
  }

  ctx.restore();
  return { artHeight };
}

/**
 * Render a card back. Reuses the face's banner styling so a generated back
 * stays visually consistent with the set it belongs to.
 */
export async function drawCardBack(ctx, options = {}) {
  const {
    title = 'TWILIGHT STRUGGLE',
    subtitle = '',
    barColor = '#282F42',
    cardColor = '#E3F5FF',
    starFill = '#D22429',
    starOutline = '#FFD109',
    art = null,
    squareCorners = false,
  } = options;
  const { width, height } = GEOMETRY;
  const cornerRadius = squareCorners ? 0 : GEOMETRY.cornerRadius;

  ctx.clearRect(0, 0, width, height);
  roundedRect(ctx, 0, 0, width, height, cornerRadius);
  ctx.fillStyle = barColor;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // Inner panel, inset so the dark border reads as a frame. Keeps its own
  // rounding even on a square-cornered atlas tile.
  roundedRect(ctx, 18, 18, width - 36, height - 36, Math.max(0, GEOMETRY.cornerRadius - 8));
  ctx.fillStyle = cardColor;
  ctx.fill();

  if (art) {
    const image = await loadImage(art);
    if (image) {
      const scale = Math.min((width - 90) / image.width, (height - 220) / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      ctx.drawImage(image, (width - w) / 2, (height - h) / 2 - 10, w, h);
    }
  } else {
    starPath(ctx, width / 2, height / 2, 74);
    ctx.strokeStyle = starOutline;
    ctx.lineWidth = 12;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = starFill;
    ctx.fill();
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = barColor;
  let size = 30;
  ctx.font = `700 ${size}px "${FAMILY_DISPLAY}", Georgia, serif`;
  while (ctx.measureText(title.toUpperCase()).width > width - 80 && size > 12) {
    size -= 1;
    ctx.font = `700 ${size}px "${FAMILY_DISPLAY}", Georgia, serif`;
  }
  ctx.fillText(title.toUpperCase(), width / 2, 88);
  if (subtitle) {
    ctx.font = `italic 18px "${FAMILY_TEXT}", Georgia, serif`;
    ctx.fillText(subtitle, width / 2, height - 70);
  }
  ctx.restore();

  ctx.restore();
}

/**
 * Render a card to its own canvas at `scale`, returning the canvas.
 * Used for exports, batch rendering, and TTS atlas tiles.
 */
export async function renderToCanvas(card, scale = 1, { back = null, squareCorners = false } = {}) {
  await ensureFontsLoaded();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(GEOMETRY.width * scale);
  canvas.height = Math.round(GEOMETRY.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  if (back) await drawCardBack(ctx, { ...back, squareCorners });
  else await drawCardFace(ctx, card, { squareCorners });
  return canvas;
}
