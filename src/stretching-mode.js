// Stretching mode: every stretch, head to toe, one step per variant, so you
// can go through the whole body with the → key and know nothing was missed;
// then the joint and spine moves, the nerve glides and (opt-in) foam rolling.
// It drives the shared Stepper (src/stepper.js) and its bar, shows the layers
// each step needs, poses the model into each variant (Viewer.showPose) with
// the parts it works lit, and shows a stretch card (how, hold timer,
// Left/Right, optional contract-relax), a coverage panel (muscles stretched,
// each section, what can't be stretched) and a progress strip on the bar.
// Progress is kept in localStorage when the browser allows it; the mode works
// the same without it.
import { isTypingTarget } from './keyboard-nav.js';
import { canonical } from './layers.js';
import { poseBox } from './pose.js';
import { sideOf } from './search.js';
import { Stepper, stepperBar } from './stepper.js';
import { demo, stretchedMeshes } from './stretch-panel.js';
import {
  GROUP_NAMES,
  KIND_NAMES,
  OPT_IN,
  ROLLING_NOTE,
  STRETCHING,
  coverage,
  describeMove,
  holdTimer,
  isSided,
  partsOf,
  runOrder,
  targetsOf,
  variantRef,
} from './stretching.js';
import * as THREE from 'three';

const STORAGE_KEY = 'body-atlas:stretching';
/** Half the smallest box (m) the camera frames a stretch in: a body region, or the head for the jaw, face and eyes. */
const MIN_FRAME = 0.22;
const HEAD_FRAME = 0.1;
const HEAD_GROUPS = new Set(['jaw', 'face', 'eye']);
/** Target muscles listed on the card before the rest fold away. */
const SHOWN_TARGETS = 8;
/** What each kind of item works, as the card's list heading. */
const TARGET_LABELS = { stretch: 'Stretches', lengthen: 'Lengthens', joint: 'Moves', glide: 'Glides', roll: 'Rolls' };
/** The card's last line, by kind. */
const SAFETY = {
  glide: 'A gentle pull at most, never pain.',
  roll: 'Firm but tolerable pressure, never sharp pain.',
  joint: 'Gentle and slow, never pain.',
};

/**
 * The layers a step shows: the bones and muscles, and the layer whose parts
 * it works (the nerves for a glide, the joints for a joint move or rolling).
 */
export function layersFor(stretch, variant) {
  return [...new Set(['skeletal', 'muscular', ...Object.keys(partsOf(stretch, variant))])];
}

/** localStorage, or null where reading it throws (blocked site data, some private windows). */
function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Saved progress from `storage`: the steps done (doneEntry: a one-side step
 * per side; an older save's bare ref for one counts for neither), the opt-in
 * sections that run (OPT_IN; an older save's true is the face, eyes and
 * tongue), the step and side last shown. Anything missing, unreadable or
 * malformed reads as a fresh start.
 * @returns {{ done: Set<string>, optIn: string[], ref: string | null, side: 'left' | 'right' }}
 */
export function loadProgress(storage) {
  let saved = null;
  try {
    saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    saved = null;
  }
  return {
    done: new Set(Array.isArray(saved?.done) ? saved.done.filter((ref) => typeof ref === 'string') : []),
    optIn:
      saved?.optIn === true
        ? ['lengthen']
        : [...new Set(Array.isArray(saved?.optIn) ? saved.optIn.filter((section) => Object.hasOwn(OPT_IN, section)) : [])],
    ref: typeof saved?.ref === 'string' ? saved.ref : null,
    side: saved?.side === 'right' ? 'right' : 'left',
  };
}

/** Saves progress to `storage`; a full or blocked store is ignored. */
export function saveProgress(storage, { done, optIn, ref, side }) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ done: [...done], optIn, ref, side }));
  } catch {
    // Progress is a convenience: without storage the mode still works for this visit.
  }
}

/** The progress entry for a step done on `side`: "P1a:left" for a one-side step, its ref alone otherwise. */
export function doneEntry({ stretch, variant, ref }, side) {
  return isSided(stretch, variant) ? `${ref}:${side}` : ref;
}

/** Every entry a step needs to be done: both sides for a one-side step, its ref alone otherwise. */
export function entriesOf(item) {
  return isSided(item.stretch, item.variant) ? ['left', 'right'].map((side) => doneEntry(item, side)) : [item.ref];
}

