/*
 * Application wiring: form state, live preview, image intake, library I/O,
 * PNG export, spreadsheet import and TTS deck assembly.
 */

import { api } from './api.js';
import { LibraryTree } from './library.js';
import {
  blankCard,
  normalise,
  resolveStyle,
  cardFilename,
  slugify,
  GEOMETRY,
  ERAS,
  ASSOCIATIONS,
  DEFAULT_FOOTER,
  DEFAULT_FONT,
} from './cardmodel.js';
import { drawCardFace, renderToCanvas, forgetImage } from './render.js';
import { renderMiniToCanvas } from './mini.js';
import { stripMarkup, ensureFontsLoaded } from './text.js';
import { buildAtlases, buildBack } from './tts.js';

const $ = (id) => document.getElementById(id);

const PREVIEW_SCALE = 2; // draw at 2x, display at 1x, so the preview is crisp

const state = {
  card: blankCard(),
  path: null, // library path of the card currently open, if any
  config: {},
  dirty: false,
};

// -------------------------------------------------------------- status line

let statusTimer = null;
function setStatus(message, kind = '') {
  const el = $('status');
  el.textContent = message;
  el.className = `status ${kind}`;
  clearTimeout(statusTimer);
  if (message) statusTimer = setTimeout(() => (el.textContent = ''), 4000);
}

// ------------------------------------------------------------- form binding

/** Inputs whose value maps straight onto a top-level card field. */
const FIELD_INPUTS = {
  number: 'number',
  ops: 'number',
  era: 'string',
  association: 'string',
  title: 'string',
  text: 'string',
  removedOnEvent: 'bool',
  permanent: 'bool',
  optional: 'bool',
  scoring: 'bool',
  mayNotBeHeld: 'bool',
};

/** Inputs that live under presentation, with the preset they fall back to. */
const STYLE_INPUTS = ['bannerText', 'barColor', 'starFill', 'starOutline', 'opsColor', 'cardColor', 'accentColor', 'footerText', 'titleSize', 'fontSize', 'font', 'barHeight', 'bannerTextSize'];

/** Style inputs that hold a number rather than a colour or free text. */
const NUMERIC_STYLE_INPUTS = { titleSize: GEOMETRY.titleSize, barHeight: GEOMETRY.barHeight, bannerTextSize: GEOMETRY.bannerTextSize };

/**
 * Style controls the user has actually edited on this card.
 *
 * Without this, every colour picker would be read back as a deliberate
 * override -- so switching association would freeze the star at the *previous*
 * association's colour instead of following the new preset. Only touched
 * controls are written to `presentation`; everything else stays derived.
 */
const touchedStyles = new Set();

/** Read the form into state.card. */
function readForm() {
  const card = { ...state.card };

  for (const [id, kind] of Object.entries(FIELD_INPUTS)) {
    const el = $(id);
    if (kind === 'bool') card[id] = el.checked;
    else if (kind === 'number') card[id] = el.value === '' ? null : Number(el.value);
    else card[id] = el.value;
  }

  const artMode = document.querySelector('input[name="artMode"]:checked')?.value || 'photo';
  if (card.art?.src) card.art = { ...card.art, mode: artMode };

  // Rebuild presentation from the controls the user has actually touched, then
  // drop anything that merely restates the era/association preset.
  const presets = defaultsFor(card.era, card.association);
  const presentation = {};

  for (const key of STYLE_INPUTS) {
    const el = $(key);
    if (!el || !touchedStyles.has(key)) continue;
    const value = el.value;
    if (key === 'fontSize') {
      presentation.fontSize = value === 'auto' ? 'auto' : Number(value);
      continue;
    }
    if (key === 'font') {
      if (value && value !== DEFAULT_FONT) presentation.font = value;
      continue;
    }
    if (key in NUMERIC_STYLE_INPUTS) {
      if (value !== '' && Number(value) !== NUMERIC_STYLE_INPUTS[key]) presentation[key] = Number(value);
      continue;
    }
    if (value !== '' && value.toLowerCase() !== String(presets[key]).toLowerCase()) {
      presentation[key] = value;
    }
  }

  // Only recorded when switched off, since showing them is the default.
  if (!$('showBanner').checked) presentation.showBanner = false;
  if (!$('showStar').checked) presentation.showStar = false;
  card.presentation = presentation;

  if (!card.id) card.id = slugify(card.title);
  state.card = normalise(card);
  return state.card;
}

