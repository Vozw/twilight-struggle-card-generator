/*
 * Card schema and defaults.
 *
 * Game-relevant fields sit at the top level; everything to do with how the card
 * *looks* is quarantined under `presentation` (plus `art`). A rules engine can
 * read these files and ignore the presentation block entirely -- that data
 * boundary is the intended integration point, rather than shared code.
 */

export const SCHEMA_VERSION = 1;

/** Card face geometry, carried over from the original generator. */
export const GEOMETRY = {
  width: 375,
  height: 525,
  cornerRadius: 27,
  background: '#E3F5FF',
  ink: '#211D1E',
  accent: '#DE1C37',

  numberBaseline: 47,
  // Bar and banner text measured off the reference scans, which agree exactly
  // across cards: bar spans x 37..337 and y 52..80, and the era text has an
  // 18px cap height centred at x=223.
  bannerTop: 32,
  bannerHeight: 67,
  bannerInset: 37,
  barHeight: 29,
  bannerTextSize: 25.5,
  bannerTextSpacing: 0,

  // Measured off the 375x525 reference scans: the star is centred on the era
  // bar and overlaps both it and the top of the artwork.
  starCentreX: 66,
  starCentreY: 66,
  starRadius: 33,

  imageTop: 90,
  imageMaxWidth: 298,
  imageMaxHeight: 150,

  titleGap: 40,
  titleSize: 28,
  titleLineHeight: 30,

  textMaxWidth: 305,
  textTopPadding: 10,

  footerBaseline: 488,
  footerSize: 19,

  // Scoring cards use a different layout entirely: a bordered panel of banded
  // rows instead of artwork and flowing text. Measured off middle-east-scoring.
  scoringPanelTop: 121,
  scoringPanelLeft: 37,
  scoringPanelWidth: 300,
  // Reference rows measure a consistent 32px per line of text: single-line
  // rows are 32 tall, two-line rows 64.
  scoringRowLineHeight: 32,
  scoringTitleSize: 30,
  scoringRowSize: 17,
  scoringHeldBarTop: 462,
  scoringHeldBarHeight: 25,
};

/** Shared parts of the scoring-card panel. */
export const SCORING = {
  band: '#C7EAFD',
  alt: '#FFFFFF',
  border: '#50525F',
  heldBar: '#ED1B34',
  heldText: '#FFF261',
  heldLabel: 'MAY NOT BE HELD',
};

/**
 * Each scoring card is tinted to match its region on the map, so there is no
 * single scoring palette. Sampled from the reference scans.
 *
 * `header` tints the title band, `band` the alternating rows. Four regions use
 * a darker header over lighter rows; the other three use one colour for both.
 */
export const SCORING_REGIONS = {
  asia: { header: '#F4AD43', band: '#FACE8D' },
  europe: { header: '#A796CA', band: '#C7C8E4' },
  'middle east': { header: '#C7EAFD', band: '#C7EAFD' },
  'central america': { header: '#D9E2A3', band: '#D9E2A3' },
  'southeast asia': { header: '#F2A41C', band: '#FFD503' },
  africa: { header: '#FFEC95', band: '#FFEC95' },
  'south america': { header: '#A0C987', band: '#CCE0BD' },
};

