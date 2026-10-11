import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalise, cardFilename } from '../public/js/cardmodel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = path.join(here, '..', 'library');
const EXAMPLES = path.join(LIBRARY, 'examples');

const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).sort();
const loaded = files.map((file) => ({
  file,
  raw: JSON.parse(fs.readFileSync(path.join(EXAMPLES, file), 'utf8')),
}));

// The examples are the only library content that is committed, so they are
// worth keeping honest: every one must load, render-ready, with its art on disk.
describe('library/examples', () => {
  it('contains example cards', () => {
    assert.ok(files.length >= 1);
  });

  for (const { file, raw } of loaded) {
    describe(file, () => {
      it('normalises cleanly and has a title and text', () => {
        const card = normalise(raw);
        assert.ok(card.title.length > 0);
        assert.ok(card.text.length > 0);
      });

      it('is named the way the app would name it', () => {
        assert.equal(file, cardFilename(raw));
      });

      it('points at artwork that exists on disk', () => {
        if (!raw.art) return;
        assert.ok(
          fs.existsSync(path.join(LIBRARY, raw.art.src)),
          `missing art file: ${raw.art.src}`
        );
      });
    });
  }

  it('uses each card number once', () => {
    const numbers = loaded.map(({ raw }) => raw.number);
    assert.equal(new Set(numbers).size, numbers.length);
  });

  it('formats scoring examples as a "...:" header line followed by rows', () => {
    for (const { raw } of loaded.filter(({ raw }) => raw.scoring)) {
      const lines = raw.text.split('\n');
      assert.ok(lines.length > 1);
      assert.match(lines[0], /:$/);
    }
  });
});
