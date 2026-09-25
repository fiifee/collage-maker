/*
 * Geometry for collage layouts.
 * All coordinates are in millimetres on the paper; points are [x, y] arrays.
 */
(function () {
  'use strict';

  const G = {};

  G.rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

  G.bbox = (poly) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  function signedArea(p) {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const j = (i + 1) % p.length;
      a += p[i][0] * p[j][1] - p[j][0] * p[i][1];
    }
    return a / 2;
  }

  G.area = (p) => Math.abs(signedArea(p));

  G.contains = (poly, x, y) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  // Remove consecutive duplicate points (they break rounded-corner drawing).
  function dedupe(p) {
    const out = [];
    for (const q of p) {
      const last = out[out.length - 1];
      if (!last || Math.abs(last[0] - q[0]) > 1e-6 || Math.abs(last[1] - q[1]) > 1e-6) out.push(q);
    }
    while (out.length > 1) {
      const a = out[0], b = out[out.length - 1];
      if (Math.abs(a[0] - b[0]) > 1e-6 || Math.abs(a[1] - b[1]) > 1e-6) break;
      out.pop();
    }
    return out;
  }

  function clipEdge(poly, inside, intersect) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (pi) {
        out.push(intersect(prev, cur));
      }
    }
    return out;
  }

  // Sutherland–Hodgman clip of a polygon against an axis-aligned rectangle.
  G.clipRect = (poly, r) => {
    const x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    const ix = (a, b, x) => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
    const iy = (a, b, y) => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
    let p = poly;
    p = clipEdge(p, (q) => q[0] >= x0, (a, b) => ix(a, b, x0));
    if (p.length) p = clipEdge(p, (q) => q[0] <= x1, (a, b) => ix(a, b, x1));
    if (p.length) p = clipEdge(p, (q) => q[1] >= y0, (a, b) => iy(a, b, y0));
    if (p.length) p = clipEdge(p, (q) => q[1] <= y1, (a, b) => iy(a, b, y1));
    return dedupe(p);
  };

  // Shrink a convex polygon by distance d on every edge. Returns null if it collapses.
  G.inset = (poly, d) => {
    if (d <= 0) return poly;
    const n = poly.length;
    const sa = signedArea(poly);
    const sign = sa > 0 ? 1 : -1;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      let dx = b[0] - a[0], dy = b[1] - a[1];
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const nx = -dy * sign, ny = dx * sign;
      lines.push({ px: a[0] + nx * d, py: a[1] + ny * d, dx, dy });
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const l1 = lines[(i + n - 1) % n], l2 = lines[i];
      const cross = l1.dx * l2.dy - l1.dy * l2.dx;
      if (Math.abs(cross) < 1e-9) { out.push([l2.px, l2.py]); continue; }
      const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / cross;
      out.push([l1.px + t * l1.dx, l1.py + t * l1.dy]);
    }
    const na = signedArea(out);
    if (na * sa <= 0 || Math.abs(na) < 1e-6) return null;
    return out;
  };

  // Trace a (possibly rounded) polygon path on a canvas context.
  G.tracePath = (ctx, poly, radius) => {
    const n = poly.length;
    ctx.beginPath();
    if (!radius || radius <= 0 || n < 3) {
      ctx.moveTo(poly[0][0], poly[0][1]);
      for (let i = 1; i < n; i++) ctx.lineTo(poly[i][0], poly[i][1]);
      ctx.closePath();
      return;
    }
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(poly[n - 1], poly[0]);
    ctx.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const prev = poly[(i + n - 1) % n], cur = poly[i], next = poly[(i + 1) % n];
      const e1 = Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      const e2 = Math.hypot(next[0] - cur[0], next[1] - cur[1]);
      const v1 = [(prev[0] - cur[0]) / e1, (prev[1] - cur[1]) / e1];
      const v2 = [(next[0] - cur[0]) / e2, (next[1] - cur[1]) / e2];
      const cos = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1]));
      const theta = Math.acos(cos);
      const tanHalf = Math.tan(theta / 2);
      // The arc's tangent points must stay within half of each adjacent edge.
      const r = Math.min(radius, (Math.min(e1, e2) / 2) * tanHalf);
      if (r <= 1e-6 || !isFinite(r)) ctx.lineTo(cur[0], cur[1]);
      else ctx.arcTo(cur[0], cur[1], next[0], next[1], r);
    }
    ctx.closePath();
  };

  // ---- Shape masks -------------------------------------------------------

  function fitPoly(pts, area, pad) {
    const b = G.bbox(pts);
    const s = Math.min(area.w / b.w, area.h / b.h) * (pad || 1);
    const ox = area.x + (area.w - b.w * s) / 2 - b.x * s;
    const oy = area.y + (area.h - b.h * s) / 2 - b.y * s;
    return pts.map(([x, y]) => [x * s + ox, y * s + oy]);
  }

  G.maskPolygon = (shape, area) => {
    const pts = [];
    if (shape === 'heart') {
      for (let i = 0; i < 180; i++) {
        const t = (i / 180) * Math.PI * 2;
        const x = 16 * Math.pow(Math.sin(t), 3);
        const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
        pts.push([x, y]);
      }
    } else if (shape === 'circle') {
      for (let i = 0; i < 120; i++) {
        const t = (i / 120) * Math.PI * 2;
        pts.push([Math.cos(t), Math.sin(t)]);
      }
    } else {
      return null;
    }
    return fitPoly(pts, area, 1);
  };

  // ---- Layout generators ---------------------------------------------------

  function expand(r, d) {
    return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
  }

  // Deterministic PRNG so layouts are reproducible from a seed.
  G.rng = (seed) => {
    let a = seed >>> 0 || 1;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Turn raw tile polygons into final cells: apply the gap, clip to the printable area,
  // drop slivers. `minFrac` is the smallest visible fraction of a tile that is kept.
  function finalize(raw, C, gap, minFrac) {
    const cells = [];
    for (const r of raw) {
      const ip = G.inset(r.poly, gap / 2);
      if (!ip) continue;
      const cp = G.clipRect(ip, C);
      if (cp.length < 3) continue;
      const full = G.area(ip);
      const frac = G.area(cp) / full;
      if (frac < minFrac) continue;
      cells.push({ poly: cp, box: G.bbox(cp), full: frac > 0.98, row: r.row, col: r.col });
    }
    cells.sort((a, b) => a.row - b.row || a.col - b.col);
    return cells;
  }

  function squares(C, L) {
    const T = expand(C, L.gap / 2);
    const raw = [];
    if (L.shape === 'rect') {
      const cw = T.w / L.cols, ch = T.h / L.rows;
      for (let r = 0; r < L.rows; r++)
        for (let c = 0; c < L.cols; c++)
          raw.push({ poly: G.rect(T.x + c * cw, T.y + r * ch, cw, ch), row: r, col: c });
    } else {
      const mask = G.maskPolygon(L.shape, C);
      const s = T.w / L.cols;
      const rows = Math.max(1, Math.floor(T.h / s));
      const oy = T.y + (T.h - rows * s) / 2;
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < L.cols; c++) {
          const x = T.x + c * s, y = oy + r * s;
          if (G.contains(mask, x + s / 2, y + s / 2)) raw.push({ poly: G.rect(x, y, s, s), row: r, col: c });
        }
    }
    return finalize(raw, C, L.gap, 0.05);
  }

  function diamond(cx, cy, hw, hh) {
    return [[cx, cy - hh], [cx + hw, cy], [cx, cy + hh], [cx - hw, cy]];
  }

  function diamonds(C, L) {
    const T = expand(C, L.gap / 2);
    const cols = L.cols;
    const dx = T.w / cols;
    let rows, dy, oy;
    const mask = L.shape === 'rect' ? null : G.maskPolygon(L.shape, C);
    if (!mask) {
      rows = Math.max(1, Math.round(T.h / dx));
      dy = T.h / rows;
      oy = T.y;
    } else {
      dy = dx;
      rows = Math.max(1, Math.floor(T.h / dy));
      oy = T.y + (T.h - rows * dy) / 2;
    }
    const raw = [];
    const add = (cx, cy, row, col) => {
      if (mask && !G.contains(mask, cx, cy)) return;
      raw.push({ poly: diamond(cx, cy, dx / 2, dy / 2), row, col });
    };
    for (let j = 0; j <= rows; j++) {
      // Edge-aligned lattice (produces half/quarter pieces along the border).
      if (L.fillEdges || mask) for (let i = 0; i <= cols; i++) add(T.x + i * dx, oy + j * dy, j * 2, i * 2);
      if (j < rows) for (let i = 0; i < cols; i++) add(T.x + (i + 0.5) * dx, oy + (j + 0.5) * dy, j * 2 + 1, i * 2 + 1);
    }
    return finalize(raw, C, L.gap, mask ? 0.3 : L.fillEdges ? 0.05 : 0.98);
  }

  function hexagon(cx, cy, r) {
    const p = [];
    for (let k = 0; k < 6; k++) {
      const a = ((-90 + 60 * k) * Math.PI) / 180;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return p;
  }

  function hexagons(C, L) {
    const T = expand(C, L.gap / 2);
    const w = T.w / L.cols;
    const r = w / Math.sqrt(3);
    const vs = 1.5 * r;
    const mask = L.shape === 'rect' ? null : G.maskPolygon(L.shape, C);
    const rows = Math.ceil(T.h / vs) + 1;
    const oy = T.y + (T.h - (rows - 1) * vs) / 2;
    const raw = [];
    for (let j = 0; j < rows; j++) {
      const cy = oy + j * vs;
      const odd = j % 2 === 1;
      const n = odd ? L.cols + 1 : L.cols;
      for (let i = 0; i < n; i++) {
        const cx = odd ? T.x + i * w : T.x + (i + 0.5) * w;
        if (mask && !G.contains(mask, cx, cy)) continue;
        raw.push({ poly: hexagon(cx, cy, r), row: j, col: odd ? i * 2 : i * 2 + 1 });
      }
    }
    return finalize(raw, C, L.gap, mask ? 0.3 : L.fillEdges ? 0.08 : 0.98);
  }

  function mixed(C, L) {
    const T = expand(C, L.gap / 2);
    const cols = L.cols;
    const rows = Math.max(1, Math.round(T.h / (T.w / cols)));
    const cw = T.w / cols, ch = T.h / rows;
    const occ = new Uint8Array(cols * rows);
    const rnd = G.rng(L.seed * 7919 + cols * 31 + rows);
    const shapes = [[2, 2], [2, 2], [2, 2], [2, 1], [1, 2], [3, 3]];
    const target = L.mixed * cols * rows;
    let covered = 0, attempts = cols * rows * 6;
    const tiles = [];
    const free = (x, y, w, h) => {
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (occ[yy * cols + xx]) return false;
      return true;
    };
    while (covered < target && attempts-- > 0) {
      let [w, h] = shapes[Math.floor(rnd() * shapes.length)];
      if (w === 3 && (cols < 6 || rows < 6)) continue;
      if (w > cols || h > rows) continue;
      const x = Math.floor(rnd() * (cols - w + 1)), y = Math.floor(rnd() * (rows - h + 1));
      if (!free(x, y, w, h)) continue;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) occ[yy * cols + xx] = 1;
      tiles.push({ x, y, w, h });
      covered += w * h;
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (!occ[y * cols + x]) tiles.push({ x, y, w: 1, h: 1 });
    const raw = tiles.map((t) => ({ poly: G.rect(T.x + t.x * cw, T.y + t.y * ch, t.w * cw, t.h * ch), row: t.y, col: t.x }));
    return finalize(raw, C, L.gap, 0.05);
  }

  G.layout = (type, C, L) => {
    if (L.cols < 1) return [];
    switch (type) {
      case 'squares': return squares(C, L);
      case 'diamonds': return diamonds(C, L);
      case 'hexagons': return hexagons(C, L);
      case 'mixed': return mixed(C, L);
      default: return [];
    }
  };

  // Best rows × columns for a plain grid of `n` photos in area C: little waste, near-square tiles.
  G.bestGrid = (n, C, gap) => {
    let best = null;
    const W = C.w + gap, H = C.h + gap;
    for (let cols = 1; cols <= 60; cols++) {
      const rows = Math.ceil(n / cols);
      if (rows > 80) continue;
      const aspect = W / cols / (H / rows);
      const score = (cols * rows - n) / n + Math.abs(Math.log(aspect)) * 0.6;
      if (!best || score < best.score) best = { cols, rows, score };
    }
    return best || { cols: 1, rows: 1 };
  };

  // ---- Scatter -------------------------------------------------------------

  // Place `count` new points (0..1 space) spread out from existing ones (Mitchell's best candidate).
  G.scatterPoints = (existing, count, aspect, rnd) => {
    const pts = existing.map((p) => [p.x, p.y]);
    const out = [];
    for (let k = 0; k < count; k++) {
      let best = null, bestD = -1;
      const tries = 12 + Math.min(40, pts.length);
      for (let t = 0; t < tries; t++) {
        const x = 0.06 + rnd() * 0.88, y = 0.06 + rnd() * 0.88;
        let d = Infinity;
        for (const p of pts) {
          const dx = (p[0] - x) * aspect, dy = p[1] - y;
          const dd = dx * dx + dy * dy;
          if (dd < d) d = dd;
        }
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
      pts.push(best);
      out.push(best);
    }
    return out;
  };

  G.newScatterItems = (existing, count, aspect, rnd) => {
    const zBase = existing.reduce((m, it) => Math.max(m, it.z), 0);
    return G.scatterPoints(existing, count, aspect, rnd).map(([x, y], i) => ({
      x, y, s: 1, t: rnd() * 2 - 1, dr: 0, z: zBase + 1 + rnd() * 0.5 + i,
    }));
  };

  window.CollageGeometry = G;
})();
