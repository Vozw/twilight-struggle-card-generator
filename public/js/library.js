/*
 * Library sidebar: a folder tree backed by real directories under library/.
 *
 * Cards are plain JSON files on disk, so the whole library stays hand-editable
 * and diffable -- you can rename a folder in Explorer and the tree follows.
 */

import { api } from './api.js';

export class LibraryTree {
  constructor(root, { onOpen, onSelectionChange, onStatus }) {
    this.root = root;
    this.onOpen = onOpen;
    this.onSelectionChange = onSelectionChange || (() => {});
    this.onStatus = onStatus || (() => {});

    this.data = { folders: [], cards: [] };
    this.expanded = new Set(JSON.parse(localStorage.getItem('tscg.expanded') || '[]'));
    this.selected = new Set();
    this.activePath = null;
    this.filter = '';
    this.selectMode = false;
  }

  async refresh() {
    this.data = await api.listLibrary();
    this.render();
  }

  setFilter(value) {
    this.filter = value.trim().toLowerCase();
    this.render();
  }

  setSelectMode(on) {
    this.selectMode = on;
    if (!on) this.selected.clear();
    this.render();
    this.onSelectionChange(this.selectedPaths());
  }

  selectedPaths() {
    return [...this.selected];
  }

  /** Every card path under the tree, in display order. Used when nothing is ticked. */
  allCardPaths(node = this.data, out = []) {
    for (const card of node.cards) out.push(card.path);
    for (const folder of node.folders) this.allCardPaths(folder, out);
    return out;
  }

  setActive(path) {
    this.activePath = path;
    this.render();
  }

  persistExpanded() {
    localStorage.setItem('tscg.expanded', JSON.stringify([...this.expanded]));
  }

  /** A card survives the filter on its title, file name, or card number. */
  matches(card) {
    if (!this.filter) return true;
    return (
      card.name.toLowerCase().includes(this.filter) ||
      (card.title || '').toLowerCase().includes(this.filter) ||
      String(card.number ?? '').includes(this.filter)
    );
  }

  /** Keep a folder visible if anything inside it matches. */
  folderMatches(folder) {
    if (!this.filter) return true;
    if (folder.name.toLowerCase().includes(this.filter)) return true;
    return folder.cards.some((c) => this.matches(c)) || folder.folders.some((f) => this.folderMatches(f));
  }

  render() {
    this.root.replaceChildren();
    const tree = this.buildLevel(this.data, '');
    if (!tree.childElementCount) {
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = this.filter
        ? 'Nothing matches that filter.'
        : 'No saved cards yet. Build one and hit “Save to library”.';
      this.root.append(empty);
      return;
    }
    this.root.append(tree);
  }

  buildLevel(node, parentPath) {
    const container = document.createElement('div');

    for (const folder of node.folders) {
      if (!this.folderMatches(folder)) continue;
      const open = this.expanded.has(folder.path) || Boolean(this.filter);

      const row = document.createElement('div');
      row.className = 'node folder';
      row.dataset.path = folder.path;
      row.innerHTML = `<span class="twisty">${open ? '▾' : '▸'}</span>`;

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = folder.name;
      row.append(label);

      const count = countCards(folder);
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = count ? String(count) : '';
      row.append(badge);

      row.addEventListener('click', () => {
        if (this.expanded.has(folder.path)) this.expanded.delete(folder.path);
        else this.expanded.add(folder.path);
        this.persistExpanded();
        this.render();
      });

      this.wireDropTarget(row, folder.path);
      this.wireDrag(row, folder.path);
      container.append(row);

      if (open) {
        const children = document.createElement('div');
        children.className = 'node-children';
        children.append(this.buildLevel(folder, folder.path));
        container.append(children);
      }
    }

    for (const card of node.cards) {
      if (!this.matches(card)) continue;

      const row = document.createElement('div');
      row.className = 'node card';
      row.dataset.path = card.path;
      if (card.path === this.activePath) row.classList.add('active');

      if (this.selectMode) {
        const pick = document.createElement('input');
        pick.type = 'checkbox';
        pick.className = 'pick';
        pick.checked = this.selected.has(card.path);
        pick.addEventListener('click', (e) => e.stopPropagation());
        pick.addEventListener('change', () => {
          if (pick.checked) this.selected.add(card.path);
          else this.selected.delete(card.path);
          this.onSelectionChange(this.selectedPaths());
        });
        row.append(pick);
      } else {
        const spacer = document.createElement('span');
        spacer.className = 'twisty';
        row.append(spacer);
      }

      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = card.title || card.name;
      label.title = card.path;
      row.append(label);

      if (card.ops != null && card.ops !== '') {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `${card.ops} ops`;
        row.append(badge);
      }

      row.addEventListener('click', () => this.onOpen(card.path));
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.contextMenu(card.path, card.title || card.name);
      });
      this.wireDrag(row, card.path);
      container.append(row);
    }

    // Dropping onto blank space in a level moves the item to that level.
    this.wireDropTarget(container, parentPath, true);
    return container;
  }

  wireDrag(row, path) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/tscg-path', path);
      e.dataTransfer.effectAllowed = 'move';
      e.stopPropagation();
    });
  }

  wireDropTarget(element, folderPath, passive = false) {
    element.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/tscg-path')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!passive) element.classList.add('drop-target');
    });
    element.addEventListener('dragleave', () => element.classList.remove('drop-target'));
    element.addEventListener('drop', async (e) => {
      const from = e.dataTransfer.getData('text/tscg-path');
      element.classList.remove('drop-target');
      if (!from) return;
      e.preventDefault();
      e.stopPropagation();

      const name = from.split('/').pop();
      const to = folderPath ? `${folderPath}/${name}` : name;
      if (from === to) return;
      if (folderPath.startsWith(from + '/')) {
        this.onStatus('Cannot move a folder into itself.', 'err');
        return;
      }
      try {
        await api.move(from, to);
        if (this.activePath === from) this.activePath = to;
        await this.refresh();
        this.onStatus(`Moved to ${to}`, 'ok');
      } catch (err) {
        this.onStatus(err.message, 'err');
      }
    });
  }

  async contextMenu(path, label) {
    const action = window.prompt(
      `“${label}”\n\nType an action:\n  r = rename\n  d = delete\n\n(or Cancel)`,
      'r'
    );
    if (!action) return;

    if (action.toLowerCase().startsWith('d')) {
      if (!window.confirm(`Delete “${label}”? This removes the file from disk.`)) return;
      await api.deleteEntry(path);
      await this.refresh();
      this.onStatus('Deleted.', 'ok');
      return;
    }

    if (action.toLowerCase().startsWith('r')) {
      const currentName = path.split('/').pop().replace(/\.json$/, '');
      const next = window.prompt('New name', currentName);
      if (!next || next === currentName) return;
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const target = `${parent ? parent + '/' : ''}${next}${path.endsWith('.json') ? '.json' : ''}`;
      try {
        await api.move(path, target);
        if (this.activePath === path) this.activePath = target;
        await this.refresh();
        this.onStatus('Renamed.', 'ok');
      } catch (err) {
        this.onStatus(err.message, 'err');
      }
    }
  }
}

function countCards(node) {
  return node.cards.length + node.folders.reduce((sum, f) => sum + countCards(f), 0);
}