/** The refs of the steps done in full from progress entries: a one-side step only once both its sides are done. */
export function completedSteps(done, items = runOrder({ optIn: true })) {
  return new Set(items.filter((item) => entriesOf(item).every((e) => done.has(e))).map(({ ref }) => ref));
}

/** "abdominal part of pectoralis major" → "Abdominal part of pectoralis major". */
const sentence = (key) => key.charAt(0).toUpperCase() + key.slice(1);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const b = el('button', className, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** Seconds left as "m:ss", rounded up so the count reaches 0:00 only at the end. */
export function clock(seconds) {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Builds Stretching mode: its panels go on the page, hidden until started.
 * @param {import('./viewer.js').Viewer} viewer
 * @param {{
 *   muscular: object,
 *   layer: (id: string) => object,
 *   showLayers: (ids: string[]) => Promise<unknown>,
 *   restoreLayers: () => void,
 *   showGroup: (layerId: string, groupId: string) => void,
 *   onStart?: () => void,
 * }} host the Muscular layer; a layer by id; functions that show exactly
 *   these layers (loading them), put back the ones shown before the mode,
 *   and show a hidden sub-group through its checkbox; and one that runs just
 *   before the mode starts (to end a guide or tour)
 * @returns {{ element: HTMLButtonElement, open: (muscleKey?: string, side?: 'left' | 'right') => Promise<void>, stop: () => void, stepper: Stepper }}
 */
export function stretchingMode(viewer, { muscular, layer, showLayers, restoreLayers, showGroup, onStart }) {
  const storage = browserStorage();
  const progress = loadProgress(storage);
  const save = () => saveProgress(storage, { ...progress, ref: stepper.active ? stepper.current.ref : progress.ref });
  /** Index of the step shown last, to tell a step forward (which marks it done) from a jump. */
  let last = -1;
  let timer = null;
  /** Each layer's emphasis (the movement picker's) before the mode lit its own, put back when it ends. */
  const emphasisBefore = new Map();
  /** Counts steps shown, so a step whose layers finish loading after the next one started is dropped. */
  let showing = 0;

  const stepper = new Stepper({
    onStep(item, index) {
      if (index === last + 1 && last >= 0) progress.done.add(doneEntry(stepper.items[last], progress.side));
      last = index;
      progress.ref = item.ref;
      show(item);
      save();
    },
    onStop() {
      stopTimer();
      last = -1;
      showing++;
      viewer.stopPose();
      for (const [id, role] of emphasisBefore) viewer.setEmphasis(id, role);
      emphasisBefore.clear();
      restoreLayers();
      card.hidden = true;
      panel.hidden = true;
      document.body.classList.remove('stretching', 'stretch-progress');
      entry.textContent = '▶ Stretching mode';
      save();
    },
  }).listen(window);

  // The bar: the shared stepper bar plus a strip of the sections, filled as they are done.
  const bar = stepperBar(stepper, {
    kicker: (s) => `Stretching mode · ${GROUP_NAMES[s.current.stretch.group]}`,
    title: (item) => barTitle(item),
    color: () => muscular.color,
  });
  bar.classList.add('stretch-bar');
  const strip = el('div', 'stretch-strip');
  strip.setAttribute('aria-hidden', 'true');
  bar.insertBefore(strip, bar.querySelector('.stepper-nav'));

  const card = el('aside', 'panel stretch-card');
  card.setAttribute('aria-label', 'Stretch');
  card.setAttribute('aria-live', 'polite');
  card.hidden = true;
  card.style.setProperty('--layer-color', muscular.color);

  const panel = el('aside', 'panel stretch-coverage');
  panel.setAttribute('aria-label', 'Stretching progress');
  panel.hidden = true;
  panel.style.setProperty('--layer-color', muscular.color);

  document.body.append(bar, card, panel);

  const entry = button('tour-button stretch-entry', '▶ Stretching mode', () =>
    stepper.active ? stepper.stop() : open().catch((err) => console.error(err)),
  );
  entry.style.setProperty('--layer-color', muscular.color);
  entry.title = 'Step through every stretch, head to toe (← → to move, Space to time a hold, Esc to end)';

  /** The side a step is shown on: the chosen one for a one-side stretch; the data's (left) otherwise. */
  const shownSide = (item) => (isSided(item.stretch, item.variant) ? progress.side : 'left');

  function barTitle(item) {
    const variant = item.stretch.variants.length > 1 ? ` · ${item.variant.id}` : '';
    const side = isSided(item.stretch, item.variant) ? ` · ${progress.side} side` : '';
    return `${item.stretch.name}${variant}${side}`;
  }

  /** Starts the mode at a muscle's first stretch (on `side`, the muscle's own), else where it was left (or the start). */
  async function open(muscleKey, side) {
    if (side) progress.side = side;
    onStart?.();
    await showLayers(['skeletal', muscular.id]);
    viewer.select(null);
    let ref = progress.ref;
    if (muscleKey) {
      const refs = new Set(STRETCHING.muscles[muscleKey]?.stretches ?? []);
      const mine = ({ stretch, ref: r }) => refs.has(r) || refs.has(stretch.id);
      // A muscle whose only stretches are opt-in (the face's) switches that section on.
      const first = runOrder({ optIn: progress.optIn }).find(mine) ?? runOrder({ optIn: true }).find(mine);
      if (first?.stretch.optIn && !progress.optIn.includes(first.stretch.optIn)) progress.optIn = [...progress.optIn, first.stretch.optIn];
      ref = first?.ref ?? ref;
    }
    const items = runOrder({ optIn: progress.optIn });
    document.body.classList.add('stretching');
    entry.textContent = '■ End stretching mode';
    card.hidden = false;
    panel.hidden = false;
    last = -1;
    stepper.start(items, Math.max(0, items.findIndex((item) => item.ref === ref)));
  }

  /**
   * Fills the card and panel for a step, then (once its layers have loaded)
   * poses, lights and frames it; a running hold timer stops unless `keepTimer`.
   */
  function show(item, keepTimer = false) {
    if (!keepTimer) stopTimer();
    const side = shownSide(item);
    fillCard(item, side);
    fillPanel(item);
    fillStrip();
    const token = ++showing;
    const ids = layersFor(item.stretch, item.variant);
    showLayers(ids)
      .then(() => token === showing && present(item, side, ids))
      .catch((err) => console.error(err));
  }

  /**
   * The meshes a step works, by layer id: a muscle stretch's lengthened
   * muscles (on the side it lengthens them), or the parts a joint move,
   * glide or rolling card names (on the side shown, for a one-side one).
   */
  function litMeshes({ stretch, variant }, side) {
    const lit = new Map();
    if (stretch.kind === 'stretch' || stretch.kind === 'lengthen') {
      lit.set(muscular.id, new Set(stretchedMeshes(viewer.layers.get(muscular.id)?.group, stretch, variant, side)));
    }
    const sides = isSided(stretch, variant) ? [side] : ['left', 'right'];
    for (const [id, keys] of Object.entries(partsOf(stretch, variant))) {
      const want = new Set(keys);
      const meshes = new Set();
      viewer.layers.get(id)?.group?.traverse((o) => {
        if (!o.isMesh || o.userData.haze) return;
        const name = o.userData.of ?? o.userData.name ?? o.name;
        const own = sideOf(name);
        if (want.has(canonical(name)) && (!own || sides.includes(own))) meshes.add(o);
      });
      lit.set(id, meshes);
    }
    return lit;
  }

  function present(item, side, ids) {
    const { ops, cues } = demo(viewer, muscular, item.stretch, item.variant, side);
    if (ops.length || cues.length) viewer.showPose(ops, cues);
    else viewer.stopPose();
    // The parts the step works lit, the rest of their layers faded to a ghost so deep ones show.
    const lit = litMeshes(item, side);
    for (const id of ids) {
      if (id === 'skeletal') continue;
      if (!emphasisBefore.has(id)) emphasisBefore.set(id, viewer.display.get(id)?.role ?? null);
      const mine = lit.get(id) ?? new Set();
      viewer.setEmphasis(id, (mesh) => (mine.has(mesh) ? 'prime' : null));
      // A lit part in a hidden sub-group (fascia starts hidden) is shown through its checkbox.
      const groups = new Set([...mine].map((mesh) => mesh.userData.group));
      for (const g of groups) if (g && !viewer.isGroupVisible(layer(id), g)) showGroup(id, g);
    }
    const box = viewer.poser.rig && ops.length ? poseBox(viewer.poser.rig, ops) : new THREE.Box3();
    // Parts with no bone to turn (the face, eyes, tongue) and rolling are framed by the parts they work.
    if (box.isEmpty()) for (const meshes of lit.values()) for (const mesh of meshes) box.expandByObject(mesh);
    if (!box.isEmpty()) {
      // Never closer than a body region (the head, for the jaw, face and eyes), so the stretch shows in context.
      const half = HEAD_GROUPS.has(item.stretch.group) ? HEAD_FRAME : MIN_FRAME;
      const center = box.getCenter(new THREE.Vector3());
      box.expandByPoint(center.clone().addScalar(half)).expandByPoint(center.clone().subScalar(half));
    }
    viewer.frameBox(box);
  }

  function fillCard(item, side) {
    const { stretch, variant, ref } = item;
    card.replaceChildren();
    card.append(button('close', '×', () => stepper.stop()));
    card.lastChild.setAttribute('aria-label', 'End stretching mode');
    card.lastChild.title = 'End (Esc)';
    card.append(el('p', 'kicker', `Stretching · ${GROUP_NAMES[stretch.group]} · ${ref}`));
    card.append(el('h2', '', stretch.name));
    card.append(el('p', 'stretch-variant', variant.label));
    if (stretch.kind !== 'stretch') card.append(el('p', 'approx', KIND_NAMES[stretch.kind]));

    if (stretch.variants.length > 1) {
      const chips = el('div', 'stretch-chips');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', 'Variant');
      for (const v of stretch.variants) {
        const r = variantRef(stretch, v);
        const chip = button('stretch-chip', `${v.id} · ${v.label}`, () => {
          const at = stepper.items.findIndex((i) => i.ref === r);
          if (at >= 0) stepper.go(at);
        });
        chip.setAttribute('aria-pressed', String(v === variant));
        chips.append(chip);
      }
      card.append(chips);
    }

    const codes = [...(variant.setup ?? []).map((c) => [c, true]), ...variant.moves.map((c) => [c, false])];
    if (codes.length) {
      const moves = el('div', 'stretch-section');
      moves.append(el('p', 'stretch-label', 'Movement'));
      const list = el('ul', 'stretch-moves');
      for (const [code, setup] of codes) {
        const { joint, action, angle } = describeMove(code, side);
        const li = el('li', setup ? 'setup' : '', `${joint} · ${action}${angle !== undefined ? ` ~${angle}°` : ''}`);
        if (setup) li.title = 'Holds the limb where the stretch is done';
        list.append(li);
      }
      moves.append(list);
      card.append(moves);
    }

    const keys = [...targetsOf(stretch, variant), ...Object.values(partsOf(stretch, variant)).flat()];
    const targets = el('div', 'stretch-section');
    targets.append(el('p', 'stretch-label', TARGET_LABELS[stretch.kind]));
    const names = el('ul', 'stretch-targets');
    for (const key of keys.slice(0, SHOWN_TARGETS)) names.append(el('li', '', sentence(key)));
    targets.append(names);
    if (keys.length > SHOWN_TARGETS) {
      const more = el('details', 'stretch-more');
      more.append(el('summary', '', `and ${keys.length - SHOWN_TARGETS} more`));
      const rest = el('ul', 'stretch-targets');
      for (const key of keys.slice(SHOWN_TARGETS)) rest.append(el('li', '', sentence(key)));
      more.append(rest);
      targets.append(more);
    }
    card.append(targets);

    card.append(el('p', 'stretch-how', stretch.how));
    if (stretch.cue) card.append(el('p', 'stretch-cue', stretch.cue));
    if (stretch.kind === 'roll') card.append(el('p', 'stretch-evidence', ROLLING_NOTE));
    if (stretch.evidence) {
      const evidence = el('p', 'stretch-evidence');
      evidence.append(el('span', 'label', 'Evidence: '), document.createTextNode(stretch.evidence));
      card.append(evidence);
    }

    const hold = el('div', 'stretch-hold');
    const timed = holdTimer(stretch.hold);
    const sided = isSided(stretch, variant);
    if (timed) {
      const start = button('tour-button stretch-timer', `▶ Hold ${timed.seconds} s`, () => (timer ? stopTimer() : startTimer(item, timed)));
      start.title = 'Time the hold (Space)';
      hold.append(start);
    }
    hold.append(el('span', 'stretch-hold-text', `${stretch.hold}${sided ? ' · each side' : ''}`));
    if (sided) {
      const sides = el('div', 'stretch-sides');
      sides.setAttribute('role', 'group');
      sides.setAttribute('aria-label', 'Side');
      for (const s of ['left', 'right']) {
        const b = button('stretch-side', s === 'left' ? 'Left' : 'Right', () => setSide(s));
        b.setAttribute('aria-pressed', String(progress.side === s));
        sides.append(b);
      }
      hold.append(sides);
    }
    card.append(hold);
    card.append(el('p', 'stretch-timer-status'));

    if (sided) card.append(el('p', 'stretch-sides-done'));
    const done = button('link-button stretch-done', '', () => {
      const entry = doneEntry(item, side);
      progress.done.has(entry) ? progress.done.delete(entry) : progress.done.add(entry);
      markDone(item);
      save();
    });
    card.append(done);
    markDone(item);

    if (stretch.contractRelax) {
      const cr = el('details', 'stretch-more');
      cr.append(el('summary', '', 'Optional: end-range contract–relax'));
      cr.append(
        el(
          'p',
          '',
          'At the end of the stretch, gently push back against it, as if starting the opposite movement, at about 20 to 50% of your effort for 5 to 10 s without moving. Relax, breathe out and ease a little further. Repeat 2 or 3 times.',
        ),
      );
      card.append(cr);
    }
    card.append(el('p', 'stretch-safety', `${SAFETY[stretch.kind] ?? 'Mild tension, never pain.'} For education only, not medical advice.`));
    // Phones show the progress panel as a sheet in the card's place.
    card.append(button('link-button stretch-progress-open', 'Progress and what can’t be stretched', () => document.body.classList.add('stretch-progress')));
  }

  /** Shows whether a step (on the side shown) is done, and each side's for a one-side step, and refreshes the progress it adds to. */
  function markDone(item) {
    const done = card.querySelector('.stretch-done');
    if (done) {
      const on = progress.done.has(doneEntry(item, shownSide(item)));
      done.textContent = on ? '✓ Done (undo)' : 'Mark as done';
      done.setAttribute('aria-pressed', String(on));
    }
    const sides = card.querySelector('.stretch-sides-done');
    if (sides)
      sides.textContent = ['left', 'right']
        .map((s) => `${s === 'left' ? 'Left' : 'Right'} ${progress.done.has(doneEntry(item, s)) ? '✓' : 'to do'}`)
        .join(' · ');
    if (stepper.active) {
      fillPanel(stepper.current);
      fillStrip();
    }
  }

  function setSide(side) {
    if (progress.side === side) return;
    progress.side = side;
    const item = stepper.current;
    show(item);
    bar.querySelector('.stepper-title').textContent = barTitle(item);
    save();
  }

  /**
   * Times the hold: each round on each side for a one-side stretch (the
   * pose switches sides between them), then marks the step done.
   */
  function startTimer(item, { seconds, rounds }) {
    stopTimer();
    const sided = isSided(item.stretch, item.variant);
    const first = progress.side;
    const phases = [];
    for (let r = 1; r <= rounds; r++) {
      for (const side of sided ? [first, first === 'left' ? 'right' : 'left'] : [null]) phases.push({ round: r, side });
    }
    let phase = 0;
    let left = seconds;
    const status = () => card.querySelector('.stretch-timer-status');
    const startButton = () => card.querySelector('.stretch-timer');
    const render = () => {
      const p = phases[phase];
      const side = p.side ? `${p.side === 'left' ? 'Left' : 'Right'} · ` : '';
      status().textContent = `${side}${clock(left)} · round ${p.round} of ${rounds}`;
    };
    // Wall-clock time, so the hold keeps time while frames are throttled (a background tab).
    let then = performance.now();
    const tick = () => {
      const now = performance.now();
      left -= (now - then) / 1000;
      then = now;
      if (left > 0) return render();
      phase++;
      if (phase >= phases.length) {
        stopTimer();
        for (const entry of entriesOf(item)) progress.done.add(entry);
        status().textContent = '✓ Held. Step on with →.';
        markDone(item);
        save();
        return;
      }
      left = seconds;
      const next = phases[phase].side;
      if (next && next !== progress.side) {
        progress.side = next;
        show(item, true);
        bar.querySelector('.stepper-title').textContent = barTitle(item);
        startButton().textContent = '■ Stop';
      }
      render();
    };
    const interval = setInterval(tick, 200);
    const stop = () => clearInterval(interval);
    timer = { stop };
    startButton().textContent = '■ Stop';
    render();
  }

  function stopTimer() {
    if (!timer) return;
    timer.stop();
    timer = null;
    const start = card.querySelector('.stretch-timer');
    if (start) start.textContent = start.textContent.replace('■ Stop', '▶ Hold again');
    const status = card.querySelector('.stretch-timer-status');
    if (status && !status.textContent.startsWith('✓')) status.textContent = '';
  }

  function fillPanel(item) {
    const complete = completedSteps(progress.done);
    const c = coverage(complete, { optIn: progress.optIn });
    panel.replaceChildren();
    const close = button('close stretch-progress-close', '×', () => document.body.classList.remove('stretch-progress'));
    close.setAttribute('aria-label', 'Back to the stretch');
    panel.append(close, el('p', 'kicker', 'Stretching mode'));
    const head = el('div', 'stretch-total');
    head.append(el('span', '', 'Muscles stretched'), el('span', 'count', `${c.stretched} / ${c.total}`));
    const meter = el('div', 'stretch-meter');
    const fill = el('span');
    fill.style.width = `${(100 * c.stretched) / Math.max(1, c.total)}%`;
    meter.append(fill);
    meter.setAttribute('role', 'progressbar');
    meter.setAttribute('aria-label', 'Muscles stretched');
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(c.total));
    meter.setAttribute('aria-valuenow', String(c.stretched));
    panel.append(head, meter);
    const note = [`Plus ${c.cannot.length} that can’t be stretched, listed below.`];
    if (c.optInMore) note.push(`${c.optInMore} more with ${OPT_IN.lengthen.name.toLowerCase()} below.`);
    panel.append(el('p', 'stretch-note', note.join(' ')));

    const groups = el('ul', 'stretch-groups');
    for (const g of c.groups) {
      const li = el('li');
      const go = button('stretch-group', '', () => {
        const items = stepper.items;
        const todo = items.findIndex(({ stretch, ref }) => stretch.group === g.group && !complete.has(ref));
        stepper.go(todo >= 0 ? todo : items.findIndex(({ stretch }) => stretch.group === g.group));
        document.body.classList.remove('stretch-progress');
      });
      const allDone = g.done === g.total;
      go.classList.toggle('complete', allDone);
      go.classList.toggle('current', item.stretch.group === g.group);
      if (item.stretch.group === g.group) go.setAttribute('aria-current', 'step');
      go.append(el('span', 'dot'), el('span', 'name', g.name), el('span', 'count', `${g.done} / ${g.total}${allDone ? ' ✓' : ''}`));
      li.append(go);
      groups.append(li);
    }
    panel.append(groups);

    for (const [section, { name, note: why }] of Object.entries(OPT_IN)) {
      const optIn = el('label', 'effect');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = progress.optIn.includes(section);
      box.addEventListener('change', () => setOptIn(section, box.checked));
      optIn.append(box, el('span', 'effect-name', name), el('span', 'effect-note', `Opt-in: ${why}`));
      panel.append(optIn);
    }

    const cannot = el('details', 'stretch-more');
    cannot.append(el('summary', '', `Can’t be stretched (${c.cannot.length}) and why`));
    const list = el('ul', 'stretch-cannot');
    for (const { key, reason } of c.cannot) {
      const li = el('li');
      li.append(el('strong', '', sentence(key)), document.createTextNode(`: ${reason}`));
      list.append(li);
    }
    cannot.append(list);
    panel.append(cannot);

    panel.append(
      button('link-button', 'Start over', () => {
        progress.done.clear();
        markDone(stepper.current);
        save();
      }),
    );
  }

  function fillStrip() {
    const c = coverage(completedSteps(progress.done), { optIn: progress.optIn });
    strip.replaceChildren();
    for (const g of c.groups) {
      const seg = el('span', 'seg');
      seg.style.flexGrow = String(g.total);
      seg.title = `${g.name}: ${g.done} / ${g.total}`;
      const fill = el('span');
      fill.style.width = `${(100 * g.done) / g.total}%`;
      seg.append(fill);
      strip.append(seg);
    }
  }

  /** Adds or drops an opt-in section, staying on the same stretch (or the nearest one). */
  function setOptIn(section, on) {
    progress.optIn = on ? [...new Set([...progress.optIn, section])] : progress.optIn.filter((s) => s !== section);
    const ref = stepper.current.ref;
    const items = runOrder({ optIn: progress.optIn });
    let at = items.findIndex((item) => item.ref === ref);
    if (at < 0) at = Math.min(stepper.index, items.length - 1);
    last = -1;
    stepper.start(items, at);
    save();
  }

  // Space starts or stops the hold timer, unless a control that uses it has focus.
  window.addEventListener('keydown', (e) => {
    if (!stepper.active || e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target?.tagName?.toLowerCase();
    if (isTypingTarget(e.target) || ['button', 'input', 'select', 'summary', 'a'].includes(tag)) return;
    const start = card.querySelector('.stretch-timer');
    if (!start) return;
    e.preventDefault();
    start.click();
  });

  return {
    element: entry,
    open,
    stop: () => stepper.stop(),
    stepper,
  };
}
