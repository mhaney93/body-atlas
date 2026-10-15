// A layer's "Not shown" list (`notShown` in its data): the parts its model
// leaves out and why, shown as a collapsible panel under the layer's toggle so
// the site never hides anything silently. Entries are grouped by reason (see
// NOT_SHOWN_REASONS); one that belongs to another layer offers to switch it on.
import { NOT_SHOWN_REASONS } from './layers.js';

/**
 * @param {object} layer layer data
 * @param {{ layerName: (id: string) => string | undefined, showLayer: (id: string) => void }} host
 * @returns {HTMLDetailsElement | null}
 */
export function notShownPanel(layer, host) {
  const entries = layer.notShown ?? [];
  if (!entries.length && !layer.nothingLeftOut) return null;
  const details = document.createElement('details');
  details.className = 'not-shown';
  details.style.setProperty('--layer-color', layer.color);
  const summary = document.createElement('summary');
  summary.textContent = entries.length ? `Not shown (${entries.length})` : 'Not shown (none)';
  details.append(summary);
  const intro = document.createElement('p');
  intro.className = 'control-note';
  intro.textContent = entries.length
    ? `Parts of the ${layer.name.toLowerCase()} system this model leaves out, and why.`
    : layer.nothingLeftOut;
  details.append(intro);

  for (const [reason, label] of Object.entries(NOT_SHOWN_REASONS)) {
    const group = entries.filter((e) => e.reason === reason);
    if (!group.length) continue;
    const heading = document.createElement('h3');
    heading.textContent = label;
    const list = document.createElement('ul');
    for (const entry of group) {
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.className = 'not-shown-name';
      name.textContent = entry.name;
      item.append(name);
      const where = entry.layer
        ? null
        : entry.system && `Part of the ${entry.system} system, not on the site yet.`;
      const text = [entry.note, where].filter(Boolean).join(' ');
      if (text) {
        const note = document.createElement('span');
        note.className = 'not-shown-note';
        note.textContent = text;
        item.append(note);
      }
      if (entry.layer) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.textContent = `Shown in ${host.layerName(entry.layer) ?? entry.layer}`;
        button.addEventListener('click', () => host.showLayer(entry.layer));
        item.append(button);
      }
      list.append(item);
    }
    details.append(heading, list);
  }
  return details;
}
