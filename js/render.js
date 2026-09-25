/*
 * Drawing of the collage. Works in millimetre units; the caller sets the canvas transform.
 * Used both for the on-screen editor (small previews) and for full-resolution export.
 */
(function () {
  'use strict';

  const G = window.CollageGeometry;
  const R = {};
  const DEG = Math.PI / 180;

  // Where a photo lands inside a box, given its crop adjustments.
  // iw/ih: natural photo size in pixels. Returns centre, drawn size and mm-per-source-pixel.
  R.placement = (iw, ih, box, slot) => {
    const turned = slot.rot % 180 !== 0;
    const w = turned ? ih : iw, h = turned ? iw : ih;
    const cover = Math.max(box.w / w, box.h / h);
    const contain = Math.min(box.w / w, box.h / h);
    const s = cover * slot.zoom;
    const dw = w * s, dh = h * s;
    const ex = Math.abs(dw - box.w) / 2, ey = Math.abs(dh - box.h) / 2;
    return {
      cx: box.x + box.w / 2 + slot.ox * ex,
      cy: box.y + box.h / 2 + slot.oy * ey,
      dw, dh, s, ex, ey,
      minZoom: contain / cover,
    };
  };

  // Effective print resolution of a photo in a box, in dots per inch.
  R.effectiveDpi = (photo, box, slot) => 25.4 / R.placement(photo.w, photo.h, box, slot).s;

  R.drawPhoto = (ctx, img, photo, box, slot) => {
    const p = R.placement(photo.w, photo.h, box, slot);
    ctx.translate(p.cx, p.cy);
    ctx.rotate(slot.rot * DEG);
    if (slot.flip) ctx.scale(-1, 1);
    const w = photo.w * p.s, h = photo.h * p.s;
    ctx.drawImage(img, -w / 2, -h / 2, w, h);
  };

  // Frame borders (mm) around a scattered photo of inner size w × h.
  R.frameBorders = (frame, w, h) => {
    const m = Math.min(w, h);
    if (frame === 'border') {
      const b = m * 0.045;
      return { l: b, t: b, r: b, b };
    }
    if (frame === 'polaroid') {
      const b = m * 0.06;
      return { l: b, t: b, r: b, b: m * 0.22 };
    }
    return { l: 0, t: 0, r: 0, b: 0 };
  };

  // Geometry of one scattered photo in mm. `n` is the total number of scattered photos.
  R.scatterCell = (item, photo, slot, C, n, L) => {
    let aspect = 1;
    if (photo) {
      const turned = slot.rot % 180 !== 0;
      aspect = turned ? photo.h / photo.w : photo.w / photo.h;
      aspect = Math.max(0.55, Math.min(1.8, aspect));
    }
    const area = ((C.w * C.h) / Math.max(1, n)) * 1.35 * L.size * L.size * item.s * item.s;
    const w = Math.sqrt(area * aspect), h = Math.sqrt(area / aspect);
    const b = R.frameBorders(L.frame, w, h);
    const ow = w + b.l + b.r, oh = h + b.t + b.b;
    return {
      scatter: true,
      cx: C.x + item.x * C.w,
      cy: C.y + item.y * C.h,
      rot: (item.t * L.tilt + item.dr) * DEG,
      outer: { x: -ow / 2, y: -oh / 2, w: ow, h: oh },
      box: { x: -ow / 2 + b.l, y: -oh / 2 + b.t, w, h },
      z: item.z,
      m: Math.min(ow, oh),
    };
  };

  // Convert a paper point into a scattered cell's local (unrotated) coordinates.
  R.toLocal = (cell, x, y) => {
    const dx = x - cell.cx, dy = y - cell.cy;
    const c = Math.cos(-cell.rot), s = Math.sin(-cell.rot);
    return [dx * c - dy * s, dx * s + dy * c];
  };

  R.cellContains = (cell, x, y) => {
    if (cell.scatter) {
      const [lx, ly] = R.toLocal(cell, x, y);
      const o = cell.outer;
      return lx >= o.x && lx <= o.x + o.w && ly >= o.y && ly <= o.y + o.h;
    }
    const b = cell.box;
    if (x < b.x || y < b.y || x > b.x + b.w || y > b.y + b.h) return false;
    return G.contains(cell.poly, x, y);
  };

  // Path of the cell's outline in paper coordinates (scatter: the outer frame).
  R.traceCell = (ctx, cell, radius) => {
    if (cell.scatter) {
      ctx.save();
      ctx.translate(cell.cx, cell.cy);
      ctx.rotate(cell.rot);
      const o = cell.outer;
      G.tracePath(ctx, G.rect(o.x, o.y, o.w, o.h), radius);
      ctx.restore();
    } else {
      G.tracePath(ctx, cell.poly, radius);
    }
  };

  // Draw a single cell. `img` may be null (not loaded / empty). o: {pxScale, editor}
  R.drawCell = (ctx, m, i, img, o) => {
    const cell = m.cells[i];
    const slot = m.slots[i];
    const photo = slot && slot.photo ? m.photos.get(slot.photo) : null;
    if (cell.scatter) return drawScatter(ctx, m, cell, slot, photo, img, o);
    ctx.save();
    G.tracePath(ctx, cell.poly, m.L.radius);
    if (photo && img) {
      ctx.clip();
      R.drawPhoto(ctx, img, photo, cell.box, slot);
    } else if (o.editor) {
      ctx.fillStyle = photo ? 'rgba(128,128,128,0.25)' : 'rgba(128,128,128,0.12)';
      ctx.fill();
    }
    ctx.restore();
  };

  function drawScatter(ctx, m, cell, slot, photo, img, o) {
    if (!photo && !o.editor) return;
    const L = m.L;
    ctx.save();
    ctx.translate(cell.cx, cell.cy);
    ctx.rotate(cell.rot);
    const out = cell.outer, box = cell.box;
    const radius = L.radius;
    const hasFrame = L.frame !== 'none';
    if (!photo) {
      G.tracePath(ctx, G.rect(out.x, out.y, out.w, out.h), radius);
      ctx.fillStyle = 'rgba(128,128,128,0.10)';
      ctx.fill();
      ctx.setLineDash([2 / o.pxScale * 3, 2 / o.pxScale * 3]);
      ctx.lineWidth = 1 / o.pxScale;
      ctx.strokeStyle = 'rgba(128,128,128,0.6)';
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (hasFrame || L.shadow) {
      G.tracePath(ctx, G.rect(out.x, out.y, out.w, out.h), radius);
      if (L.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.35)';
        ctx.shadowBlur = cell.m * 0.05 * o.pxScale;
        ctx.shadowOffsetY = cell.m * 0.012 * o.pxScale;
      }
      ctx.fillStyle = hasFrame ? (L.frameColor || '#ffffff') : '#888';
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
    G.tracePath(ctx, G.rect(box.x, box.y, box.w, box.h), hasFrame ? radius * 0.4 : radius);
    if (img) {
      ctx.clip();
      R.drawPhoto(ctx, img, photo, box, slot);
    } else {
      ctx.fillStyle = 'rgba(128,128,128,0.3)';
      ctx.fill();
    }
    ctx.restore();
  }

  // Indices of cells in drawing order (scattered photos overlap, so sort by z).
  R.drawOrder = (m) => {
    const idx = m.cells.map((_, i) => i);
    if (m.L.type === 'scatter') idx.sort((a, b) => m.cells[a].z - m.cells[b].z);
    return idx;
  };

  // Draw everything synchronously. o.image(photoId, i) returns a drawable or null.
  R.drawCollage = (ctx, m, o) => {
    ctx.fillStyle = m.bg;
    ctx.fillRect(0, 0, m.W, m.H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(m.C.x, m.C.y, m.C.w, m.C.h);
    ctx.clip();
    for (const i of R.drawOrder(m)) {
      const slot = m.slots[i];
      const img = slot && slot.photo ? o.image(slot.photo, i) : null;
      R.drawCell(ctx, m, i, img, o);
    }
    ctx.restore();
  };

  window.CollageRender = R;
})();
