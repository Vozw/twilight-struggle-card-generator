# Twilight Struggle Card Generator

Local, zero-dependency Node tool for designing custom Twilight Struggle cards.
`README.md` covers usage; this file is the context a new session would otherwise
have to rediscover. Run `npm test` (`node --test`) before finishing any change.

## Never commit third-party content

This repo is public. These must stay out of it, and `.gitignore` is the backstop,
not the plan:

- **`library/` except `library/examples/`**: imported cards carry GMT's verbatim
  card text, and stored art is other people's work.
- **`output/`**: rendered cards, derived from the above.
- **GMT data**: `twilight_cards.lua`, `twilight_map.lua`, the rulebook PDF, card
  scans, the Steam client or VASSAL files. They live in the workspace *beside*
  this repo (`../artiDataFiles`, `../reference`), never inside it.
- **Test fixtures must be invented.** `test/fixtures/synthetic_cards.lua` mirrors
  the *shape* of the real table with made-up cards. Do not paste real card data
  into tests, examples, README snippets or code comments.

Before the first commit of any session that touched files, run
`git add --dry-run .` and read the list.

## Architecture in one paragraph

`server.js` is a loopback-only (`127.0.0.1`) file server plus a small JSON API
for the library, image storage and exports. All rendering happens in the browser
canvas (`public/js/render.js`), which is the single rendering path: live preview,
PNG export and the Tabletop Simulator atlas are pixel-identical. Cards are
individual JSON files; game-relevant fields sit at the top level and everything
visual is under `art` / `presentation`, so a rules engine can read the files and
ignore the rest. That data boundary is the integration point, not shared code.

## Decisions worth not relitigating

- **The red underline means permanence** (rulebook 7.3 / 2.2.5), derived from the
  argument to `PutThisCardInPlay` (0 = indefinite, 1 = this turn), plus
  `PutThisCardInPlaySpecial`, plus Quagmire and Bear Trap by name. Verified
  12/12 against measured scans. The regex must tolerate a trailing
  `condition={...}` inside the braces (The Reformer). Overrides live in
  `tools/underline-overrides.json`.
- **Geometry is measured, not eyeballed.** Bar, banner text, star size, outline
  width, the neutral star's 36 degree split and the scoring panel were all
  measured off reference scans with pixel probes. When calibrating, run the
  *same* probe against this tool's own render: a visual estimate off an 8x zoom
  was wrong once. Stroke width and measured band width differ (a 2px stroke gives
  a 3px band) because the fill is inset by radius, not perpendicular distance.
- **Scoring cards are tinted per region** (`scoringRegion` -> `SCORING_REGIONS`),
  with 32px per line of row text.
- **Filename sanitising must agree in three places**: `cardFilename` in
  `public/js/cardmodel.js`, `sanitiseName` in `server.js`, and `safeName` in
  `tools/import.js`. Slashes become dashes; the stem is capped so the extension
  survives. Two bugs came from these drifting apart.
- **Importer scope**: it reads only what is needed to *draw* a card. Effect
  opcodes are deliberately ignored; they belong to a rules engine.

## Gotchas

- `tools/import.js`'s card pattern is not Lua-aware: it matches the literal text
  of a table assignment anywhere, including inside comments. Keep comments in
  Lua fixtures free of that syntax.
- `public/package.json` sets `"type": "module"` so tests can import the browser
  modules in Node. The root `package.json` is CommonJS because `server.js` and
  `tools/*.js` are.
- On Windows, a path over 260 characters silently defeats ordinary deletes.
  Titles are capped so generated filenames stay short, but if a delete "succeeds"
  and the file remains, that is why.
- Use the Edit/Write tools rather than round-tripping text through Windows
  PowerShell 5.1, which mangles UTF-8.