/** Preset values for a given era/association, used to seed the colour pickers. */
function defaultsFor(era, association) {
  const e = ERAS[era] || ERAS.early;
  const a = ASSOCIATIONS[association] || ASSOCIATIONS.neutral;
  return {
    bannerText: e.label.toUpperCase(),
    barColor: e.bar,
    starFill: a.starFill,
    starOutline: a.starOutline,
    opsColor: a.ops,
    cardColor: GEOMETRY.background,
    accentColor: GEOMETRY.accent,
    footerText: DEFAULT_FOOTER,
  };
}

/** Push state.card out to the form. */
function writeForm() {
  const card = state.card;

  for (const [id, kind] of Object.entries(FIELD_INPUTS)) {
    const el = $(id);
    if (kind === 'bool') el.checked = Boolean(card[id]);
    else el.value = card[id] ?? '';
  }

  const mode = card.art?.mode || 'photo';
  const radio = document.querySelector(`input[name="artMode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  // A card loaded from disk carries its overrides forward; anything it does not
  // specify stays derived from the era/association presets.
  touchedStyles.clear();
  for (const key of Object.keys(card.presentation || {})) {
    if (STYLE_INPUTS.includes(key)) touchedStyles.add(key);
  }

  syncStyleInputs();
  updateArtStatus();
  autoGrow($('text'));

  $('currentPath').textContent = state.path ? `library/${state.path}` : 'Unsaved card';
}

/**
 * Colour pickers always show a concrete value, so they display the preset when
 * no override is set. `placeholder` carries the preset for the text inputs.
 */
function syncStyleInputs() {
  const card = state.card;
  const presets = defaultsFor(card.era, card.association);
  const p = card.presentation || {};

  $('bannerText').value = p.bannerText ?? '';
  $('bannerText').placeholder = presets.bannerText;
  $('footerText').value = p.footerText ?? '';
  $('footerText').placeholder = presets.footerText;

  for (const key of ['barColor', 'starFill', 'starOutline', 'opsColor', 'cardColor', 'accentColor']) {
    $(key).value = p[key] || presets[key];
  }

  for (const [key, fallback] of Object.entries(NUMERIC_STYLE_INPUTS)) {
    $(key).value = p[key] ?? '';
    $(key).placeholder = String(fallback);
  }
  $('font').value = p.font || DEFAULT_FONT;
  $('fontSize').value = p.fontSize == null ? 'auto' : String(p.fontSize);
  $('showBanner').checked = p.showBanner !== false;
  $('showStar').checked = p.showStar !== false;
}

function updateArtStatus() {
  const src = state.card.art?.src;
  $('artStatus').textContent = src ? `Using ${src}` : 'No image set.';
}

/** Grow the effect textarea to fit its content, so long text stays visible. */
function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.max(120, textarea.scrollHeight + 2)}px`;
}

// -------------------------------------------------------------- live render

let renderQueued = false;
let renderRunning = false;

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(async () => {
    renderQueued = false;
    if (renderRunning) {
      scheduleRender();
      return;
    }
    renderRunning = true;
    try {
      const canvas = $('cardCanvas');
      const ctx = canvas.getContext('2d');
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(PREVIEW_SCALE, PREVIEW_SCALE);
      await drawCardFace(ctx, state.card);
    } catch (err) {
      console.error(err);
      setStatus(`Render failed: ${err.message}`, 'err');
    } finally {
      renderRunning = false;
    }
  });
}