/** Look a region's palette up leniently, falling back to the neutral blue. */
export function scoringPalette(region) {
  const key = String(region || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return SCORING_REGIONS[key] || { header: SCORING.band, band: SCORING.band };
}

/** Era presets. Colours sampled from the original banner artwork. */
export const ERAS = {
  early: { label: 'Early War', bar: '#01ABCC' },
  mid: { label: 'Mid War', bar: '#0088AA' },
  late: { label: 'Late War', bar: '#282F42' },
};

/**
 * Association presets, sampled from the reference cards.
 *
 * Neutral is not a single colour: its star is split white and red along a line
 * tilted off vertical, and carries no outline at all -- only a drop shadow.
 */
export const ASSOCIATIONS = {
  ussr: {
    label: 'USSR',
    starFill: '#D0232B',
    starOutline: '#FFD109',
    // Calibrated against the reference: measured radially at ten angles, the
    // printed outline runs a 3px median. Because the fill is inset by radius
    // rather than by perpendicular distance, a stroke width of 2 is what
    // reproduces that 3px band.
    starOutlineWidth: 2,
    ops: '#FFFFFF',
  },
  usa: {
    label: 'USA',
    starFill: '#FFFFFF',
    starOutline: '#0D79C4',
    starOutlineWidth: 2,
    ops: '#211D1E',
  },
  neutral: {
    label: 'Neutral',
    starFill: '#FFFFFF',
    starFillRight: '#E8433C',
    // The neutral star carries no outline at all -- only a drop shadow. A dark
    // band appears outside its edge going downward and nowhere else, which is
    // a shadow, not a stroke.
    starOutlineWidth: 0,
    // Measured smaller and lower than the superpower stars: apex at y=36
    // rather than y=32, and about 62px across rather than 67-71.
    starScale: 0.93,
    starOffsetY: 3,
    ops: '#211D1E',
  },
};

/**
 * The red/white split on a neutral star is not vertical: measured at 36 degrees
 * off vertical on two independent cards, identically. That is half of a
 * five-pointed star's 72-degree spacing, so the dividing line runs from the
 * lower-left point through the centre to the upper-right inner notch.
 */
export const STAR_SPLIT_ANGLE = 36;

export const DEFAULT_FOOTER = 'Remove from play if used as an event.';

/**
 * Selectable text faces.
 *
 * Libre Caslon is bundled, so it renders identically everywhere. Georgia is a
 * system font shipped with Windows and macOS -- heavier, with a larger
 * x-height, so it reads more strongly at card size at the cost of being a less
 * literal match for the printed cards' Adobe Caslon.
 */
export const FONTS = {
  caslon: { label: 'Libre Caslon (bundled)', family: 'TSCaslon' },
  georgia: { label: 'Georgia (system)', family: 'Georgia' },
};

export const DEFAULT_FONT = 'caslon';

export function blankCard() {
  return {
    schema: SCHEMA_VERSION,
    id: '',
    number: null,
    ops: 2,
    era: 'early',
    association: 'neutral',
    title: '',
    text: '',
    removedOnEvent: false,
    optional: false,
    permanent: false,
    scoring: false,
    scoringRegion: '',
    mayNotBeHeld: false,
    art: null,
    presentation: {},
  };
}

/** Fill in anything missing so the renderer never has to null-check. */
export function normalise(card) {
  const base = blankCard();
  const merged = { ...base, ...(card || {}) };
  merged.presentation = { ...(card?.presentation || {}) };
  merged.art = card?.art ? { mode: 'photo', src: '', ...card.art } : null;
  if (!ERAS[merged.era]) merged.era = 'early';
  if (!ASSOCIATIONS[merged.association]) merged.association = 'neutral';
  merged.ops = Number(merged.ops) || 0;
  merged.number = merged.number === '' || merged.number == null ? null : Number(merged.number);
  if (!merged.id) merged.id = slugify(merged.title);
  return merged;
}

/** Resolve presentation overrides against the era/association presets. */
export function resolveStyle(card) {
  const era = ERAS[card.era];
  const association = ASSOCIATIONS[card.association];
  const p = card.presentation || {};
  const region = scoringPalette(card.scoringRegion);
  return {
    scoringHeader: p.scoringHeader || region.header,
    scoringBand: p.scoringBand || region.band,
    scoringAlt: p.scoringAlt || SCORING.alt,
    scoringRemovalText: p.scoringRemovalText ?? 'Remove from play after scoring.',
    bannerText: p.bannerText ?? era.label.toUpperCase(),
    barColor: p.barColor || era.bar,
    starFill: p.starFill || association.starFill,
    // `null` means a solid star; a colour makes it a two-tone split.
    starFillRight: p.starFillRight ?? association.starFillRight ?? null,
    starOutline: p.starOutline || association.starOutline,
    starOutlineWidth: p.starOutlineWidth ?? association.starOutlineWidth ?? 2,
    starScale: p.starScale ?? association.starScale ?? 1,
    starOffsetY: p.starOffsetY ?? association.starOffsetY ?? 0,
    starSplitAngle: p.starSplitAngle ?? STAR_SPLIT_ANGLE,
    barKeyline: p.barKeyline || '#1E4157',
    opsColor: p.opsColor || association.ops,
    cardColor: p.cardColor || GEOMETRY.background,
    inkColor: p.inkColor || GEOMETRY.ink,
    accentColor: p.accentColor || GEOMETRY.accent,
    footerText: p.footerText ?? DEFAULT_FOOTER,
    font: p.font || DEFAULT_FONT,
    fontFamily: (FONTS[p.font] || FONTS[DEFAULT_FONT]).family,
    fontSize: p.fontSize ?? 'auto',
    titleSize: p.titleSize ?? GEOMETRY.titleSize,
    bannerTextSize: p.bannerTextSize ?? GEOMETRY.bannerTextSize,
    bannerTextSpacing: p.bannerTextSpacing ?? GEOMETRY.bannerTextSpacing,
    bannerTextColor: p.bannerTextColor || '#FFFFFF',
    barHeight: p.barHeight ?? GEOMETRY.barHeight,
    showStar: p.showStar !== false,
    showBanner: p.showBanner !== false,
  };
}

export function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Filename used when a card is saved to the library or exported as a PNG.
 *
 * Must agree with the server's sanitiser, or the manifest would name files that
 * are not what actually lands on disk. Slashes become dashes rather than being
 * dropped, and the stem is capped so the extension always survives.
 */
export function cardFilename(card, extension = '.json') {
  const prefix = card.number != null && card.number !== '' ? `${String(card.number).padStart(3, '0')} - ` : '';
  const title = (card.title || 'Untitled')
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${(prefix + title).slice(0, 120).trim()}${extension}`;
}
