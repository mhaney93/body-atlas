// Part search: an index of every layer's parts (one entry per mesh, so both
// sides of a paired part are offered) and every layer's `notShown` entries,
// matched by word prefix with typo tolerance, ignoring case and accents.
// Pure data in, data out; src/search-ui.js draws the box and src/search-select.js
// acts on a pick.

/** Words that may appear in a query without having to match ("head of femur" finds "Femur head"). */
const STOP_WORDS = new Set(['of', 'the', 'and', 'a', 'an', 'to', 'in']);
const SIDES = /\b(left|right)\b/gi;

/** "Nérf  Optique!" → "nerf optique": lowercase, accents and punctuation stripped. */
export function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const words = (text) => normalize(text).split(' ').filter(Boolean);

/**
 * "Navicular bone of left foot" → "left"; null for a midline part, and for a
 * name whose side words disagree ("First right anterior branch of … left
 * coronary artery"), where "right" names a branch, not the body's side.
 */
export function sideOf(meshName) {
  const sides = new Set([...meshName.matchAll(SIDES)].map((m) => m[1].toLowerCase()));
  return sides.size === 1 ? [...sides][0] : null;
}

/** "Navicular bone of left foot" → "Navicular bone of foot"; "Left femur" → "Femur". */
export function sidelessName(meshName) {
  const name = meshName.replace(/\b(left|right)\b\s*/gi, '').replace(/\s+/g, ' ').trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * The name a layer's `shared` entries match ("Left lobe of thymus" → "lobe of
 * thymus"), as canonical() in layers.js, which this pure module cannot import.
 */
const sharedName = (meshName) => meshName.toLowerCase().replace(/^(left|right) /, '').replace(/ of (left|right) /, ' of ');

/**
 * Builds the search index. A part a layer borrows from another layer's model
 * (`shared` in its data) is listed under both, so picking it from either
 * switches that layer on.
 * @param {object[]} layers layer data (src/layers.js LAYERS)
 * @param {Record<string, string[]>} meshNames mesh names per layer id (src/mesh-names.json)
 * @param {(layer: object, meshName: string, groupId?: string, source?: object) => {region?: string, approximate?: boolean}} partInfo region lookup
 * @returns {object[]} entries: `{ kind: 'part', layerId, meshName, name, side, region, approximate, sharedFrom?, aliases, words }`
 *   or `{ kind: 'notShown', layerId, name, reason, note?, shownIn?, system?, aliases, words }`;
 *   `aliases` come from the part's or not-shown entry's optional `aliases` list; `sharedFrom` is the id
 *   of the layer whose model holds a shared part
 */
export function buildIndex(layers, meshNames, partInfo) {
  const entries = [];
  const addPart = (layer, meshName, source) => {
    // A part keyed by its full name (e.g. the heart's "left ventricle") has no side.
    const own = layer.parts[meshName.toLowerCase()] ?? source?.parts[meshName.toLowerCase()];
    const side = own ? null : sideOf(meshName);
    const name = side ? sidelessName(meshName) : meshName;
    const part = own ?? layer.parts[name.toLowerCase()] ?? source?.parts[name.toLowerCase()];
    const info = partInfo(layer, meshName, undefined, source);
    entries.push({
      kind: 'part',
      layerId: layer.id,
      meshName,
      name,
      side,
      region: info.region,
      approximate: info.approximate,
      ...(source && { sharedFrom: source.id }),
      aliases: part?.aliases ?? [],
      words: [words(meshName), ...(part?.aliases ?? []).map(words)],
    });
  };
  for (const layer of layers) {
    for (const meshName of meshNames[layer.id] ?? []) addPart(layer, meshName);
    for (const { layer: sourceId, match } of layer.shared ?? []) {
      const source = layers.find((l) => l.id === sourceId);
      for (const meshName of meshNames[sourceId] ?? []) {
        if (new RegExp(match).test(sharedName(meshName))) addPart(layer, meshName, source);
      }
    }
    for (const item of layer.notShown ?? []) {
      entries.push({
        kind: 'notShown',
        layerId: layer.id,
        name: item.name,
        reason: item.reason,
        note: item.note,
        shownIn: item.layer,
        system: item.system,
        aliases: item.aliases ?? [],
        words: [words(item.name), ...(item.aliases ?? []).map(words)],
      });
    }
  }
  return entries;
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), giving up past `max`. */
export function editDistance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1);
      best = Math.min(best, row[j]);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