function onFormChange() {
  readForm();
  syncStyleInputs();
  state.dirty = true;
  scheduleRender();
}

// ------------------------------------------------------------ image intake

async function adoptImageBlob(blob, name) {
  try {
    setStatus('Storing image…');
    const stored = await api.imageFromBlob(blob, name);
    forgetImage(stored.path);
    state.card.art = { src: stored.path, mode: currentArtMode() };
    state.dirty = true;
    updateArtStatus();
    scheduleRender();
    setStatus(`Image stored as ${stored.path}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

function currentArtMode() {
  return document.querySelector('input[name="artMode"]:checked')?.value || 'photo';
}

async function adoptImageUrl(url) {
  try {
    setStatus('Fetching image…');
    const stored = await api.imageFromUrl(url);
    forgetImage(stored.path);
    state.card.art = { src: stored.path, mode: currentArtMode() };
    state.dirty = true;
    updateArtStatus();
    scheduleRender();
    setStatus(`Fetched ${Math.round(stored.bytes / 1024)} KB`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

function wireImageIntake() {
  $('artFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) adoptImageBlob(file, file.name);
  });

  $('fetchArtBtn').addEventListener('click', () => {
    const url = $('artUrl').value.trim();
    if (url) adoptImageUrl(url);
  });

  $('artUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('fetchArtBtn').click();
    }
  });

  $('clearArtBtn').addEventListener('click', () => {
    state.card.art = null;
    $('artFile').value = '';
    $('artUrl').value = '';
    state.dirty = true;
    updateArtStatus();
    scheduleRender();
  });

  // Paste anywhere except inside a text field.
  document.addEventListener('paste', async (e) => {
    const target = e.target;
    const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) await adoptImageBlob(blob, 'pasted');
        return;
      }
    }

    // A pasted image URL is only treated as art when not typing into a field.
    if (!typing) {
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (text && /^https?:\/\/\S+$/i.test(text)) {
        e.preventDefault();
        await adoptImageUrl(text);
      }
    }
  });

  // Drag and drop onto the preview.
  const wrap = $('canvasWrap');
  let dragDepth = 0;

  wrap.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    wrap.classList.add('dragging');
  });
  wrap.addEventListener('dragover', (e) => e.preventDefault());
  wrap.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      wrap.classList.remove('dragging');
    }
  });
  wrap.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    wrap.classList.remove('dragging');

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) return adoptImageBlob(file, file.name);

    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (url && /^https?:\/\//i.test(url.trim())) return adoptImageUrl(url.trim());
  });
}

// ------------------------------------------------------------ markup helpers

/** Wrap the current selection in a markup marker, or unwrap it if already wrapped. */
function toggleWrap(textarea, marker) {
  const { selectionStart: start, selectionEnd: end, value } = textarea;
  const selected = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);

  const alreadyWrapped =
    before.endsWith(marker) && after.startsWith(marker);

  if (alreadyWrapped) {
    textarea.value = before.slice(0, -marker.length) + selected + after.slice(marker.length);
    textarea.setSelectionRange(start - marker.length, end - marker.length);
  } else if (selected) {
    textarea.value = `${before}${marker}${selected}${marker}${after}`;
    textarea.setSelectionRange(start + marker.length, end + marker.length);
  } else {
    textarea.value = `${before}${marker}${marker}${after}`;
    textarea.setSelectionRange(start + marker.length, start + marker.length);
  }
  textarea.focus();
  onFormChange();
}

function wireMarkupTools() {
  const textarea = $('text');

  for (const button of document.querySelectorAll('.markup-bar button[data-wrap]')) {
    button.addEventListener('click', () => toggleWrap(textarea, button.dataset.wrap));
  }

  textarea.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'i') {
      e.preventDefault();
      toggleWrap(textarea, '*');
    } else if (e.key === 'b') {
      e.preventDefault();
      toggleWrap(textarea, '**');
    }
  });

  textarea.addEventListener('input', () => autoGrow(textarea));
}

// ------------------------------------------------------------- library I/O

let tree;

async function openCard(path) {
  if (state.dirty && !window.confirm('Discard unsaved changes to the current card?')) return;
  try {
    const card = await api.readCard(path);
    state.card = normalise(card);
    state.path = path;
    state.dirty = false;
    tree.setActive(path);
    writeForm();
    scheduleRender();
    setStatus(`Opened ${path}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function saveCard(targetPath) {
  readForm();
  if (!state.card.title.trim()) {
    setStatus('Give the card a title before saving.', 'err');
    return;
  }
  const path = targetPath || state.path || cardFilename(state.card);
  try {
    await api.writeCard(path, state.card);
    state.path = path;
    state.dirty = false;
    await tree.refresh();
    tree.setActive(path);
    $('currentPath').textContent = `library/${path}`;
    setStatus(`Saved to library/${path}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

/** Simple modal prompt, since window.prompt is ugly for the common paths. */
function askFor(title, label, value = '') {
  return new Promise((resolve) => {
    const dialog = $('promptDialog');
    $('promptTitle').textContent = title;
    $('promptLabel').textContent = label;
    $('promptInput').value = value;
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'ok' ? $('promptInput').value.trim() : null),
      { once: true }
    );
    dialog.showModal();
    $('promptInput').focus();
    $('promptInput').select();
  });
}

// ----------------------------------------------------------------- exports

/** Which cards a batch action applies to: the ticked ones, or everything. */
function batchPaths() {
  const selected = tree.selectedPaths();
  return selected.length ? selected : tree.allCardPaths();
}

async function exportCurrent() {
  readForm();
  const scale = Number($('exportScale').value);
  try {
    setStatus('Rendering…');
    const canvas = await renderToCanvas(state.card, scale);
    await api.exportPng({
      filename: cardFilename(state.card, '.png'),
      dataUrl: canvas.toDataURL('image/png'),
      subfolder: state.path?.includes('/') ? state.path.slice(0, state.path.lastIndexOf('/')) : '',
    });
    setStatus(`Exported to ${state.config.outputDir || 'output'}`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

async function renderSelected() {
  const paths = batchPaths();
  if (!paths.length) return setStatus('No cards in the library yet.', 'err');

  const withMinis = $('renderMinis').checked;
  const what = withMinis ? 'card + mini-card' : 'card';
  if (!window.confirm(`Render ${paths.length} ${what}${paths.length === 1 ? '' : 's'} to PNG?`)) return;

  const scale = Number($('exportScale').value);
  const files = [];
  const index = [];

  try {
    for (let i = 0; i < paths.length; i++) {
      setStatus(`Rendering ${i + 1} of ${paths.length}…`);
      const card = normalise(await api.readCard(paths[i]));
      const filename = cardFilename(card, '.png');

      const canvas = await renderToCanvas(card, scale);
      files.push({ filename, dataUrl: canvas.toDataURL('image/png') });

      let miniFilename = null;
      if (withMinis) {
        miniFilename = cardFilename(card, '.png');
        const mini = await renderMiniToCanvas(card, scale);
        files.push({ filename: miniFilename, dataUrl: mini.toDataURL('image/png'), subdir: 'mini' });
      }

      // Everything a consumer needs to find and identify a rendered card.
      index.push({
        number: card.number,
        id: card.id,
        title: stripMarkup(card.title),
        file: filename,
        mini: miniFilename ? `mini/${miniFilename}` : null,
        ops: card.ops,
        era: card.era,
        association: card.association,
        scoring: card.scoring,
        optional: card.optional,
        removedOnEvent: card.removedOnEvent,
        permanent: card.permanent,
        source: paths[i],
      });

      // Flush periodically so one giant request does not hold everything in memory.
      if (files.length >= 12 || i === paths.length - 1) {
        await api.exportBatch({ files: files.splice(0, files.length) });
      }
    }

    index.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
    await api.exportIndex({ cards: index, generatedAt: new Date().toISOString() });

    setStatus(`Rendered ${paths.length} cards${withMinis ? ' and mini-cards' : ''}, plus index.json.`, 'ok');
  } catch (err) {
    setStatus(err.message, 'err');
  }
}

// ------------------------------------------------------------- TTS dialog

async function buildTtsDeck() {
  const paths = batchPaths();
  if (!paths.length) return setStatus('No cards to build a deck from.', 'err');

  const name = $('ttsName').value.trim() || 'CustomDeck';
  const scale = Number($('ttsScale').value);
  const backTitle = $('ttsBackTitle').value.trim() || 'TWILIGHT STRUGGLE';

  try {
    setStatus('Loading cards…');
    const cards = [];
    for (const path of paths) cards.push(normalise(await api.readCard(path)));

    setStatus('Compositing atlases…');
    const atlases = await buildAtlases(cards, scale, (done, total) =>
      setStatus(`Compositing ${done} of ${total}…`)
    );

    // The back borrows the first card's palette so it matches the set.
    const style = resolveStyle(cards[0]);
    let backOptions = {
      title: backTitle,
      barColor: style.barColor,
      cardColor: style.cardColor,
      starFill: style.starFill,
      starOutline: style.starOutline,
    };

    if ($('ttsBackMode').value === 'image') {
      const file = $('ttsBackFile').files[0];
      if (file) {
        const stored = await api.imageFromBlob(file, file.name);
        backOptions.art = stored.path;
      }
    }

    setStatus('Writing deck…');
    const back = await buildBack(backOptions, scale);
    const result = await api.buildTts({
      name,
      atlases,
      back,
      cardNames: cards.map((c) => stripMarkup(c.title)),
    });
    setStatus(`Deck written to ${result.dir} (${result.cards} cards)`, 'ok');
  } catch (err) {
    console.error(err);
    setStatus(err.message, 'err');
  }
}

// ---------------------------------------------------------------- dialogs

function wireDialogs() {
  // --- settings ---
  $('settingsBtn').addEventListener('click', async () => {
    state.config = await api.getConfig();
    $('outputDir').value = state.config.outputDir || '';
    $('outputDir').placeholder = state.config.defaultOutputDir || '';
    $('settingsDialog').showModal();
  });

  $('settingsDialog').addEventListener('close', async (e) => {
    if ($('settingsDialog').returnValue !== 'save') return;
    state.config = await api.setConfig({ outputDir: $('outputDir').value.trim() });
    setStatus('Settings saved.', 'ok');
  });

  // --- import ---
  $('importBtn').addEventListener('click', () => {
    $('importPreview').textContent = '';
    $('importDialog').showModal();
  });

  $('importPreviewBtn').addEventListener('click', async () => {
    try {
      const result = await api.importTable({ text: $('importText').value, dryRun: true });
      $('importPreview').textContent =
        `${result.count} card(s) detected. First few: ` +
        result.cards.map((c) => `${c.number ?? '?'} ${c.title} (${c.ops} ops)`).slice(0, 5).join(', ');
    } catch (err) {
      $('importPreview').textContent = err.message;
    }
  });

  $('importDialog').addEventListener('close', async () => {
    if ($('importDialog').returnValue !== 'import') return;
    try {
      const result = await api.importTable({
        text: $('importText').value,
        folder: $('importFolder').value.trim(),
      });
      await tree.refresh();
      setStatus(`Imported ${result.count} cards.`, 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    }
  });

  // --- TTS ---
  $('ttsBtn').addEventListener('click', () => {
    const paths = batchPaths();
    $('ttsSummary').textContent = `${paths.length} card${paths.length === 1 ? '' : 's'} will be included${
      tree.selectedPaths().length ? ' (current selection)' : ' (the whole library — tick cards to narrow it)'
    }.`;
    $('ttsDialog').showModal();
  });

  $('ttsBackMode').addEventListener('change', () => {
    $('ttsBackImageRow').classList.toggle('hidden', $('ttsBackMode').value !== 'image');
  });

  $('ttsDialog').addEventListener('close', () => {
    if ($('ttsDialog').returnValue === 'build') buildTtsDeck();
  });
}

// ------------------------------------------------------------------- start

async function init() {
  await ensureFontsLoaded();

  state.config = await api.getConfig().catch(() => ({}));

  tree = new LibraryTree($('tree'), {
    onOpen: openCard,
    onSelectionChange: (paths) => {
      $('selectionInfo').textContent = paths.length ? `${paths.length} selected` : 'Nothing selected — actions use the whole library.';
    },
    onStatus: setStatus,
  });
  await tree.refresh().catch((err) => setStatus(err.message, 'err'));

  // Any form input re-renders the preview.
  $('cardForm').addEventListener('input', onFormChange);
  $('cardForm').addEventListener('change', onFormChange);
  $('cardForm').addEventListener('submit', (e) => e.preventDefault());

  wireImageIntake();
  wireMarkupTools();
  wireDialogs();

  $('reskinToggle').addEventListener('click', () => {
    const group = $('reskinGroup');
    group.classList.toggle('collapsed');
    $('reskinToggle').textContent = group.classList.contains('collapsed')
      ? 'Reskin & overrides ▸'
      : 'Reskin & overrides ▾';
  });

  // Mark a style control as deliberately edited the first time it is used.
  for (const key of STYLE_INPUTS) {
    $(key)?.addEventListener('input', () => touchedStyles.add(key));
  }

  $('resetStyleBtn').addEventListener('click', () => {
    const keepFontSize = state.card.presentation?.fontSize;
    touchedStyles.clear();
    state.card.presentation = keepFontSize == null ? {} : { fontSize: keepFontSize };
    if (keepFontSize != null) touchedStyles.add('fontSize');
    syncStyleInputs();
    state.dirty = true;
    scheduleRender();
    setStatus('Overrides reset to era defaults.', 'ok');
  });

  $('saveBtn').addEventListener('click', () => saveCard());

  $('saveAsBtn').addEventListener('click', async () => {
    readForm();
    const suggestion = state.path || cardFilename(state.card);
    const target = await askFor('Save as', 'Path inside library/ (folders are created as needed)', suggestion);
    if (!target) return;
    saveCard(target.endsWith('.json') ? target : `${target}.json`);
  });

  $('newCardBtn').addEventListener('click', () => {
    if (state.dirty && !window.confirm('Discard unsaved changes?')) return;
    state.card = blankCard();
    state.path = null;
    state.dirty = false;
    tree.setActive(null);
    $('artFile').value = '';
    $('artUrl').value = '';
    writeForm();
    scheduleRender();
  });

  $('newFolderBtn').addEventListener('click', async () => {
    const name = await askFor('New folder', 'Path inside library/ (e.g. my-reskin/early-war)');
    if (!name) return;
    try {
      await api.createFolder(name);
      await tree.refresh();
      setStatus(`Created library/${name}`, 'ok');
    } catch (err) {
      setStatus(err.message, 'err');
    }
  });

  $('refreshBtn').addEventListener('click', () => tree.refresh());
  $('librarySearch').addEventListener('input', (e) => tree.setFilter(e.target.value));
  $('selectMode').addEventListener('change', (e) => tree.setSelectMode(e.target.checked));
  $('renderAllBtn').addEventListener('click', renderSelected);
  $('exportBtn').addEventListener('click', exportCurrent);

  // Ctrl+S saves rather than triggering the browser's save-page dialog.
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveCard();
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  writeForm();
  scheduleRender();
}

init().catch((err) => {
  console.error(err);
  setStatus(`Startup failed: ${err.message}`, 'err');
});
