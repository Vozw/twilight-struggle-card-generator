/*
 * Tabletop Simulator deck assembly.
 *
 * TTS wants a grid atlas of card faces plus one shared back. The tiles are
 * produced by the same renderer that draws the live preview, so what you see in
 * the editor is exactly what ends up on the table.
 */

import { renderToCanvas } from './render.js';
import { GEOMETRY } from './cardmodel.js';

/** TTS caps a sheet at 10 columns by 7 rows. */
export const MAX_COLUMNS = 10;
export const MAX_ROWS = 7;
export const MAX_PER_SHEET = MAX_COLUMNS * MAX_ROWS;

/**
 * Pick a grid for `count` cards. Keeps sheets close to square rather than
 * always padding out to 10x7, so a nine-card set does not become a mostly
 * empty 10-wide strip.
 */
function chooseGrid(count) {
  const columns = Math.min(MAX_COLUMNS, Math.ceil(Math.sqrt(count)));
  const rows = Math.min(MAX_ROWS, Math.ceil(count / columns));
  return { columns, rows };
}

/**
 * Build the face atlases.
 * @param cards  array of card objects, in deck order
 * @param scale  1 = 375x525 per tile, 2 = 750x1050
 * @param onProgress  called with (done, total)
 */
export async function buildAtlases(cards, scale = 1, onProgress = () => {}) {
  const sheets = [];
  const tileWidth = Math.round(GEOMETRY.width * scale);
  const tileHeight = Math.round(GEOMETRY.height * scale);
  let done = 0;

  for (let start = 0; start < cards.length; start += MAX_PER_SHEET) {
    const slice = cards.slice(start, start + MAX_PER_SHEET);
    const { columns, rows } = chooseGrid(slice.length);

    const sheet = document.createElement('canvas');
    sheet.width = columns * tileWidth;
    sheet.height = rows * tileHeight;
    const ctx = sheet.getContext('2d');

    for (let i = 0; i < slice.length; i++) {
      const tile = await renderToCanvas(slice[i], scale, { squareCorners: true });
      const column = i % columns;
      const row = Math.floor(i / columns);
      ctx.drawImage(tile, column * tileWidth, row * tileHeight);
      onProgress(++done, cards.length);
    }

    sheets.push({
      dataUrl: sheet.toDataURL('image/png'),
      columns,
      rows,
      count: slice.length,
    });
  }

  return sheets;
}

/** Render the shared card back at the same tile size as the faces. */
export async function buildBack(backOptions, scale = 1) {
  const canvas = await renderToCanvas(null, scale, { back: backOptions, squareCorners: true });
  return canvas.toDataURL('image/png');
}
