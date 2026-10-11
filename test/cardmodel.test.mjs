import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  blankCard,
  normalise,
  resolveStyle,
  scoringPalette,
  cardFilename,
  slugify,
  SCORING,
  STAR_SPLIT_ANGLE,
} from '../public/js/cardmodel.js';
import { parseMarkup, stripMarkup } from '../public/js/text.js';

const style = (card) => resolveStyle(normalise(card));

describe('normalise', () => {
  it('fills in everything a bare card is missing', () => {
    const card = normalise({ title: 'Some Title' });
    assert.equal(card.era, 'early');
    assert.equal(card.association, 'neutral');
    assert.equal(card.id, 'some-title');
    assert.equal(card.number, null);
    assert.equal(card.art, null);
    assert.deepEqual(card.presentation, {});
  });

  it('coerces ops and number, and treats an empty number as unset', () => {
    assert.equal(normalise({ ops: '3' }).ops, 3);
    assert.equal(normalise({ ops: 'banana' }).ops, 0);
    assert.equal(normalise({ number: '' }).number, null);
    assert.equal(normalise({ number: '21' }).number, 21);
  });

  it('falls back on unknown eras and associations rather than throwing', () => {
    const card = normalise({ era: 'bronze-age', association: 'martians' });
    assert.equal(card.era, 'early');
    assert.equal(card.association, 'neutral');
  });

  it('does not mutate its input', () => {
    const input = { title: 'X', presentation: { font: 'georgia' } };
    normalise(input);
    assert.deepEqual(input, { title: 'X', presentation: { font: 'georgia' } });
  });

  it('blankCard is a valid starting point', () => {
    assert.doesNotThrow(() => normalise(blankCard()));
  });
});

describe('resolveStyle: stars', () => {
  it('gives the superpowers a thin outline and a solid fill', () => {
    for (const association of ['ussr', 'usa']) {
      const s = style({ association });
      assert.equal(s.starOutlineWidth, 2);
      assert.equal(s.starFillRight, null);
      assert.equal(s.starScale, 1);
    }
  });

  it('gives the neutral star no outline, a two-tone fill and the measured 36 degree split', () => {
    const s = style({ association: 'neutral' });
    assert.equal(s.starOutlineWidth, 0);
    assert.ok(s.starFillRight, 'has a second colour');
    assert.equal(s.starSplitAngle, 36);
    assert.equal(STAR_SPLIT_ANGLE, 36);
    assert.ok(s.starScale < 1, 'drawn slightly smaller than the superpower stars');
    assert.ok(s.starOffsetY > 0, 'and slightly lower');
  });

  it('lets presentation overrides win over the association preset', () => {
    const s = style({ association: 'usa', presentation: { starOutlineWidth: 5, starFill: '#123456' } });
    assert.equal(s.starOutlineWidth, 5);
    assert.equal(s.starFill, '#123456');
  });
});

describe('resolveStyle: banner and fonts', () => {
  it('derives banner text and bar colour from the era', () => {
    assert.equal(style({ era: 'mid' }).bannerText, 'MID WAR');
    assert.equal(style({ era: 'mid' }).barColor, '#0088AA');
    assert.notEqual(style({ era: 'late' }).barColor, style({ era: 'early' }).barColor);
  });

  it('lets a card rename the banner', () => {
    assert.equal(style({ presentation: { bannerText: 'COLD OPEN' } }).bannerText, 'COLD OPEN');
  });

  it('maps the font choice to a CSS family and falls back safely', () => {
    assert.equal(style({ presentation: { font: 'georgia' } }).fontFamily, 'Georgia');
    assert.equal(style({}).fontFamily, 'TSCaslon');
    assert.equal(style({ presentation: { font: 'no-such-font' } }).fontFamily, 'TSCaslon');
  });
});

describe('scoring palettes', () => {
  it('looks a region up regardless of case and spacing', () => {
    assert.deepEqual(scoringPalette('Asia'), { header: '#F4AD43', band: '#FACE8D' });
    assert.deepEqual(scoringPalette('  middle   EAST '), scoringPalette('Middle East'));
  });

  it('falls back to the plain blue for a region it does not know', () => {
    assert.deepEqual(scoringPalette('Atlantis'), { header: SCORING.band, band: SCORING.band });
    assert.deepEqual(scoringPalette(''), { header: SCORING.band, band: SCORING.band });
  });

  it('flows the region into the resolved style, with overrides still winning', () => {
    assert.equal(style({ scoring: true, scoringRegion: 'Europe' }).scoringHeader, '#A796CA');
    assert.equal(
      style({ scoring: true, scoringRegion: 'Europe', presentation: { scoringHeader: '#000000' } })
        .scoringHeader,
      '#000000'
    );
  });
});

describe('cardFilename', () => {
  it('zero-pads the number and appends the extension', () => {
    assert.equal(cardFilename({ number: 5, title: 'Deep Cover' }), '005 - Deep Cover.json');
    assert.equal(cardFilename({ number: 5, title: 'Deep Cover' }, '.png'), '005 - Deep Cover.png');
  });

  it('omits the prefix for an unnumbered card', () => {
    assert.equal(cardFilename({ title: 'Loose Card' }), 'Loose Card.json');
  });

  it('turns slashes into dashes and drops other illegal characters', () => {
    assert.equal(cardFilename({ number: 27, title: 'US/Japan Pact?' }), '027 - US-Japan Pact.json');
  });

  it('caps very long titles without losing the extension', () => {
    const name = cardFilename({ number: 96, title: 'word '.repeat(80) }, '.png');
    assert.ok(name.endsWith('.png'));
    assert.ok(name.length <= 120 + '.png'.length);
  });
});

describe('slugify', () => {
  it('lowercases, drops apostrophes and hyphenates the rest', () => {
    assert.equal(slugify("Charlie's  Big Idea!"), 'charlies-big-idea');
  });
});

describe('inline markup', () => {
  it('parses italic, bold and bold-italic runs', () => {
    const runs = parseMarkup('a *b* **c** ***d***');
    assert.deepEqual(
      runs.map((r) => [r.text, r.bold, r.italic]),
      [
        ['a ', false, false],
        ['b', false, true],
        [' ', false, false],
        ['c', true, false],
        [' ', false, false],
        ['d', true, true],
      ]
    );
  });

  it('renders an escaped asterisk literally, as used for the title star', () => {
    assert.deepEqual(parseMarkup('NATO\\*'), [{ text: 'NATO*', bold: false, italic: false }]);
  });

  it('lets an unclosed marker run to the end of the text', () => {
    assert.deepEqual(parseMarkup('*abc'), [{ text: 'abc', bold: false, italic: true }]);
  });

  it('returns one empty run for empty input so callers never null-check', () => {
    assert.deepEqual(parseMarkup(''), [{ text: '', bold: false, italic: false }]);
  });

  it('strips markup for filenames and list labels', () => {
    assert.equal(stripMarkup('*Play after* **X**'), 'Play after X');
    assert.equal(stripMarkup(null), '');
  });
});
