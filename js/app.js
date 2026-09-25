/*
 * Photo Collage — application state, editor interaction and UI.
 */
(function () {
  'use strict';

  const G = window.CollageGeometry;
  const Rn = window.CollageRender;
  const St = window.CollageStorage;
  const $ = (id) => document.getElementById(id);
  const DEG = Math.PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const PAPERS = [
    { id: 'A4', label: 'A4 — 21 × 29.7 cm', w: 210, h: 297 },
    { id: 'A3', label: 'A3 — 29.7 × 42 cm', w: 297, h: 420 },
    { id: 'A2', label: 'A2 — 42 × 59.4 cm', w: 420, h: 594 },
    { id: 'A1', label: 'A1 — 59.4 × 84.1 cm', w: 594, h: 841 },
    { id: 'A0', label: 'A0 — 84.1 × 118.9 cm', w: 841, h: 1189 },
    { id: '20x30', label: '20 × 30 cm', w: 200, h: 300 },
    { id: '30x40', label: '30 × 40 cm', w: 300, h: 400 },
    { id: '40x50', label: '40 × 50 cm', w: 400, h: 500 },
    { id: '40x60', label: '40 × 60 cm', w: 400, h: 600 },
    { id: '50x70', label: '50 × 70 cm', w: 500, h: 700 },
    { id: '60x90', label: '60 × 90 cm', w: 600, h: 900 },
    { id: '70x100', label: '70 × 100 cm', w: 700, h: 1000 },
    { id: '30x30', label: '30 × 30 cm (square)', w: 300, h: 300 },
    { id: '50x50', label: '50 × 50 cm (square)', w: 500, h: 500 },
    { id: 'custom', label: 'Custom size…' },
  ];

  const PREVIEW_PX = 560;   // long side of the in-memory editing preview
  const THUMB_PX = 200;     // tray thumbnails
  const HIRES_PX = 2400;    // sharper version loaded when zoomed in
  const HIRES_CACHE = 8;
  const MAX_SIDE = 16384;   // browser canvas limits
  const MAX_AREA = 268e6;

  function defaultState() {
    return {
      version: 1,
      paper: { preset: 'A3', w: 297, h: 420, dpi: 300, margin: 10 },
      layout: {
        type: 'squares', cols: 4, rows: 5, auto: true, shape: 'rect',
        gap: 3, radius: 0, bg: '#ffffff', fillEdges: true, repeat: true,
        mixed: 0.35, seed: 1,
        size: 1, tilt: 10, frame: 'polaroid', shadow: true,
      },
      photos: [],  // {id, name, w, h, key}
      slots: [],   // one per tile: {photo, zoom, ox, oy, rot, flip}
      items: [],   // scattered layout only: {x, y, s, t, dr, z}
    };
  }

  let S = defaultState();

  // Runtime-only data (never saved).
  const R = {
    images: new Map(),       // photoId -> {blob, preview, previewBlob, thumbBlob, thumbUrl}
    photoMap: new Map(),     // photoId -> photo meta
    hires: new Map(),
    hiresLoading: new Set(),
    dbIds: new Set(),
    thumbEls: new Map(),
    cells: [],
    view: { zoom: 1, px: 0, py: 0 },
    sel: -1,
    hover: -1,
    crop: false,
    drag: null,
    dragPos: null,
    dropTarget: -1,
    trayDrag: null,
    pendingTarget: null,
    undo: [],
    redo: [],
    baseline: '',
    space: false,
    raf: 0,
    storageFullWarned: false,
  };

  const newSlot = (photo) => ({ photo: photo || null, zoom: 1, ox: 0, oy: 0, rot: 0, flip: false });
  const EMPTY_SLOT = newSlot(null);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------

  function content() {
    const { w, h } = S.paper;
    const m = clamp(S.paper.margin, 0, Math.min(w, h) / 2 - 5);
    return { x: m, y: m, w: w - 2 * m, h: h - 2 * m };
  }

  const isScatter = () => S.layout.type === 'scatter';

  function computeCells() {
    const L = S.layout, C = content();
    if (L.type === 'scatter') {
      const n = S.items.length;
      return S.items.map((it, i) => {
        const slot = S.slots[i] || EMPTY_SLOT;
        const photo = slot.photo ? R.photoMap.get(slot.photo) : null;
        return Rn.scatterCell(it, photo, slot, C, n, L);
      });
    }
    return G.layout(L.type, C, L);
  }

  function model() {
    return {
      W: S.paper.w, H: S.paper.h, C: content(), bg: S.layout.bg, L: S.layout,
      cells: R.cells, slots: S.slots, photos: R.photoMap,
    };
  }

  // Pick the density that fits all photos.
  function autoFit() {
    const N = S.photos.length, L = S.layout;
    if (!N || L.type === 'scatter') return;
    const C = content();
    if (L.type === 'squares' && L.shape === 'rect') {
      const b = G.bestGrid(N, C, L.gap);
      L.cols = b.cols;
      L.rows = b.rows;
      return;
    }
    for (let cols = 1; cols <= 80; cols++) {
      if (G.layout(L.type, C, { ...L, cols }).length >= N) { L.cols = cols; return; }
    }
    L.cols = 80;
  }

  // Unique photos in their current order (with their crop settings), then unused photos.
  function sequence() {
    const seen = new Set(), seq = [];
    for (const s of S.slots) {
      if (s.photo && R.photoMap.has(s.photo) && !seen.has(s.photo)) { seen.add(s.photo); seq.push(s); }
    }
    for (const p of S.photos) if (!seen.has(p.id)) seq.push(newSlot(p.id));
    return seq;
  }

  function rebuildSlots(count, seq) {
    seq = seq || sequence();
    const out = [];
    for (let i = 0; i < count; i++) {
      if (i < seq.length) out.push(seq[i]);
      else if (S.layout.repeat && seq.length) out.push({ ...seq[i % seq.length] });
      else out.push(newSlot(null));
    }
    S.slots = out;
  }

  // Put photos that are not in the collage into empty tiles, then into tiles showing a repeat.
  function placeUnused() {
    const used = new Set(S.slots.map((s) => s.photo).filter(Boolean));
    const unused = S.photos.filter((p) => !used.has(p.id));
    if (!unused.length) return;
    const seen = new Set(), empty = [], dup = [];
    S.slots.forEach((s, i) => {
      if (!s.photo) empty.push(i);
      else if (seen.has(s.photo)) dup.push(i);
      else seen.add(s.photo);
    });
    const targets = empty.concat(dup);
    unused.forEach((p, k) => { if (k < targets.length) S.slots[targets[k]] = newSlot(p.id); });
  }

  function fillEmptyWithRepeats() {
    if (!S.layout.repeat || isScatter()) return;
    const seq = sequence().filter((s) => S.slots.some((x) => x.photo === s.photo));
    if (!seq.length) return;
    let k = 0;
    S.slots.forEach((s, i) => { if (!s.photo) S.slots[i] = { ...seq[k++ % seq.length] }; });
  }

  function freshScatterItems(n) {
    const C = content();
    S.layout.seed = Math.floor(Math.random() * 1e9);
    return G.newScatterItems([], n, C.w / C.h, G.rng(S.layout.seed));
  }

  // Recompute geometry after a state change and update the whole UI.
  function refresh(opts) {
    opts = opts || {};
    R.photoMap = new Map(S.photos.map((p) => [p.id, p]));
    if (opts.refit && S.layout.auto) autoFit();
    R.cells = computeCells();
    if (!isScatter() && S.slots.length !== R.cells.length) rebuildSlots(R.cells.length);
    if (R.sel >= R.cells.length) { R.sel = -1; R.crop = false; }
    R.hover = -1;
    syncControls();
    renderTray();
    renderInspector();
    render();
    scheduleSave();
  }

  // Cheap update while dragging: geometry (scatter only) + redraw.
  function recalc() {
    if (isScatter()) R.cells = computeCells();
    render();
  }

  // ---------------------------------------------------------------------------
  // Undo / persistence
  // ---------------------------------------------------------------------------

  const snapshot = () => JSON.stringify({ photos: S.photos, paper: S.paper, layout: S.layout, slots: S.slots, items: S.items });

  // Record a finished change as one undo step.
  function settle() {
    const snap = snapshot();
    if (snap !== R.baseline) {
      R.undo.push(R.baseline);
      if (R.undo.length > 200) R.undo.shift();
      R.redo = [];
      R.baseline = snap;
    }
    updateUndoButtons();
    syncDb();
    scheduleSave();
  }

  let settleTimer = 0;
  function settleSoon() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 450);
  }

  function applySnapshot(snap) {
    const o = JSON.parse(snap);
    S.photos = o.photos.filter((p) => R.images.has(p.id));
    S.paper = o.paper;
    S.layout = o.layout;
    S.items = o.items;
    const ids = new Set(S.photos.map((p) => p.id));
    S.slots = o.slots.map((s) => (s.photo && !ids.has(s.photo) ? newSlot(null) : s));
    if (isScatter() && S.items.length !== S.slots.length) {
      S.items = S.items.slice(0, S.slots.length);
      while (S.items.length < S.slots.length) S.items.push(...G.newScatterItems(S.items, 1, 1, Math.random));
    }
    R.crop = false;
    refresh();
    R.baseline = snapshot();
    updateUndoButtons();
    syncDb();
  }

  function undo() {
    settle();
    if (!R.undo.length) return;
    R.redo.push(R.baseline);
    applySnapshot(R.undo.pop());
  }

  function redo() {
    settle();
    if (!R.redo.length) return;
    R.undo.push(R.baseline);
    applySnapshot(R.redo.pop());
  }

  function updateUndoButtons() {
    $('btnUndo').disabled = !R.undo.length;
    $('btnRedo').disabled = !R.redo.length;
  }

  let saveTimer = 0;
  function scheduleSave() {
    if (!St.ok) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => St.saveState(JSON.parse(JSON.stringify(S))), 500);
  }

  // Keep IndexedDB's photo store in line with the photos in the project.
  function syncDb() {
    if (!St.ok) return;
    const ids = new Set(S.photos.map((p) => p.id));
    for (const p of S.photos) {
      if (R.dbIds.has(p.id)) continue;
      const r = R.images.get(p.id);
      if (!r) continue;
      R.dbIds.add(p.id);
      St.putPhoto({ id: p.id, name: p.name, w: p.w, h: p.h, blob: r.blob, preview: r.previewBlob, thumb: r.thumbBlob })
        .then((res) => {
          if (res !== undefined) return;
          R.dbIds.delete(p.id);
          if (!R.storageFullWarned) {
            R.storageFullWarned = true;
            toast('Autosave ran out of space in this browser — use “Save…” to keep your project safe.', true);
            setTimeout(hideToast, 8000);
          }
        });
    }
    for (const id of [...R.dbIds]) {
      if (!ids.has(id)) { R.dbIds.delete(id); St.deletePhoto(id); }
    }
  }

  // ---------------------------------------------------------------------------
  // Images
  // ---------------------------------------------------------------------------

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const done = () => resolve(img);
        if (img.decode) img.decode().then(done, done);
        else done();
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img._url = url;
      img.src = url;
    });
  }

  function releaseImage(img) {
    if (!img) return;
    if (img._url) URL.revokeObjectURL(img._url);
    img.src = '';
  }

  // High-quality downscale by repeated halving.
  function downscale(src, max) {
    let w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
    const s = Math.min(1, max / Math.max(w, h));
    const tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
    let cur = src;
    while (w / 2 > tw * 1.05) {
      w = Math.round(w / 2); h = Math.round(h / 2);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const cx = c.getContext('2d');
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(cur, 0, 0, w, h);
      if (cur !== src) cur.width = cur.height = 0;
      cur = c;
    }
    const out = document.createElement('canvas');
    out.width = tw; out.height = th;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, tw, th);
    if (cur !== src) cur.width = cur.height = 0;
    return out;
  }

  const canvasBlob = (c, type, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), type, q));

  // ---- HEIC (iPhone photos) ----
  // Only Safari decodes HEIC natively, so HEIC photos are converted to a high-quality JPEG
  // on import. Projects then open, autosave and export the same in every browser.

  const HEIC_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'msf1'];

  async function isHeic(blob, name) {
    if (/\.hei[cf]$/i.test(name || '') || /^image\/hei[cf]/i.test(blob.type)) return true;
    const head = String.fromCharCode(...new Uint8Array(await blob.slice(4, 12).arrayBuffer()));
    return head.slice(0, 4) === 'ftyp' && HEIC_BRANDS.includes(head.slice(4));
  }

  let heicLib = null;
  function loadHeicLib() {
    if (!heicLib) {
      heicLib = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'vendor/heic-to.js';
        s.onload = () => (window.HeicTo ? resolve(window.HeicTo) : reject(new Error('heic-lib')));
        s.onerror = () => { heicLib = null; reject(new Error('heic-lib')); };
        document.head.appendChild(s);
      });
    }
    return heicLib;
  }

  async function heicToJpeg(blob) {
    try {
      // Safari: use the built-in decoder.
      const img = await loadImage(blob);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      releaseImage(img);
      try {
        return await canvasBlob(c, 'image/jpeg', 0.95);
      } finally {
        c.width = c.height = 0;
      }
    } catch (e) {
      // Other browsers: bundled libheif decoder (applies the photo's rotation itself).
      const HeicTo = await loadHeicLib();
      return HeicTo({ blob, type: 'image/jpeg', quality: 0.95 });
    }
  }

  // Decode a photo once, keep a small preview and thumbnail in memory.
  async function processPhoto(blob, name, id, key) {
    if (await isHeic(blob, name)) blob = await heicToJpeg(blob);
    const img = await loadImage(blob);
    const w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) throw new Error('decode');
    const preview = downscale(img, PREVIEW_PX);
    const thumb = downscale(preview, THUMB_PX);
    releaseImage(img);
    const [previewBlob, thumbBlob] = await Promise.all([canvasBlob(preview, 'image/jpeg', 0.86), canvasBlob(thumb, 'image/jpeg', 0.8)]);
    R.images.set(id, { blob, preview, previewBlob, thumbBlob, thumbUrl: URL.createObjectURL(thumbBlob) });
    return { id, name, w, h, key: key || name };
  }

  async function pool(items, n, fn) {
    let next = 0;
    const worker = async () => {
      while (next < items.length) {
        const k = next++;
        await fn(items[k], k);
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  // Choose the preview or a sharper version depending on how big the photo is on screen.
  function pickImage(id, i, k) {
    const rec = R.images.get(id);
    if (!rec) return null;
    const cell = R.cells[i], slot = S.slots[i], photo = R.photoMap.get(id);
    if (!cell || !slot || !photo) return rec.preview;
    const p = Rn.placement(photo.w, photo.h, cell.box, slot);
    const needed = Math.max(photo.w, photo.h) * p.s * k;
    if (needed > PREVIEW_PX * 1.3 && Math.max(photo.w, photo.h) > PREVIEW_PX * 1.3) {
      const hi = R.hires.get(id);
      if (hi) {
        R.hires.delete(id);
        R.hires.set(id, hi); // most recently used
        return hi;
      }
      requestHires(id);
    }
    return rec.preview;
  }

  function requestHires(id) {
    if (R.hiresLoading.has(id) || R.drag) return;
    const rec = R.images.get(id);
    if (!rec) return;
    R.hiresLoading.add(id);
    loadImage(rec.blob)
      .then((img) => {
        const c = downscale(img, HIRES_PX);
        releaseImage(img);
        R.hires.set(id, c);
        while (R.hires.size > HIRES_CACHE) {
          const oldest = R.hires.keys().next().value;
          R.hires.get(oldest).width = 0;
          R.hires.delete(oldest);
        }
        render();
      })
      .catch(() => {})
      .finally(() => R.hiresLoading.delete(id));
  }

  // ---------------------------------------------------------------------------
  // Photo management
  // ---------------------------------------------------------------------------

  const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|avif|tiff?|bmp)$/i;
  const isImageFile = (f) => (f.type && f.type.startsWith('image/')) || IMAGE_EXT.test(f.name);
  const fileKey = (f) => `${f.name}:${f.size}:${f.lastModified || 0}`;

  async function importFiles(fileList, target) {
    const files = [...fileList].filter(isImageFile);
    if (!files.length) { toast('No photos found in what you added.'); return; }
    const known = new Set(S.photos.map((p) => p.key));
    const todo = files.filter((f) => !known.has(fileKey(f)));
    const skipped = files.length - todo.length;
    if (!todo.length) { toast('Those photos are already in the collage.'); return; }
    const results = new Array(todo.length);
    const failed = [];
    let done = 0;
    toast(`Adding photos… 0 / ${todo.length}`, true);
    await pool(todo, 3, async (file, k) => {
      try {
        results[k] = await processPhoto(file, file.name, uid(), fileKey(file));
      } catch (e) {
        failed.push(file.name);
      }
      done++;
      toast(`Adding photos… ${done} / ${todo.length}`, true);
    });
    const metas = results.filter(Boolean);
    if (metas.length) addPhotos(metas, target);
    let msg = `Added ${metas.length} photo${metas.length === 1 ? '' : 's'}.`;
    if (skipped) msg += ` ${skipped} already added.`;
    if (failed.length) {
      const heic = failed.some((n) => /\.hei[cf]$/i.test(n));
      msg += ` Couldn't read ${failed.length}: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}.`;
      if (heic) msg += ' If these are HEIC photos, try exporting them as JPEG from the Photos app.';
    }
    toast(msg, failed.length > 0);
    if (failed.length) setTimeout(() => hideToast(), 9000);
  }

  function addPhotos(metas, target) {
    const countBefore = R.cells.length;
    S.photos.push(...metas);
    R.photoMap = new Map(S.photos.map((p) => [p.id, p]));
    if (isScatter()) {
      const C = content();
      S.items.push(...G.newScatterItems(S.items, metas.length, C.w / C.h, G.rng(Date.now() & 0xffffff)));
      S.slots.push(...metas.map((m) => newSlot(m.id)));
      refresh();
    } else {
      refresh({ refit: true });
      placeUnused();
      fillEmptyWithRepeats();
      if (target != null && R.cells.length === countBefore && target < S.slots.length) {
        const j = S.slots.findIndex((s) => s.photo === metas[0].id);
        if (j >= 0 && j !== target) [S.slots[j], S.slots[target]] = [S.slots[target], S.slots[j]];
        else if (j < 0) S.slots[target] = newSlot(metas[0].id);
      }
      refresh();
    }
    settle();
  }

  function removePhoto(id) {
    S.photos = S.photos.filter((p) => p.id !== id);
    R.photoMap = new Map(S.photos.map((p) => [p.id, p]));
    if (isScatter()) {
      const keep = S.slots.map((s, i) => i).filter((i) => S.slots[i].photo !== id);
      S.items = keep.map((i) => S.items[i]);
      S.slots = keep.map((i) => S.slots[i]);
    } else {
      S.slots = S.slots.map((s) => (s.photo === id ? newSlot(null) : s));
    }
    R.sel = -1;
    R.crop = false;
    refresh({ refit: true });
    if (!isScatter()) {
      placeUnused();
      fillEmptyWithRepeats();
      refresh();
    }
    settle();
  }

  function shuffle() {
    const shuffleArr = (a) => {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    };
    if (isScatter()) shuffleArr(S.slots);
    else rebuildSlots(R.cells.length, shuffleArr(sequence()));
    R.crop = false;
    refresh();
    settle();
  }

  function setLayout(type) {
    if (type === S.layout.type) return;
    S.layout.type = type;
    if (type === 'scatter') {
      const seq = sequence();
      S.slots = seq;
      if (S.items.length !== seq.length) S.items = freshScatterItems(seq.length);
    }
    R.sel = -1;
    R.crop = false;
    refresh({ refit: true });
    settle();
  }

  // ---- Tile actions ----

  function selSlot() { return R.sel >= 0 ? S.slots[R.sel] : null; }

  function placePhoto(i, id) {
    const prev = S.slots[i];
    S.slots[i] = newSlot(id);
    if (prev && prev.photo === id) S.slots[i] = prev;
    R.sel = i;
    R.crop = false;
    refresh();
    settle();
  }

  function addScatterAt(x, y, id) {
    const C = content();
    const z = S.items.reduce((m, it) => Math.max(m, it.z), 0) + 1;
    S.items.push({ x: clamp((x - C.x) / C.w, 0, 1), y: clamp((y - C.y) / C.h, 0, 1), s: 1, t: Math.random() * 2 - 1, dr: 0, z });
    S.slots.push(newSlot(id));
    R.sel = S.slots.length - 1;
    refresh();
    settle();
  }

  function clearTile(i) {
    if (i < 0 || !S.slots[i]) return;
    if (isScatter()) {
      S.slots.splice(i, 1);
      S.items.splice(i, 1);
    } else {
      if (!S.slots[i].photo) return;
      S.slots[i] = newSlot(null);
    }
    R.sel = isScatter() ? -1 : R.sel;
    R.crop = false;
    refresh();
    settle();
  }

  function rotateTile() {
    const s = selSlot();
    if (!s || !s.photo) return;
    s.rot = (s.rot + 90) % 360;
    s.ox = 0; s.oy = 0;
    recalc();
    updateInspectorValues();
    settle();
  }

  function flipTile() {
    const s = selSlot();
    if (!s || !s.photo) return;
    // Mirror on screen regardless of rotation: mirror ∘ rot(θ) = rot(−θ) ∘ mirror.
    s.flip = !s.flip;
    s.rot = (360 - s.rot) % 360;
    s.ox = -s.ox;
    recalc();
    settle();
  }

  function resetTile() {
    const s = selSlot();
    if (!s) return;
    s.zoom = 1; s.ox = 0; s.oy = 0;
    recalc();
    updateInspectorValues();
    settle();
  }

  function setCrop(on) {
    const s = selSlot();
    R.crop = !!(on && s && s.photo);
    const b = $('iCrop');
    if (b) {
      b.classList.toggle('on', R.crop);
      b.textContent = R.crop ? 'Done adjusting' : 'Adjust crop';
    }
    render();
  }

  function zoomPhoto(factor) {
    const s = selSlot();
    if (!s || !s.photo) return;
    const photo = R.photoMap.get(s.photo), cell = R.cells[R.sel];
    const p = Rn.placement(photo.w, photo.h, cell.box, s);
    s.zoom = clamp(s.zoom * factor, p.minZoom, 8);
    render();
    updateInspectorValues();
    settleSoon();
  }

  function zOrder(front) {
    if (!isScatter() || R.sel < 0) return;
    const zs = S.items.map((it) => it.z);
    S.items[R.sel].z = front ? Math.max(...zs) + 1 : Math.min(...zs) - 1;
    recalc();
    settle();
  }

  // ---------------------------------------------------------------------------
  // Rendering the editor
  // ---------------------------------------------------------------------------

  const canvas = $('stage');
  const wrap = $('stageWrap');

  function render() {
    if (!R.raf) R.raf = requestAnimationFrame(draw);
  }

  function view() {
    const cw = wrap.clientWidth, ch = wrap.clientHeight, pad = 40;
    const fit = Math.max(0.01, Math.min((cw - pad * 2) / S.paper.w, (ch - pad * 2) / S.paper.h));
    const s = fit * R.view.zoom;
    return { s, fit, cw, ch, tx: (cw - S.paper.w * s) / 2 + R.view.px, ty: (ch - S.paper.h * s) / 2 + R.view.py };
  }

  function toPaper(e) {
    const r = canvas.getBoundingClientRect(), v = view();
    return [(e.clientX - r.left - v.tx) / v.s, (e.clientY - r.top - v.ty) / v.s];
  }

  function draw() {
    R.raf = 0;
    const dpr = window.devicePixelRatio || 1;
    const v = view();
    const W = Math.round(v.cw * dpr), H = Math.round(v.ch * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const k = dpr * v.s;
    ctx.setTransform(k, 0, 0, k, dpr * v.tx, dpr * v.ty);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 18 * dpr;
    ctx.shadowOffsetY = 3 * dpr;
    ctx.fillStyle = S.layout.bg;
    ctx.fillRect(0, 0, S.paper.w, S.paper.h);
    ctx.restore();

    const m = model();
    Rn.drawCollage(ctx, m, { pxScale: k, editor: true, image: (id, i) => pickImage(id, i, k) });
    drawOverlays(ctx, m, k, dpr / k);
    updateHint();
  }

  function strokeCell(ctx, cell, color, width) {
    Rn.traceCell(ctx, cell, S.layout.radius);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }

  // Everything drawn on top of the collage: hover, selection, handles, drag feedback.
  function drawOverlays(ctx, m, k, u) {
    const d = R.drag;
    if (R.dropTarget >= 0 && R.cells[R.dropTarget]) {
      const c = R.cells[R.dropTarget];
      Rn.traceCell(ctx, c, S.layout.radius);
      ctx.fillStyle = 'rgba(10,132,255,0.28)';
      ctx.fill();
      strokeCell(ctx, c, '#0a84ff', 3 * u);
    }
    if (R.hover >= 0 && R.hover !== R.sel && !d && R.cells[R.hover]) {
      strokeCell(ctx, R.cells[R.hover], 'rgba(10,132,255,0.55)', 2 * u);
    }
    if (R.sel >= 0 && R.cells[R.sel]) {
      if (R.crop) drawCropOverlay(ctx, m, k, u);
      else {
        const c = R.cells[R.sel];
        strokeCell(ctx, c, 'rgba(255,255,255,0.9)', 5 * u);
        strokeCell(ctx, c, '#0a84ff', 2.5 * u);
        if (c.scatter) drawHandles(ctx, c, u);
      }
    }
    if (d && d.kind === 'swap' && R.dragPos) {
      const slot = S.slots[d.i];
      const rec = slot && slot.photo && R.images.get(slot.photo);
      if (rec) {
        const img = rec.preview;
        const size = 90 * u;
        const iw = img.width, ih = img.height, sc = size / Math.max(iw, ih);
        const [x, y] = R.dragPos;
        ctx.save();
        ctx.globalAlpha = 0.85;
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 12 * u * k;
        ctx.drawImage(img, x - (iw * sc) / 2, y - (ih * sc) / 2, iw * sc, ih * sc);
        ctx.restore();
      }
    }
  }

  function drawCropOverlay(ctx, m, k, u) {
    const i = R.sel, cell = R.cells[i], slot = S.slots[i];
    const photo = slot.photo && R.photoMap.get(slot.photo);
    if (!photo) return;
    const img = pickImage(slot.photo, i, k);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.save();
    if (cell.scatter) { ctx.translate(cell.cx, cell.cy); ctx.rotate(cell.rot); }
    const p = Rn.placement(photo.w, photo.h, cell.box, slot);
    ctx.save();
    ctx.globalAlpha = 0.5;
    Rn.drawPhoto(ctx, img, photo, cell.box, slot);
    ctx.restore();
    ctx.translate(p.cx, p.cy);
    ctx.rotate(slot.rot * DEG);
    const w = photo.w * p.s, h = photo.h * p.s;
    ctx.setLineDash([5 * u, 4 * u]);
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();

    Rn.drawCell(ctx, m, i, img, { pxScale: k, editor: true });
    strokeCell(ctx, cell, '#ffffff', 2.5 * u);
  }

  function handleGeom(cell, u) {
    const o = cell.outer;
    return {
      corners: [[o.x, o.y], [o.x + o.w, o.y], [o.x + o.w, o.y + o.h], [o.x, o.y + o.h]],
      rot: [0, o.y - 24 * u],
      top: [0, o.y],
    };
  }

  function drawHandles(ctx, cell, u) {
    const h = handleGeom(cell, u);
    ctx.save();
    ctx.translate(cell.cx, cell.cy);
    ctx.rotate(cell.rot);
    ctx.lineWidth = 1.5 * u;
    ctx.strokeStyle = '#0a84ff';
    ctx.beginPath();
    ctx.moveTo(h.top[0], h.top[1]);
    ctx.lineTo(h.rot[0], h.rot[1]);
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(h.rot[0], h.rot[1], 6 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const hs = 5 * u;
    for (const [x, y] of h.corners) {
      ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
      ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
    }
    ctx.restore();
  }

  function hitHandle(cell, x, y, u) {
    const [lx, ly] = Rn.toLocal(cell, x, y);
    const h = handleGeom(cell, u);
    if (Math.hypot(lx - h.rot[0], ly - h.rot[1]) < 10 * u) return 'rotate';
    for (const [cx, cy] of h.corners) if (Math.abs(lx - cx) < 9 * u && Math.abs(ly - cy) < 9 * u) return 'resize';
    return null;
  }

  function hitCell(x, y) {
    if (isScatter()) {
      const order = Rn.drawOrder(model()).reverse();
      for (const i of order) if (Rn.cellContains(R.cells[i], x, y)) return i;
      return -1;
    }
    for (let i = 0; i < R.cells.length; i++) if (Rn.cellContains(R.cells[i], x, y)) return i;
    return -1;
  }

  // Is the point over the (possibly larger than the tile) photo of the selected tile?
  function overSelectedPhoto(x, y) {
    const i = R.sel, cell = R.cells[i], slot = S.slots[i];
    if (!cell || !slot || !slot.photo) return false;
    if (Rn.cellContains(cell, x, y)) return true;
    const photo = R.photoMap.get(slot.photo);
    let [lx, ly] = cell.scatter ? Rn.toLocal(cell, x, y) : [x, y];
    const p = Rn.placement(photo.w, photo.h, cell.box, slot);
    return Math.abs(lx - p.cx) <= p.dw / 2 && Math.abs(ly - p.cy) <= p.dh / 2;
  }

  function mmPerPx() { return 1 / view().s; }

  function updateHint() {
    const el = $('hint');
    let t = '';
    const d = R.drag;
    if (d && d.kind === 'swap') t = 'Drop on another tile to swap the two photos';
    else if (R.crop) t = 'Drag to reposition · pinch or ⌘-scroll to zoom · press Esc when done';
    else if (R.sel >= 0 && S.slots[R.sel] && S.slots[R.sel].photo) {
      t = isScatter()
        ? 'Drag to move · corners resize · round handle rotates · ⌥-drag swaps · double-click to crop'
        : 'Drag onto another tile to swap · double-click to crop';
    }
    if (el.textContent !== t) el.textContent = t;
  }

  function setCursor(c) {
    const cls = c || '';
    if (canvas.className !== cls) canvas.className = cls;
  }

  function updateHover(x, y) {
    if (R.space) { setCursor('grab'); return; }
    const u = mmPerPx();
    if (R.crop && R.sel >= 0 && overSelectedPhoto(x, y)) { setCursor('move'); return; }
    if (isScatter() && R.sel >= 0 && !R.crop) {
      const h = hitHandle(R.cells[R.sel], x, y, u);
      if (h) { setCursor(h); if (R.hover !== -1) { R.hover = -1; render(); } return; }
    }
    const i = hitCell(x, y);
    if (i !== R.hover) { R.hover = i; render(); }
    setCursor(i >= 0 ? (isScatter() ? 'move' : 'grab') : '');
  }

  // ---------------------------------------------------------------------------
  // Pointer interaction
  // ---------------------------------------------------------------------------

  function select(i) {
    if (i !== R.sel) {
      R.sel = i;
      R.crop = false;
      renderInspector();
      highlightTray();
    }
    render();
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = toPaper(e);
    const start = { x, y, cx: e.clientX, cy: e.clientY };
    if (e.button === 1 || R.space) {
      R.drag = { kind: 'view', start, px: R.view.px, py: R.view.py };
      setCursor('grabbing');
      return;
    }
    if (R.crop && R.sel >= 0) {
      if (overSelectedPhoto(x, y)) {
        R.drag = { kind: 'pan', start, slot: { ...S.slots[R.sel] } };
        return;
      }
      setCrop(false);
    }
    if (isScatter() && R.sel >= 0) {
      const h = hitHandle(R.cells[R.sel], x, y, mmPerPx());
      if (h) {
        R.drag = { kind: h, start, i: R.sel, item: { ...S.items[R.sel] }, cell: R.cells[R.sel] };
        return;
      }
    }
    const i = hitCell(x, y);
    if (i < 0) {
      select(-1);
      R.drag = { kind: 'view', start, px: R.view.px, py: R.view.py };
      return;
    }
    select(i);
    R.drag = { kind: 'pending', start, i, alt: e.altKey };
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = toPaper(e);
    const d = R.drag;
    if (!d) { updateHover(x, y); return; }
    const dxPx = e.clientX - d.start.cx, dyPx = e.clientY - d.start.cy;
    const L = S.layout, C = content();
    if (d.kind === 'pending') {
      if (Math.hypot(dxPx, dyPx) < 4) return;
      if (isScatter() && !d.alt) {
        d.kind = 'move';
        d.item = { ...S.items[d.i] };
      } else if (S.slots[d.i] && S.slots[d.i].photo) {
        d.kind = 'swap';
        setCursor('grabbing');
      } else {
        d.kind = 'none';
      }
    }
    switch (d.kind) {
      case 'view':
        R.view.px = d.px + dxPx;
        R.view.py = d.py + dyPx;
        setCursor('grabbing');
        render();
        break;
      case 'move': {
        const it = S.items[d.i];
        it.x = clamp(d.item.x + (x - d.start.x) / C.w, -0.05, 1.05);
        it.y = clamp(d.item.y + (y - d.start.y) / C.h, -0.05, 1.05);
        recalc();
        break;
      }
      case 'swap': {
        const t = hitCell(x, y);
        R.dropTarget = t === d.i ? -1 : t;
        R.dragPos = [x, y];
        render();
        break;
      }
      case 'pan': {
        const slot = S.slots[R.sel], cell = R.cells[R.sel];
        const photo = R.photoMap.get(slot.photo);
        let dx = x - d.start.x, dy = y - d.start.y;
        if (cell.scatter) {
          const c = Math.cos(cell.rot), s = Math.sin(cell.rot);
          [dx, dy] = [dx * c + dy * s, -dx * s + dy * c];
        }
        const p = Rn.placement(photo.w, photo.h, cell.box, { ...d.slot, zoom: slot.zoom });
        slot.ox = p.ex > 1e-6 ? clamp(d.slot.ox + dx / p.ex, -1, 1) : 0;
        slot.oy = p.ey > 1e-6 ? clamp(d.slot.oy + dy / p.ey, -1, 1) : 0;
        render();
        break;
      }
      case 'resize': {
        const c = d.cell, it = S.items[d.i];
        const r0 = Math.hypot(d.start.x - c.cx, d.start.y - c.cy) || 1;
        const r1 = Math.hypot(x - c.cx, y - c.cy);
        it.s = clamp((d.item.s * r1) / r0, 0.15, 5);
        recalc();
        updateInspectorValues();
        break;
      }
      case 'rotate': {
        const c = d.cell, it = S.items[d.i];
        const a0 = Math.atan2(d.start.y - c.cy, d.start.x - c.cx);
        const a1 = Math.atan2(y - c.cy, x - c.cx);
        let deg = d.item.t * L.tilt + d.item.dr + (a1 - a0) / DEG;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        it.dr = deg - d.item.t * L.tilt;
        recalc();
        updateInspectorValues();
        break;
      }
    }
  });

  function endDrag() {
    const d = R.drag;
    R.drag = null;
    if (d && d.kind === 'swap' && R.dropTarget >= 0) {
      const a = d.i, b = R.dropTarget;
      [S.slots[a], S.slots[b]] = [S.slots[b], S.slots[a]];
      if (isScatter()) R.cells = computeCells();
      R.sel = b;
      renderInspector();
      highlightTray();
    }
    R.dropTarget = -1;
    R.dragPos = null;
    render();
    settle();
  }

  canvas.addEventListener('pointerup', (e) => {
    endDrag();
    updateHover(...toPaper(e));
  });
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!R.drag && R.hover !== -1) { R.hover = -1; render(); }
  });

  canvas.addEventListener('dblclick', (e) => {
    const [x, y] = toPaper(e);
    const i = hitCell(x, y);
    if (i < 0) return;
    select(i);
    if (S.slots[i] && S.slots[i].photo) setCrop(true);
    else if (!isScatter()) { R.pendingTarget = i; $('fileInput').click(); }
  });

  function zoomViewAt(factor, clientX, clientY) {
    const v0 = view();
    const r = canvas.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const px = (mx - v0.tx) / v0.s, py = (my - v0.ty) / v0.s;
    R.view.zoom = clamp(R.view.zoom * factor, 0.25, 16);
    const s1 = v0.fit * R.view.zoom;
    R.view.px = mx - px * s1 - (v0.cw - S.paper.w * s1) / 2;
    R.view.py = my - py * s1 - (v0.ch - S.paper.h * s1) / 2;
    render();
  }

  function zoomViewCenter(factor) {
    const r = canvas.getBoundingClientRect();
    zoomViewAt(factor, r.left + r.width / 2, r.top + r.height / 2);
  }

  function fitView() {
    R.view = { zoom: 1, px: 0, py: 0 };
    render();
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch arrives as ctrl+wheel.
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.01));
      if (R.crop && R.sel >= 0) zoomPhoto(factor);
      else zoomViewAt(factor, e.clientX, e.clientY);
    } else {
      const k = e.deltaMode === 1 ? 16 : 1;
      R.view.px -= e.deltaX * k;
      R.view.py -= e.deltaY * k;
      render();
    }
  }, { passive: false });

  // Safari trackpad pinch (gesture events) — zoom the view or the photo being cropped.
  let gestureStart = 1;
  canvas.addEventListener('gesturestart', (e) => { e.preventDefault(); gestureStart = e.scale; });
  canvas.addEventListener('gesturechange', (e) => {
    e.preventDefault();
    const f = e.scale / gestureStart;
    gestureStart = e.scale;
    if (R.crop && R.sel >= 0) zoomPhoto(f);
    else zoomViewAt(f, e.clientX, e.clientY);
  });
  canvas.addEventListener('gestureend', (e) => e.preventDefault());

  // Photos dragged from the tray onto the collage.
  canvas.addEventListener('dragover', (e) => {
    if (!R.trayDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const [x, y] = toPaper(e);
    const t = hitCell(x, y);
    if (t !== R.dropTarget) { R.dropTarget = t; render(); }
  });
  canvas.addEventListener('dragleave', () => {
    if (R.dropTarget !== -1) { R.dropTarget = -1; render(); }
  });
  canvas.addEventListener('drop', (e) => {
    if (!R.trayDrag) return;
    e.preventDefault();
    const id = R.trayDrag;
    R.trayDrag = null;
    const [x, y] = toPaper(e);
    const t = hitCell(x, y);
    R.dropTarget = -1;
    if (t >= 0) placePhoto(t, id);
    else if (isScatter()) addScatterAt(x, y, id);
    else render();
  });

  // Files and folders dropped from Finder anywhere in the window.
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  async function filesFromDrop(dt) {
    const items = dt.items ? [...dt.items] : [];
    const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        await new Promise((res) => entry.file((f) => { out.push(f); res(); }, res));
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res) => reader.readEntries(res, () => res([])));
          for (const en of batch) await walk(en);
        } while (batch.length);
      }
    };
    for (const en of entries) await walk(en);
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return out;
  }

  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    wrap.classList.add('dropping');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) wrap.classList.remove('dropping');
  });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    wrap.classList.remove('dropping');
    let target = null;
    if (e.target === canvas && !isScatter()) {
      const t = hitCell(...toPaper(e));
      if (t >= 0 && !S.slots[t].photo) target = t;
    }
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length === 1 && /\.collage$/i.test(files[0].name)) { openProject(files[0]); return; }
    importFiles(files, target);
  });

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    if ($('exportDialog').open) return;
    const a = document.activeElement;
    const typing = a && ((a.tagName === 'INPUT' && !['range', 'checkbox', 'color', 'button'].includes(a.type)) || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA');
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && key === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (mod && key === 'o') { e.preventDefault(); $('fileInput').click(); return; }
    if (mod && key === 's') { e.preventDefault(); saveProject(); return; }
    if (mod && key === 'e') { e.preventDefault(); openExport(); return; }
    if (typing || mod) return;
    if (a && a.type === 'range' && e.key.startsWith('Arrow')) return;
    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (!R.space) { R.space = true; setCursor('grab'); }
        break;
      case 'Escape':
        if (R.crop) setCrop(false);
        else select(-1);
        break;
      case 'Enter':
        if (R.sel >= 0) setCrop(!R.crop);
        break;
      case 'Backspace':
      case 'Delete':
        if (R.sel >= 0) { e.preventDefault(); clearTile(R.sel); }
        break;
      case 'r':
      case 'R':
        rotateTile();
        break;
      case '+':
      case '=':
        zoomViewCenter(1.25);
        break;
      case '-':
        zoomViewCenter(0.8);
        break;
      case '0':
        fitView();
        break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') { R.space = false; setCursor(''); }
  });

  // ---------------------------------------------------------------------------
  // Left panel controls
  // ---------------------------------------------------------------------------

  function paperPx() {
    const k = S.paper.dpi / 25.4;
    return { W: Math.round(S.paper.w * k), H: Math.round(S.paper.h * k) };
  }

  function tooLarge() {
    const { W, H } = paperPx();
    return W > MAX_SIDE || H > MAX_SIDE || W * H > MAX_AREA;
  }

  function fmtMm(v) { return `${+(+v).toFixed(1)} mm`; }

  function syncControls() {
    const L = S.layout, P = S.paper;
    document.querySelectorAll('#layoutButtons button').forEach((b) => b.classList.toggle('on', b.dataset.layout === L.type));
    document.querySelectorAll('[data-for]').forEach((el) => {
      if (el.dataset.for.split(' ').includes(L.type)) el.removeAttribute('data-hidden');
      else el.setAttribute('data-hidden', '');
    });
    const setHidden = (el, hidden) => (hidden ? el.setAttribute('data-hidden', '') : el.removeAttribute('data-hidden'));
    setHidden($('rowsField'), !(L.type === 'squares' && L.shape === 'rect'));
    setHidden($('edgesField'), !(['diamonds', 'hexagons'].includes(L.type) && L.shape === 'rect'));
    document.querySelectorAll('#shapeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.shape === L.shape));
    document.querySelectorAll('#frameSeg button').forEach((b) => b.classList.toggle('on', b.dataset.frame === L.frame));

    const colsMax = Math.max(40, L.cols);
    $('cols').max = colsMax;
    $('cols').value = L.cols;
    $('colsOut').textContent = L.cols;
    $('rows').max = Math.max(60, L.rows);
    $('rows').value = L.rows;
    $('rowsOut').textContent = L.rows;
    $('mixed').value = L.mixed;
    $('mixedOut').textContent = `${Math.round(L.mixed * 100)}%`;
    $('fillEdges').checked = L.fillEdges;
    $('repeat').checked = L.repeat;
    $('scSize').value = L.size;
    $('scSizeOut').textContent = `${Math.round(L.size * 100)}%`;
    $('scTilt').value = L.tilt;
    $('scTiltOut').textContent = `±${L.tilt}°`;
    $('shadow').checked = L.shadow;
    $('gap').value = L.gap;
    $('gapOut').textContent = fmtMm(L.gap);
    $('radius').value = L.radius;
    $('radiusOut').textContent = fmtMm(L.radius);
    $('bgColor').value = L.bg;
    let matched = false;
    document.querySelectorAll('#bgSwatches button').forEach((b) => {
      const on = b.dataset.color.toLowerCase() === L.bg.toLowerCase();
      matched = matched || on;
      b.classList.toggle('on', on);
    });
    document.querySelector('.custom-color').classList.toggle('on', !matched);

    $('paperSel').value = P.preset;
    setHidden($('customSize'), P.preset !== 'custom');
    $('customW').value = +(P.w / 10).toFixed(1);
    $('customH').value = +(P.h / 10).toFixed(1);
    const portrait = P.h >= P.w;
    document.querySelectorAll('#orientSeg button').forEach((b) => b.classList.toggle('on', (b.dataset.orient === 'portrait') === portrait));
    $('margin').value = P.margin;
    $('marginOut').textContent = fmtMm(P.margin);
    $('dpi').value = String(P.dpi);
    const { W, H } = paperPx();
    $('paperInfo').innerHTML = `${(P.w / 10).toFixed(1)} × ${(P.h / 10).toFixed(1)} cm → exports at ${W.toLocaleString()} × ${H.toLocaleString()} px (${((W * H) / 1e6).toFixed(0)} MP)` +
      (tooLarge() ? '<br><span style="color:var(--warn)">Too large for the browser at this resolution — choose a lower DPI.</span>' : '');

    $('btnFit').classList.toggle('on', L.auto);
    $('btnFit').textContent = L.auto ? 'Fits photos ✓' : 'Fit to photos';
    $('tileInfo').textContent = tileInfo();
    $('emptyState').hidden = S.photos.length > 0;
    updateUndoButtons();
  }

  function tileInfo() {
    const t = S.slots.length;
    const used = new Set(S.slots.map((s) => s.photo).filter(Boolean));
    const empty = S.slots.filter((s) => !s.photo).length;
    const repeated = t - empty - used.size;
    const unused = S.photos.length - used.size;
    const parts = [`${t} tile${t === 1 ? '' : 's'}`];
    if (repeated > 0) parts.push(`${repeated} repeated`);
    if (empty > 0) parts.push(`${empty} empty`);
    if (unused > 0) parts.push(`${unused} photo${unused === 1 ? '' : 's'} not used`);
    return parts.join(' · ');
  }

  // Bind a range slider: live updates while dragging, one undo step when released.
  function slider(id, apply) {
    const el = $(id);
    el.addEventListener('input', () => apply(parseFloat(el.value)));
    el.addEventListener('change', settle);
  }

  function bindControls() {
    document.querySelectorAll('#layoutButtons button').forEach((b) => b.addEventListener('click', () => setLayout(b.dataset.layout)));
    document.querySelectorAll('#shapeSeg button').forEach((b) =>
      b.addEventListener('click', () => {
        S.layout.shape = b.dataset.shape;
        R.sel = -1;
        refresh({ refit: true });
        settle();
      }));
    document.querySelectorAll('#frameSeg button').forEach((b) =>
      b.addEventListener('click', () => {
        S.layout.frame = b.dataset.frame;
        refresh();
        settle();
      }));

    slider('cols', (v) => { S.layout.cols = v; S.layout.auto = false; refresh(); });
    slider('rows', (v) => { S.layout.rows = v; S.layout.auto = false; refresh(); });
    slider('mixed', (v) => { S.layout.mixed = v; refresh({ refit: true }); });
    slider('scSize', (v) => { S.layout.size = v; refresh(); });
    slider('scTilt', (v) => { S.layout.tilt = v; refresh(); });
    slider('gap', (v) => { S.layout.gap = v; refresh(); });
    slider('radius', (v) => { S.layout.radius = v; refresh(); });
    slider('margin', (v) => { S.paper.margin = v; refresh({ refit: true }); });

    $('fillEdges').addEventListener('change', (e) => { S.layout.fillEdges = e.target.checked; refresh({ refit: true }); settle(); });
    $('repeat').addEventListener('change', (e) => {
      S.layout.repeat = e.target.checked;
      rebuildSlots(R.cells.length);
      refresh();
      settle();
    });
    $('shadow').addEventListener('change', (e) => { S.layout.shadow = e.target.checked; refresh(); settle(); });
    $('btnReroll').addEventListener('click', () => {
      S.layout.seed = Math.floor(Math.random() * 1e9);
      refresh({ refit: true });
      settle();
    });
    $('btnFit').addEventListener('click', () => {
      S.layout.auto = true;
      refresh({ refit: true });
      settle();
    });
    $('btnRescatter').addEventListener('click', () => {
      S.items = freshScatterItems(S.slots.length);
      R.sel = -1;
      refresh();
      settle();
    });

    document.querySelectorAll('#bgSwatches button').forEach((b) =>
      b.addEventListener('click', () => { S.layout.bg = b.dataset.color; refresh(); settle(); }));
    $('bgColor').addEventListener('input', (e) => { S.layout.bg = e.target.value; refresh(); });
    $('bgColor').addEventListener('change', settle);

    const sel = $('paperSel');
    sel.innerHTML = PAPERS.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
    sel.addEventListener('change', () => {
      const p = PAPERS.find((x) => x.id === sel.value);
      S.paper.preset = p.id;
      if (p.w) {
        const landscape = S.paper.w > S.paper.h;
        S.paper.w = landscape ? Math.max(p.w, p.h) : Math.min(p.w, p.h);
        S.paper.h = landscape ? Math.min(p.w, p.h) : Math.max(p.w, p.h);
      }
      refresh({ refit: true });
      fitView();
      settle();
    });
    const custom = () => {
      const w = clamp(parseFloat($('customW').value) * 10 || S.paper.w, 50, 3000);
      const h = clamp(parseFloat($('customH').value) * 10 || S.paper.h, 50, 3000);
      S.paper.w = w;
      S.paper.h = h;
      refresh({ refit: true });
      fitView();
      settle();
    };
    $('customW').addEventListener('change', custom);
    $('customH').addEventListener('change', custom);
    document.querySelectorAll('#orientSeg button').forEach((b) =>
      b.addEventListener('click', () => {
        const wantPortrait = b.dataset.orient === 'portrait';
        const { w, h } = S.paper;
        if ((h >= w) !== wantPortrait) { S.paper.w = h; S.paper.h = w; }
        refresh({ refit: true });
        fitView();
        settle();
      }));
    $('dpi').addEventListener('change', (e) => { S.paper.dpi = parseInt(e.target.value, 10); refresh(); settle(); });

    // Top bar
    $('btnAdd').addEventListener('click', () => $('fileInput').click());
    $('btnAddEmpty').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      const t = R.pendingTarget;
      R.pendingTarget = null;
      if (files.length) importFiles(files, t);
    });
    $('btnShuffle').addEventListener('click', shuffle);
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnNew').addEventListener('click', newProject);
    $('btnOpen').addEventListener('click', () => $('projectInput').click());
    $('projectInput').addEventListener('change', (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) openProject(f);
    });
    $('btnSave').addEventListener('click', saveProject);
    $('btnExport').addEventListener('click', openExport);
    $('zoomIn').addEventListener('click', () => zoomViewCenter(1.25));
    $('zoomOut').addEventListener('click', () => zoomViewCenter(0.8));
    $('zoomFit').addEventListener('click', fitView);

    new ResizeObserver(render).observe(wrap);
    window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); if (St.ok) St.saveState(JSON.parse(JSON.stringify(S))); });
  }

  // ---------------------------------------------------------------------------
  // Inspector (right panel)
  // ---------------------------------------------------------------------------

  function tipsHtml() {
    const autosave = St.ok
      ? 'Your work is saved automatically in this browser.'
      : 'Autosave is not available here — use <b>Save…</b> to keep your work. (Opening the page in Chrome enables autosave.)';
    return `<div class="insp">
      <h4>How to edit</h4>
      <ul class="tips">
        <li><b>Swap photos:</b> drag a tile onto another tile.</li>
        <li><b>Crop:</b> double-click a tile, then drag the photo. Pinch or ⌘-scroll to zoom it.</li>
        <li><b>Put a specific photo somewhere:</b> drag it from the tray at the bottom onto a tile.</li>
        <li><b>Zoom the view:</b> pinch on the trackpad, two-finger scroll to move around, or hold <span class="kbd">Space</span> and drag.</li>
        <li><b>Scattered layout:</b> drag photos to move them, use the corners to resize and the round handle to rotate. <span class="kbd">⌥</span>-drag swaps two photos.</li>
        <li><span class="kbd">⌘Z</span> undo · <span class="kbd">⌫</span> remove · <span class="kbd">R</span> rotate · <span class="kbd">Esc</span> deselect</li>
      </ul>
      <p class="muted small">${autosave}</p>
    </div>`;
  }

  function renderInspector() {
    const el = $('inspector');
    const i = R.sel;
    if (i < 0 || !R.cells[i]) { el.innerHTML = tipsHtml(); return; }
    const slot = S.slots[i];
    const photo = slot && slot.photo && R.photoMap.get(slot.photo);
    const scatter = isScatter();
    if (!photo) {
      el.innerHTML = `<div class="insp"><h4>Empty tile</h4>
        <p class="muted">Drag a photo onto this tile from the tray below, or double-click it to choose a file.</p></div>`;
      return;
    }
    const rec = R.images.get(photo.id);
    el.innerHTML = `<div class="insp">
      <img class="preview" src="${rec ? rec.thumbUrl : ''}" alt="">
      <div class="name">${esc(photo.name)}</div>
      <div class="muted small">${photo.w} × ${photo.h} px</div>
      <div class="quality" id="iQuality"></div>
      <div class="field">
        <label for="iZoom">Zoom <output id="iZoomOut"></output></label>
        <input type="range" id="iZoom" min="0.2" max="5" step="0.01">
      </div>
      <div class="row"><button class="btn" id="iCrop">Adjust crop</button></div>
      <div class="row">
        <button class="btn" id="iRotate" title="Rotate 90° (R)">⟳ Rotate</button>
        <button class="btn" id="iFlip" title="Mirror left–right">⇋ Flip</button>
      </div>
      <div class="row"><button class="btn" id="iReset">Reset crop</button></div>
      ${scatter ? `
      <div class="field">
        <label for="iSize">Size <output id="iSizeOut"></output></label>
        <input type="range" id="iSize" min="0.15" max="3" step="0.01">
      </div>
      <div class="field">
        <label for="iAngle">Angle <output id="iAngleOut"></output></label>
        <input type="range" id="iAngle" min="-180" max="180" step="1">
      </div>
      <div class="row">
        <button class="btn" id="iFront">Bring to front</button>
        <button class="btn" id="iBack">Send to back</button>
      </div>` : ''}
      <div class="row"><button class="btn danger" id="iRemove">${scatter ? 'Remove from collage' : 'Remove from tile'}</button></div>
    </div>`;

    const zoom = $('iZoom');
    zoom.addEventListener('input', () => {
      const s = selSlot();
      s.zoom = parseFloat(zoom.value);
      render();
      updateInspectorValues();
    });
    zoom.addEventListener('change', settle);
    $('iCrop').addEventListener('click', () => setCrop(!R.crop));
    $('iRotate').addEventListener('click', rotateTile);
    $('iFlip').addEventListener('click', flipTile);
    $('iReset').addEventListener('click', resetTile);
    $('iRemove').addEventListener('click', () => clearTile(R.sel));
    if (scatter) {
      const size = $('iSize'), angle = $('iAngle');
      size.addEventListener('input', () => { S.items[R.sel].s = parseFloat(size.value); recalc(); updateInspectorValues(); });
      size.addEventListener('change', settle);
      angle.addEventListener('input', () => {
        const it = S.items[R.sel];
        it.dr = parseFloat(angle.value) - it.t * S.layout.tilt;
        recalc();
        updateInspectorValues();
      });
      angle.addEventListener('change', settle);
      $('iFront').addEventListener('click', () => zOrder(true));
      $('iBack').addEventListener('click', () => zOrder(false));
    }
    setCrop(R.crop);
    updateInspectorValues();
  }

  function qualityText(dpi) {
    const d = Math.round(dpi);
    if (dpi >= 240) return { cls: '', text: `Print quality: sharp (${d} dpi)` };
    if (dpi >= 150) return { cls: '', text: `Print quality: good (${d} dpi)` };
    if (dpi >= 100) return { cls: 'low', text: `Print quality: fair (${d} dpi) — may look a little soft up close` };
    return { cls: 'low', text: `Print quality: low (${d} dpi) — will look blurry. Use a bigger tile or zoom out.` };
  }

  function updateInspectorValues() {
    const i = R.sel, slot = selSlot();
    const photo = slot && slot.photo && R.photoMap.get(slot.photo);
    if (!photo || !$('iZoom')) return;
    const cell = R.cells[i];
    const p = Rn.placement(photo.w, photo.h, cell.box, slot);
    const zoom = $('iZoom');
    zoom.min = Math.floor(p.minZoom * 100) / 100;
    zoom.value = slot.zoom;
    $('iZoomOut').textContent = `${Math.round(slot.zoom * 100)}%`;
    const q = qualityText(Rn.effectiveDpi(photo, cell.box, slot));
    const qe = $('iQuality');
    qe.className = `quality ${q.cls}`;
    qe.textContent = q.text;
    if (isScatter() && $('iSize')) {
      const it = S.items[i];
      $('iSize').value = it.s;
      $('iSizeOut').textContent = `${Math.round(it.s * 100)}%`;
      let ang = it.t * S.layout.tilt + it.dr;
      ang = ((ang + 180) % 360 + 360) % 360 - 180;
      $('iAngle').value = ang;
      $('iAngleOut').textContent = `${Math.round(ang)}°`;
    }
  }

  // ---------------------------------------------------------------------------
  // Tray (photo library)
  // ---------------------------------------------------------------------------

  function createThumb(p) {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.draggable = true;
    el.title = p.name;
    const rec = R.images.get(p.id);
    el.innerHTML = `<img alt="" src="${rec ? rec.thumbUrl : ''}"><span class="badge"></span><button class="del" title="Remove this photo">×</button>`;
    el.querySelector('.del').addEventListener('click', (e) => { e.stopPropagation(); removePhoto(p.id); });
    el.addEventListener('click', () => {
      const i = S.slots.findIndex((s) => s.photo === p.id);
      if (i >= 0) select(i);
      else toast('This photo is not in the collage yet — drag it onto a tile.');
    });
    el.addEventListener('dragstart', (e) => {
      R.trayDrag = p.id;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('application/x-collage-photo', p.id);
      if (rec) {
        const img = el.querySelector('img');
        e.dataTransfer.setDragImage(img, 40, 40);
      }
    });
    el.addEventListener('dragend', () => {
      R.trayDrag = null;
      if (R.dropTarget !== -1) { R.dropTarget = -1; render(); }
    });
    return el;
  }

  function renderTray() {
    const list = $('trayList');
    const counts = new Map();
    for (const s of S.slots) if (s.photo) counts.set(s.photo, (counts.get(s.photo) || 0) + 1);
    for (const [id, el] of R.thumbEls) {
      if (!R.photoMap.has(id)) { el.remove(); R.thumbEls.delete(id); }
    }
    S.photos.forEach((p, idx) => {
      let el = R.thumbEls.get(p.id);
      if (!el) { el = createThumb(p); R.thumbEls.set(p.id, el); }
      if (list.children[idx] !== el) list.insertBefore(el, list.children[idx] || null);
      const c = counts.get(p.id) || 0;
      el.classList.toggle('unused', c === 0);
      const badge = el.querySelector('.badge');
      badge.textContent = c === 0 ? 'Not used' : c > 1 ? `×${c}` : '';
      badge.hidden = c === 1;
    });
    const unused = S.photos.filter((p) => !counts.has(p.id)).length;
    $('trayCount').textContent = S.photos.length
      ? `${S.photos.length} photo${S.photos.length === 1 ? '' : 's'}${unused ? ` · ${unused} not used` : ''}`
      : '';
    highlightTray();
  }

  function highlightTray() {
    const slot = selSlot();
    const id = slot && slot.photo;
    for (const [pid, el] of R.thumbEls) el.classList.toggle('sel', pid === id);
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let toastTimer = 0;
  function toast(msg, sticky) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(hideToast, 3500);
  }
  function hideToast() { $('toast').classList.remove('show'); }

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  const today = () => new Date().toISOString().slice(0, 10);

  function saveProject() {
    if (!S.photos.length) { toast('Nothing to save yet — add some photos first.'); return; }
    const files = S.photos.map((p) => ({ id: p.id, blob: R.images.get(p.id).blob }));
    download(St.buildProject(S, files), `collage-${today()}.collage`);
    toast('Project saved to your Downloads folder. Use “Open…” to continue later.');
  }

  function sanitize(o) {
    const d = defaultState();
    const s = { ...d, ...o, paper: { ...d.paper, ...(o.paper || {}) }, layout: { ...d.layout, ...(o.layout || {}) } };
    s.photos = (s.photos || []).filter((p) => R.images.has(p.id));
    const ids = new Set(s.photos.map((p) => p.id));
    s.slots = (s.slots || []).map((x) => ({ ...newSlot(null), ...x, photo: x.photo && ids.has(x.photo) ? x.photo : null }));
    s.items = s.items || [];
    if (s.layout.type === 'scatter') {
      s.items = s.items.slice(0, s.slots.length);
      while (s.items.length < s.slots.length) s.items.push(...G.newScatterItems(s.items, 1, 1, Math.random));
    }
    return s;
  }

  function clearRuntime() {
    for (const r of R.images.values()) URL.revokeObjectURL(r.thumbUrl);
    R.images.clear();
    R.hires.clear();
    R.dbIds.clear();
    for (const el of R.thumbEls.values()) el.remove();
    R.thumbEls.clear();
    R.sel = -1;
    R.crop = false;
    R.undo = [];
    R.redo = [];
  }

  async function newProject() {
    if (S.photos.length && !confirm('Start a new collage? The current one will be cleared.\n\nUse “Save…” first if you want to keep it.')) return;
    clearRuntime();
    await St.clear();
    const keepPaper = S.paper;
    S = defaultState();
    S.paper = keepPaper;
    refresh();
    fitView();
    R.baseline = snapshot();
    updateUndoButtons();
  }

  async function openProject(file) {
    let proj;
    try {
      proj = await St.readProject(file);
    } catch (e) {
      toast(e.message || 'Could not open that file.');
      return;
    }
    if (S.photos.length && !confirm('Open this project? The current collage will be replaced.')) return;
    clearRuntime();
    await St.clear();
    const metas = new Map((proj.state.photos || []).map((p) => [p.id, p]));
    let done = 0, failed = 0;
    toast(`Opening project… 0 / ${proj.files.length}`, true);
    await pool(proj.files, 3, async (f) => {
      const meta = metas.get(f.id) || { name: 'photo' };
      try {
        await processPhoto(f.blob, meta.name, f.id, meta.key);
      } catch (e) {
        failed++;
      }
      done++;
      toast(`Opening project… ${done} / ${proj.files.length}`, true);
    });
    S = sanitize(proj.state);
    refresh();
    fitView();
    R.baseline = snapshot();
    updateUndoButtons();
    syncDb();
    toast(failed ? `Opened, but ${failed} photo(s) could not be read.` : 'Project opened.');
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  const ex = { format: 'jpeg', quality: 0.92, running: false, cancel: false };

  function lowResCount() {
    let n = 0;
    S.slots.forEach((slot, i) => {
      const photo = slot.photo && R.photoMap.get(slot.photo);
      if (photo && R.cells[i] && Rn.effectiveDpi(photo, R.cells[i].box, slot) < 150) n++;
    });
    return n;
  }

  function openExport() {
    if (!S.photos.length) { toast('Add some photos first.'); return; }
    const { W, H } = paperPx();
    const preset = PAPERS.find((p) => p.id === S.paper.preset);
    const name = preset && preset.w ? preset.label.split(' — ')[0] : 'Custom';
    $('exportInfo').innerHTML = `<b>${esc(name)}</b>, ${(S.paper.w / 10).toFixed(1)} × ${(S.paper.h / 10).toFixed(1)} cm at ${S.paper.dpi} DPI<br>
      <span class="muted">${W.toLocaleString()} × ${H.toLocaleString()} pixels</span>`;
    const warns = [];
    if (tooLarge()) warns.push('This is too large for the browser to create. Lower the print resolution in the Paper section.');
    const low = lowResCount();
    if (low) warns.push(`${low} photo${low === 1 ? '' : 's'} will look soft when printed this big (under 150 dpi). Select a tile to see its print quality.`);
    $('exportWarn').innerHTML = warns.map(esc).join('<br>');
    $('exportGo').disabled = tooLarge();
    $('exportProgress').hidden = true;
    syncExportControls();
    $('exportDialog').showModal();
  }

  function syncExportControls() {
    document.querySelectorAll('#formatSeg button').forEach((b) => b.classList.toggle('on', b.dataset.format === ex.format));
    $('qualityField').hidden = ex.format !== 'jpeg';
    $('quality').value = ex.quality;
    $('qualityOut').textContent = `${Math.round(ex.quality * 100)}%`;
    $('formatHint').textContent = ex.format === 'jpeg'
      ? 'Best for printing and sharing — much smaller files.'
      : 'Lossless, but files are very large. Most print shops prefer JPEG.';
  }

  function bindExport() {
    document.querySelectorAll('#formatSeg button').forEach((b) =>
      b.addEventListener('click', () => { ex.format = b.dataset.format; syncExportControls(); }));
    $('quality').addEventListener('input', (e) => { ex.quality = parseFloat(e.target.value); syncExportControls(); });
    $('exportCancel').addEventListener('click', () => {
      if (ex.running) ex.cancel = true;
      else $('exportDialog').close();
    });
    $('exportDialog').addEventListener('cancel', (e) => { if (ex.running) { e.preventDefault(); ex.cancel = true; } });
    $('exportGo').addEventListener('click', async () => {
      if (ex.running) return;
      ex.running = true;
      ex.cancel = false;
      $('exportGo').disabled = true;
      $('exportGo').textContent = 'Exporting…';
      const bar = $('exportProgress');
      bar.hidden = false;
      const setP = (f) => { bar.firstElementChild.style.width = `${Math.round(f * 100)}%`; };
      setP(0);
      try {
        const blob = await renderExport(ex.format, ex.quality, setP, () => ex.cancel);
        setP(1);
        const ext = ex.format === 'png' ? 'png' : 'jpg';
        const preset = PAPERS.find((p) => p.id === S.paper.preset);
        const size = preset && preset.w ? preset.id : `${Math.round(S.paper.w / 10)}x${Math.round(S.paper.h / 10)}cm`;
        download(blob, `collage-${size}-${S.paper.dpi}dpi.${ext}`);
        $('exportDialog').close();
        toast(`Exported (${(blob.size / 1e6).toFixed(1)} MB) — check your Downloads folder.`);
      } catch (e) {
        if (e.message !== 'cancelled') {
          console.error(e);
          $('exportWarn').textContent = e.message === 'too-big'
            ? 'Your browser could not create an image this large. Lower the print resolution and try again.'
            : `Export failed: ${e.message}`;
        }
      } finally {
        ex.running = false;
        $('exportGo').disabled = tooLarge();
        $('exportGo').textContent = 'Export';
        if (!$('exportDialog').open) bar.hidden = true;
      }
    });
  }

  const nextFrame = () => new Promise((r) => setTimeout(r, 0));

  // Draw the collage at full print resolution, using the original photo files.
  async function renderExport(format, quality, progress, cancelled) {
    const dpi = S.paper.dpi;
    const { W, H } = paperPx();
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    if (!ctx) throw new Error('too-big');
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(W - 1, H - 1, 1, 1);
    if (ctx.getImageData(W - 1, H - 1, 1, 1).data[0] !== 255) { cv.width = cv.height = 1; throw new Error('too-big'); }
    try {
      ctx.setTransform(W / S.paper.w, 0, 0, H / S.paper.h, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const m = model();
      const pxPerMm = W / S.paper.w;
      ctx.fillStyle = m.bg;
      ctx.fillRect(0, 0, m.W, m.H);
      ctx.save();
      ctx.beginPath();
      ctx.rect(m.C.x, m.C.y, m.C.w, m.C.h);
      ctx.clip();

      let order = Rn.drawOrder(m).filter((i) => m.slots[i] && m.slots[i].photo && R.images.has(m.slots[i].photo));
      if (!isScatter()) {
        // Tiles don't overlap, so group repeats of the same photo to decode each file once.
        const first = new Map();
        order.forEach((i) => { const id = m.slots[i].photo; if (!first.has(id)) first.set(id, first.size); });
        order.sort((a, b) => first.get(m.slots[a].photo) - first.get(m.slots[b].photo));
      }
      const ids = order.map((i) => m.slots[i].photo);
      const last = new Map();
      ids.forEach((id, k) => last.set(id, k));
      const cache = new Map();
      const get = (id) => {
        if (!cache.has(id)) {
          const p = loadImage(R.images.get(id).blob);
          p.catch(() => {});
          cache.set(id, p);
        }
        return cache.get(id);
      };
      for (let k = 0; k < order.length; k++) {
        if (cancelled()) throw new Error('cancelled');
        for (let j = k + 1, n = 0; j < ids.length && n < 2; j++) {
          if (!cache.has(ids[j])) { get(ids[j]); n++; }
        }
        const id = ids[k];
        let img;
        try {
          img = await get(id);
        } catch (e) {
          img = R.images.get(id).preview; // fall back to the preview if the original can't be decoded
        }
        Rn.drawCell(ctx, m, order[k], img, { pxScale: pxPerMm, editor: false });
        if (last.get(id) === k) {
          const p = cache.get(id);
          cache.delete(id);
          p.then(releaseImage, () => {});
        }
        progress(((k + 1) / order.length) * 0.85);
        if (k % 3 === 2) await nextFrame();
      }
      for (const p of cache.values()) p.then(releaseImage, () => {});
      ctx.restore();
      progress(0.9);
      await nextFrame();
      const type = format === 'png' ? 'image/png' : 'image/jpeg';
      const blob = await canvasBlob(cv, type, quality);
      return await St.withDpi(blob, dpi);
    } finally {
      cv.width = cv.height = 1;
    }
  }

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  async function init() {
    bindControls();
    bindExport();
    refresh();
    R.baseline = snapshot();
    const ok = await St.open();
    if (ok) {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      const [state, recs] = await Promise.all([St.loadState(), St.allPhotos()]);
      if (state) {
        if (recs.length) toast('Restoring your collage…', true);
        await pool(recs, 4, async (rec) => {
          try {
            const preview = await loadImage(rec.preview);
            R.images.set(rec.id, { blob: rec.blob, preview, previewBlob: rec.preview, thumbBlob: rec.thumb, thumbUrl: URL.createObjectURL(rec.thumb) });
            R.dbIds.add(rec.id);
          } catch (e) {
            console.warn('Could not restore photo', rec.name);
          }
        });
        S = sanitize(state);
        refresh();
        R.baseline = snapshot();
        syncDb();
        if (recs.length) hideToast();
      } else if (recs.length) {
        // Photos without state: stale data from an interrupted session.
        await St.clear();
      }
    }
    renderInspector();
    updateUndoButtons();
  }

  // Exposed for automated tests.
  window.__collage = {
    get state() { return S; }, runtime: R, refresh, settle, importFiles, renderExport, setLayout,
    cellCenter(i) {
      const c = R.cells[i], v = view(), r = canvas.getBoundingClientRect();
      const x = c.scatter ? c.cx : c.box.x + c.box.w / 2, y = c.scatter ? c.cy : c.box.y + c.box.h / 2;
      return [r.left + v.tx + x * v.s, r.top + v.ty + y * v.s];
    },
  };

  init();
})();