/** Scores of a hit with a word matched at least by prefix, and of one only matched with a typo. */
const STRONG = 2.5;
const WEAK = 1.2;

/** Typos allowed in a query word of this length. */
const typos = (length) => (length >= 7 ? 2 : length >= 4 ? 1 : 0);

/** How well one query word matches one name word: 4 exact, 3 prefix, 1.5 inside the word, 1 near miss, 0 none. */
function wordScore(q, w) {
  if (w === q) return 4;
  if (w.startsWith(q)) return 3;
  if (q.length >= 3 && w.includes(q)) return 1.5;
  const allowed = typos(q.length);
  if (!allowed) return 0;
  // Compare with the whole word and with its start, so a typo mid-typing still matches.
  const d = Math.min(editDistance(q, w, allowed), editDistance(q, w.slice(0, q.length), allowed));
  return d <= allowed ? 1 - d * 0.2 : 0;
}

/** Score of one name (as words) for the query words; 0 when a required word has no match. */
function nameScore(queryWords, nameWords, phrase) {
  let total = 0;
  const used = new Set();
  for (const q of queryWords) {
    let best = 0;
    let bestAt = -1;
    nameWords.forEach((w, i) => {
      const s = used.has(i) ? 0 : wordScore(q, w);
      if (s > best) [best, bestAt] = [s, i];
    });
    if (!best) {
      if (STOP_WORDS.has(q)) continue;
      return 0;
    }
    used.add(bestAt);
    total += best;
  }
  const joined = nameWords.join(' ');
  // The name starts with what was typed, also past a leading side word ("Left lateral ventricle").
  if (joined.startsWith(phrase) || joined.replace(/^(left|right) /, '').startsWith(phrase)) total += 3;
  else if (nameWords[0]?.startsWith(queryWords[0])) total += 1;
  return total - nameWords.length * 0.05; // shorter names first among equals
}

/**
 * The entries matching `query`, best first. A paired part's two sides come
 * one after the other; a part beats a not-shown entry of equal score.
 * @returns {object[]} entries from buildIndex, each with a `score`, and the
 *   `alias` it matched through when it matched only by an alias
 */
export function search(index, query, limit = 30) {
  const queryWords = words(query);
  if (!queryWords.length) return [];
  const phrase = queryWords.join(' ');
  let hits = [];
  for (const entry of index) {
    const scores = entry.words.map((w) => nameScore(queryWords, w, phrase));
    const score = Math.max(...scores);
    if (score <= 0) continue;
    // Matched only through an alias: say which, so "kneecap" explains "Patella".
    const alias = scores[0] < score ? entry.aliases[scores.indexOf(score) - 1] : undefined;
    hits.push({ ...entry, score, alias });
  }
  // Near misses are only worth showing when nothing matches properly.
  const strong = hits.some((h) => h.score >= STRONG);
  if (strong) hits = hits.filter((h) => h.score >= WEAK);
  // Rank by each part's best side, so both sides stay together.
  const groupKey = (e) => `${e.kind}/${e.layerId}/${e.name}`;
  const best = new Map();
  for (const h of hits) best.set(groupKey(h), Math.max(best.get(groupKey(h)) ?? 0, h.score));
  const sideOrder = { left: 0, right: 1 };
  hits.sort(
    (a, b) =>
      best.get(groupKey(b)) - best.get(groupKey(a)) ||
      (a.kind === b.kind ? 0 : a.kind === 'part' ? -1 : 1) ||
      a.name.localeCompare(b.name) ||
      a.layerId.localeCompare(b.layerId) ||
      (sideOrder[a.side] ?? -1) - (sideOrder[b.side] ?? -1),
  );
  return hits.slice(0, limit);
}

/** True for a keydown that should focus the search box ("/" while not typing elsewhere). */
export function isSearchShortcut(event, isTypingTarget) {
  return event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !isTypingTarget(event.target);
}
