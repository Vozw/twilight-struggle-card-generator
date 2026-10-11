const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseLua,
  parseOverlay,
  isPermanentEvent,
  formatEventText,
  looksLikeNote,
  luaString,
  safeName,
  MAX_TITLE_LENGTH,
} = require('../tools/import.js');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'synthetic_cards.lua'), 'utf8');
const cards = parseLua(FIXTURE);
const byName = (name) => cards.find((c) => c.luaName === name);

describe('parseLua', () => {
  it('reads every card block and sorts by card number', () => {
    assert.equal(cards.length, 9);
    assert.deepEqual(
      cards.map((c) => c.number),
      [1, 2, 3, 4, 5, 6, 7, 8, 9]
    );
  });

  it('maps stage, owner and ops onto era, association and ops', () => {
    const plain = byName('Plain Event');
    assert.equal(plain.era, 'early');
    assert.equal(plain.association, 'ussr');
    assert.equal(plain.ops, 2);
    assert.equal(byName('Permanent Event').era, 'mid');
    assert.equal(byName('Permanent Event').association, 'usa');
    assert.equal(byName('Conditional Permanent').era, 'late');
  });

  it('reads the removed-on-event and optional flags', () => {
    assert.equal(byName('Plain Event').removedOnEvent, true);
    assert.equal(byName('Turn Long Event').removedOnEvent, false);
    assert.equal(byName('Optional Neutral').optional, true);
    assert.equal(byName('Plain Event').optional, false);
    assert.equal(byName('Optional Neutral').association, 'neutral');
  });

  it('treats scoring cards as ops-free and keeps their region', () => {
    const scoring = byName('Test Region Scoring');
    assert.equal(scoring.scoring, true);
    assert.equal(scoring.ops, 0);
    assert.equal(scoring.scoringRegion, 'Asia');
    assert.equal(scoring.mayNotBeHeld, true);
    assert.equal(byName('Plain Event').scoring, false);
    assert.equal(byName('Plain Event').scoringRegion, '');
  });

  it('joins Lua string concatenation and unescapes it', () => {
    const text = byName('Permanent Event').text;
    assert.match(text, /Something lasts forever\.$/);
    assert.ok(text.includes('"Plain Event"'), 'escaped quotes survive');
  });
});

describe('red underline: permanence, not merely "has a lasting effect"', () => {
  it('underlines PutThisCardInPlay with argument 0', () => {
    assert.equal(byName('Permanent Event').permanent, true);
  });

  it('does not underline PutThisCardInPlay with argument 1 (lasts the turn)', () => {
    assert.equal(byName('Turn Long Event').permanent, false);
  });

  it('tolerates a trailing condition inside the braces (regression)', () => {
    assert.equal(byName('Conditional Permanent').permanent, true);
  });

  it('underlines the Special variant, which stays in play until cancelled', () => {
    assert.equal(byName('Special Event').permanent, true);
  });

  it('matches the exact opcode, so the region-choice variant is not caught', () => {
    assert.equal(byName('Region Choice Event').permanent, false);
  });

  it('adds Quagmire and Bear Trap by name', () => {
    assert.equal(byName('Quagmire').permanent, true);
    assert.equal(isPermanentEvent('Bear Trap', ''), true);
  });

  it('leaves an ordinary event alone', () => {
    assert.equal(byName('Plain Event').permanent, false);
    assert.equal(isPermanentEvent('Anything', ''), false);
  });

  it('applies overrides by name or number, with the no-underline list winning', () => {
    const overrides = {
      underline: new Set(['plain event', '2']),
      noUnderline: new Set(['permanent event']),
    };
    const out = parseLua(FIXTURE, overrides);
    const get = (n) => out.find((c) => c.luaName === n);
    assert.equal(get('Plain Event').permanent, true, 'forced on by name');
    assert.equal(get('Turn Long Event').permanent, true, 'forced on by number');
    assert.equal(get('Permanent Event').permanent, false, 'forced off');
  });
});

describe('formatEventText', () => {
  it('sets a leading "Play after..." clause in italics on its own paragraph', () => {
    assert.equal(
      formatEventText('Play after "Foo". Do the thing.'),
      '*Play after "Foo".*\n\nDo the thing.'
    );
  });

  it('leaves text without such a clause exactly as written', () => {
    assert.equal(formatEventText('Gain 1 VP.'), 'Gain 1 VP.');
  });

  it('handles a preamble that is the whole text', () => {
    assert.equal(formatEventText('Unplayable as an event.'), '*Unplayable as an event.*');
  });
});

describe('luaString', () => {
  it('concatenates ".." pieces and unescapes newlines and quotes', () => {
    const body = 'event_text = "line one\\n" ..\n\t"say \\"hi\\"";';
    assert.equal(luaString(body, 'event_text'), 'line one\nsay "hi"');
  });

  it('returns an empty string when the key is absent', () => {
    assert.equal(luaString('card_name = "X";', 'event_text'), '');
  });
});

describe('looksLikeNote: length is the only test', () => {
  it('accepts a title at the limit', () => {
    assert.equal(looksLikeNote('x'.repeat(MAX_TITLE_LENGTH)), false);
  });

  it('rejects anything longer, as a planning note rather than a title', () => {
    assert.equal(looksLikeNote('x'.repeat(MAX_TITLE_LENGTH + 1)), true);
  });

  it('does not reject legitimate short titles that look like questions or hedges', () => {
    assert.equal(looksLikeNote('Who Goes There?'), false);
    assert.equal(looksLikeNote('Maybe Tomorrow'), false);
  });

  it('copes with empty input', () => {
    assert.equal(looksLikeNote(''), false);
    assert.equal(looksLikeNote(undefined), false);
  });
});

describe('parseOverlay', () => {
  const rows = [
    ['#', 'name', 'text', 'name', 'text', 'image'],
    [1, 'Vanilla A', 'old a', 'Reskin A', 'new a', 'a.png'],
    [2, 'Vanilla B', 'old b', '', '', ''],
    ['n/a', 'Vanilla C', 'old c', 'Ignored', 'ignored', ''],
    [4, 'Vanilla D', 'old d', 'Reskin D', '', ''],
  ];
  const overlay = parseOverlay(rows);

  it('uses the second name/text columns, after the vanilla reference columns', () => {
    assert.deepEqual(overlay.get(1), { title: 'Reskin A', text: 'new a', image: 'a.png' });
  });

  it('skips rows that carry no reskin and rows without a numeric id', () => {
    assert.equal(overlay.has(2), false);
    assert.equal(overlay.size, 2);
  });

  it('keeps partial reskins', () => {
    assert.deepEqual(overlay.get(4), { title: 'Reskin D', text: '', image: '' });
  });
});

describe('safeName', () => {
  it('turns slashes into dashes instead of deleting them', () => {
    assert.equal(safeName('US/Japan Pact'), 'US-Japan Pact');
    assert.equal(safeName('A\\B'), 'A-B');
  });

  it('strips characters that are illegal in filenames and collapses whitespace', () => {
    assert.equal(safeName('What?  "Now"*'), 'What Now');
  });
});
