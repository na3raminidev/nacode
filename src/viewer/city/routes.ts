import type { CityLayout, Rect } from './layout.js';
import type { Camera, Viewport } from './camera.js';
import type { Feature } from './renderer.js';
export interface Point { x: number; y: number }
interface Segment { x1: number; y1: number; x2: number; y2: number }
export interface MapRelation { id: number; fromFile: number; toFile: number; confidence: string; versions: number; kind: string; count?: number; route?: number }
export interface RouteGroup { key: string; a: number; b: number; ids: number[]; count: number; versions: number; uncertain: boolean; route?: number }
export function groupRoutes(edges: MapRelation[], representative: (file: number) => number | undefined) {
  const groups = new Map<string, RouteGroup>(); let hidden = 0;
  for (const edge of edges) {
    const a = representative(edge.fromFile), b = representative(edge.toFile);
    if (a === undefined || b === undefined) { hidden++; continue; }
    const key = `${a}:${b}:${edge.versions}:${edge.confidence}:${edge.route ?? ''}`;
    const group = groups.get(key);
    if (group) { group.ids.push(edge.id); group.count += edge.count ?? 1; }
    else groups.set(key, { key, a, b, ids: [edge.id], count: edge.count ?? 1, versions: edge.versions, uncertain: edge.confidence !== 'resolved', route: edge.route });
  }
  return { groups: [...groups.values()], hidden };
}

export interface RouteHit extends RouteGroup { points: Point[]; badge?: Rect }
export function hitRoute(paths: RouteHit[], x: number, y: number, radius = 10, padding = 6): RouteHit | undefined {
  let best: RouteHit | undefined, nearest = radius;
  // Reverse paint order breaks line ties; actual badge bounds beat padded ones.
  for (const pad of [0, padding]) for (let j = paths.length - 1; j >= 0; j--) {
    const r = paths[j].badge;
    if (r && x >= r.x - pad && x <= r.x + r.w + pad && y >= r.y - pad && y <= r.y + r.h + pad) return paths[j];
  }
  for (let j = paths.length - 1; j >= 0; j--) for (let i = 1; i < paths[j].points.length; i++) {
    const path = paths[j], a = path.points[i - 1], b = path.points[i], dx = b.x - a.x, dy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
    if (d < nearest) { nearest = d; best = path; }
  }
  return best;
}

const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const inside = (p: Point, view: Viewport, margin = 0) => p.x >= margin && p.x <= view.w - margin && p.y >= margin && p.y <= view.h - margin;
function clipped(a: Point, b: Point, view: Viewport, margin = 8): [Point, Point] | undefined {
  let lo = 0, hi = 1;
  for (const [start, delta, max] of [[a.x, b.x - a.x, view.w], [a.y, b.y - a.y, view.h]]) {
    if (!delta) { if (start < margin || start > max - margin) return; continue; }
    const p = (margin - start) / delta, q = (max - margin - start) / delta;
    lo = Math.max(lo, Math.min(p, q)); hi = Math.min(hi, Math.max(p, q));
    if (lo >= hi) return;
  }
  return [lerp(a, b, lo), lerp(a, b, hi)];
}

// Paint and hit-test the same rounded line; short segments never overshoot a corner.
export function roundedRoute(points: Point[]): Point[] {
  const simplified: Point[] = [];
  for (const p of points) {
    const b = simplified.at(-1), a = simplified.at(-2);
    if (b && length(b, p) < .01) continue;
    if (a && b && ((a.x === b.x && b.x === p.x && (b.y - a.y) * (p.y - b.y) > 0) || (a.y === b.y && b.y === p.y && (b.x - a.x) * (p.x - b.x) > 0))) simplified.pop();
    simplified.push(p);
  }
  const result = simplified.slice(0, 1);
  for (let i = 1; i < simplified.length - 1; i++) {
    const a = simplified[i - 1], b = simplified[i], c = simplified[i + 1];
    const radius = Math.min(6, length(a, b) / 2, length(b, c) / 2);
    const start = lerp(b, a, radius / length(a, b)), end = lerp(b, c, radius / length(b, c));
    result.push(start);
    for (const t of [.25, .5, .75, 1]) result.push(lerp(lerp(start, b, t), lerp(b, end, t), t));
  }
  if (simplified.length > 1) result.push(simplified.at(-1)!);
  return result;
}

export function routeArrows(points: Point[], viewport: Viewport): { tip: Point; angle: number; size: number }[] {
  const arrows: { tip: Point; angle: number; size: number }[] = [];
  const end = points.at(-1), before = points.at(-2);
  if (end && before && inside(end, viewport, 10) && length(before, end) >= 12) arrows.push({ tip: end, angle: Math.atan2(end.y - before.y, end.x - before.x), size: 13 });
  let longest = 0, extra: typeof arrows[number] | undefined;
  for (let i = 1; i < points.length; i++) {
    const segment = clipped(points[i - 1], points[i], viewport, 12); if (!segment) continue;
    const [a, b] = segment, span = length(a, b), tip = lerp(a, b, .63);
    if (span > longest && span >= (arrows.length ? 165 : 10) && (!arrows.length || length(tip, arrows[0].tip) > 75)) {
      longest = span; extra = { tip, angle: Math.atan2(b.y - a.y, b.x - a.x), size: Math.min(13, span * .72) };
    }
  }
  if (extra) arrows.push(extra);
  return arrows;
}

const arrow = (ctx: CanvasRenderingContext2D, tip: Point, angle: number, size: number, halo: string) => {
  ctx.beginPath(); ctx.moveTo(tip.x, tip.y);
  for (const side of [-.52, .52]) ctx.lineTo(tip.x - size * Math.cos(angle + side), tip.y - size * Math.sin(angle + side));
  ctx.closePath(); ctx.strokeStyle = halo; ctx.lineWidth = 2.5; ctx.stroke(); ctx.fill();
};
const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
const between = (v: number, a: number, b: number) => v >= Math.min(a, b) - 1e-6 && v <= Math.max(a, b) + 1e-6;
function crosses(a: Point, b: Point, r: Rect) {
  const e = 1e-6;
  return Math.abs(a.x - b.x) < e ? a.x > r.x + e && a.x < r.x + r.w - e && Math.max(a.y, b.y) > r.y + e && Math.min(a.y, b.y) < r.y + r.h - e
    : a.y > r.y + e && a.y < r.y + r.h - e && Math.max(a.x, b.x) > r.x + e && Math.min(a.x, b.x) < r.x + r.w - e;
}
function projection(p: Point, s: Segment): Point { return { x: Math.max(Math.min(s.x1, s.x2), Math.min(Math.max(s.x1, s.x2), p.x)), y: Math.max(Math.min(s.y1, s.y2), Math.min(Math.max(s.y1, s.y2), p.y)) }; }
function ports(rect: Rect): Point[] { return [{ x: rect.x, y: rect.y + rect.h / 2 }, { x: rect.x + rect.w, y: rect.y + rect.h / 2 }, { x: rect.x + rect.w / 2, y: rect.y }, { x: rect.x + rect.w / 2, y: rect.y + rect.h }]; }
// Small per-neighborhood street networks, never a viewport-sized pixel grid.
export function streetRoute(streets: Segment[], obstacles: Rect[], from: Point[], to: Point[]): Point[] | undefined {
  const attach = (candidates: Point[]) => candidates.flatMap(port => streets.map((street, segment) => ({ port, point: projection(port, street), segment })).filter(a => (Math.abs(a.port.x - a.point.x) < 1e-6 || Math.abs(a.port.y - a.point.y) < 1e-6) && !obstacles.some(r => crosses(a.port, a.point, r)))).sort((a, b) => distance(a.port, a.point) - distance(b.port, b.point)).slice(0, 8);
  const starts = attach(from), ends = attach(to); if (!starts.length || !ends.length) return;
  const vertices: Point[] = [], ids = new Map<string, number>(), segments: number[][] = streets.map(() => []);
  const vertex = (p: Point) => { const key = `${p.x.toFixed(6)}:${p.y.toFixed(6)}`; let id = ids.get(key); if (id === undefined) { id = vertices.length; vertices.push(p); ids.set(key, id); } return id; };
  for (let i = 0; i < streets.length; i++) {
    const a = streets[i]; segments[i].push(vertex({ x: a.x1, y: a.y1 }), vertex({ x: a.x2, y: a.y2 }));
    for (let j = 0; j < i; j++) {
      const b = streets[j]; if ((a.x1 === a.x2) === (b.x1 === b.x2)) continue;
      const p = a.x1 === a.x2 ? { x: a.x1, y: b.y1 } : { x: b.x1, y: a.y1 };
      if (between(p.x, a.x1, a.x2) && between(p.y, a.y1, a.y2) && between(p.x, b.x1, b.x2) && between(p.y, b.y1, b.y2)) { const id = vertex(p); segments[i].push(id); segments[j].push(id); }
    }
  }
  for (const a of [...starts, ...ends]) segments[a.segment].push(vertex(a.point));
  const adjacent: { to: number; cost: number }[][] = vertices.map(() => []);
  for (const list of segments) { const sorted = [...new Set(list)].sort((a, b) => vertices[a].x - vertices[b].x || vertices[a].y - vertices[b].y); for (let i = 1; i < sorted.length; i++) { const a = sorted[i - 1], b = sorted[i]; if (obstacles.some(r => crosses(vertices[a], vertices[b], r))) continue; const cost = distance(vertices[a], vertices[b]); adjacent[a].push({ to: b, cost }); adjacent[b].push({ to: a, cost }); } }
  const goals = new Map(ends.map(e => [vertex(e.point), e]));
  const scores = new Float64Array(vertices.length).fill(Infinity), parent = new Int32Array(vertices.length).fill(-1), origin = new Map<number, Point>(), open = new Set<number>();
  for (const a of starts) { const id = vertex(a.point), score = distance(a.port, a.point); if (score < scores[id]) { scores[id] = score; origin.set(id, a.port); open.add(id); } }
  let goal = -1;
  while (open.size) {
    let current = -1, best = Infinity;
    for (const id of open) { const score = scores[id] + Math.min(...ends.map(e => distance(vertices[id], e.point))); if (score < best) { current = id; best = score; } }
    if (goals.has(current)) { goal = current; break; } open.delete(current);
    for (const edge of adjacent[current]) {
      const previous = parent[current]; const bend = previous >= 0 && (vertices[previous].x === vertices[current].x) !== (vertices[current].x === vertices[edge.to].x) ? 4 : 0;
      const score = scores[current] + edge.cost + bend;
      if (score < scores[edge.to]) { scores[edge.to] = score; parent[edge.to] = current; origin.set(edge.to, origin.get(current)!); open.add(edge.to); }
    }
  }
  if (goal < 0) return;
  const points: Point[] = [goals.get(goal)!.port]; for (let id = goal; id >= 0; id = parent[id]) points.unshift(vertices[id]); points.unshift(origin.get(goal)!);
  return points.filter((p, i) => !i || distance(p, points[i - 1]) > 1e-5);
}
export class RouteOverlay {
  private fileNodes = new Map<number, number>();
  private cache = new Map<string, Point[] | undefined>();
  private hits: RouteHit[] = [];
  relations: MapRelation[] = [];
  selected = new Set<number>(); hovered?: string; guideId?: number; highlightedRoute = new Set<number>();
  comparison = false;
  constructor(private layout: CityLayout) { for (const n of layout.nodes) if (n.file !== undefined) this.fileNodes.set(n.file, n.id); }
  set(relations: MapRelation[], comparison: boolean) { this.relations = relations.slice(0, 200); this.comparison = comparison; this.selected.clear(); this.highlightedRoute.clear(); this.guideId = this.hovered = undefined; this.hits = []; }
  hit(x: number, y: number, radius?: number, padding?: number) { return hitRoute(this.hits, x, y, radius, padding); }
  private transform(point: Point, node: number, frame: number): Point | undefined {
    let p = { ...point }; let steps = 0;
    while (node !== frame && node >= 0 && steps++ < 128) { const n = this.layout.nodes[node]; const scale = n.rect.w / n.width; p = { x: n.rect.x + p.x * scale, y: n.rect.y + p.y * scale }; node = n.parent; }
    return node === frame && Number.isFinite(p.x + p.y) ? p : undefined;
  }
  private path(a: number, b: number, frame: number): Point[] | undefined {
    if (a === b) return;
    const nodes = this.layout.nodes; const chain = (id: number) => { const list: number[] = []; while (id >= 0) { list.push(id); id = nodes[id].parent; } return list; };
    const aa = chain(a), bb = chain(b), common = aa.find(id => bb.includes(id)); if (common === undefined || common === a || common === b) return;
    const childA = aa[aa.indexOf(common) - 1], childB = bb[bb.indexOf(common) - 1]; const parent = nodes[common];
    const main = streetRoute(parent.streets ?? [], parent.children.map(id => nodes[id].rect), ports(nodes[childA].rect), ports(nodes[childB].rect)); if (!main) return;
    const inward = (container: number, target: number, portInParent: Point): Point[] | undefined => {
      const n = nodes[container]; if (container === target) return [portInParent];
      const factor = n.rect.w / n.width; const boundary = { x: (portInParent.x - n.rect.x) / factor, y: (portInParent.y - n.rect.y) / factor };
      const ancestry = chain(target); const child = ancestry[ancestry.indexOf(container) - 1]; if (child === undefined) return;
      const points = streetRoute(n.streets ?? [], n.children.map(id => nodes[id].rect), ports(nodes[child].rect), [boundary]); if (!points) return;
      const deeper = inward(child, target, points[0]); if (!deeper) return;
      return [...deeper, ...points.slice(1)].map(p => ({ x: n.rect.x + p.x * factor, y: n.rect.y + p.y * factor }));
    };
    const left = inward(childA, a, main[0]), right = inward(childB, b, main.at(-1)!); if (!left || !right) return;
    const points = [...left, ...main.slice(1, -1), ...right.reverse()];
    const projected = points.map(p => this.transform(p, common, frame)); if (projected.some(p => !p)) return;
    return projected as Point[];
  }
  private drawGuide(ctx: CanvasRenderingContext2D, visible: Map<number, Feature>, viewport: Viewport, dark: boolean) {
    if (this.guideId === undefined) return;
    const edge = this.relations.find(e => e.id === this.guideId); if (!edge || edge.fromFile === edge.toFile) return;
    const endpoints = [edge.fromFile, edge.toFile].map(file => visible.get(this.fileNodes.get(file) ?? -1)?.rect);
    const [a, b] = endpoints; if (!a || !b) return;
    const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
    const p = center(a), q = center(b), span = length(p, q); if (span < 8) return;
    const mid = lerp(p, q, .5), bend = Math.min(105, span * .30);
    const control = { x: mid.x - (q.y - p.y) / span * bend, y: mid.y + (q.x - p.x) / span * bend };
    const boundary = (r: Rect, c: Point) => {
      const dx = control.x - c.x, dy = control.y - c.y;
      return lerp(c, control, Math.min(1, r.w / 2 / Math.abs(dx), r.h / 2 / Math.abs(dy)));
    };
    const start = boundary(a, p), end = boundary(b, q);
    if (!inside(start, viewport, 1) || !inside(end, viewport, 1)) return;
    const trace = () => { ctx.beginPath(); ctx.moveTo(start.x, start.y); ctx.quadraticCurveTo(control.x, control.y, end.x, end.y); ctx.stroke(); };
    const halo = dark ? '#14231f' : '#fcfffd';
    ctx.globalAlpha = .95; ctx.setLineDash([2, 7]); ctx.lineWidth = 6; ctx.strokeStyle = halo; trace();
    ctx.lineWidth = 3; ctx.strokeStyle = ctx.fillStyle = dark ? '#b2d6ff' : '#245db2'; trace();
    ctx.setLineDash([]); arrow(ctx, end, Math.atan2(end.y - control.y, end.x - control.x), 12, halo);
    return lerp(lerp(start, control, .5), lerp(control, end, .5), .5);
  }
  draw(ctx: CanvasRenderingContext2D, features: Feature[], camera: Camera, viewport: Viewport, dark: boolean) {
    const started = performance.now(); let pending = 0;
    this.hits = []; const visible = new Map(features.map(f => [f.id, f])); const nodes = this.layout.nodes;
    const representative = (file: number) => { let id = this.fileNodes.get(file); while (id !== undefined && id >= 0) { const f = visible.get(id); if (f && (nodes[id].kind === 'file' || !f.detail)) return id; id = nodes[id].parent; } return undefined; };
    let { groups, hidden } = groupRoutes(this.relations, representative);
    const priority = (group: RouteGroup) => group.ids.some(id => this.selected.has(id)) ? 3 : group.key === this.hovered ? 2 : group.ids.some(id => this.highlightedRoute.has(id)) ? 1 : 0;
    const ranked = groups.map(group => ({ group, rank: priority(group) })).sort((a, b) => a.rank - b.rank);
    const badges: { rect: Rect; label: string; color: string; alpha: number; active: boolean }[] = [];
    const halo = dark ? '#121d19' : '#fcfffa';
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.font = '650 11px Geist, sans-serif';
    const guide = this.drawGuide(ctx, visible, viewport, dark);
    let focusX = guide?.x;
    const framePaths = new Map<string, Point[] | undefined>();
    for (const { group, rank } of ranked) {
      const { a, b, count } = group;
      const status = this.comparison && group.versions === 1 ? '-' : this.comparison && group.versions === 2 ? '+' : '';
      const color = status === '-' ? (dark ? '#ff9c91' : '#ac372b') : status === '+' ? (dark ? '#8bedae' : '#0e693c') : group.route === 1 ? (dark ? '#ffd280' : '#895400') : group.route === 2 ? (dark ? '#b4d2ff' : '#365994') : dark ? '#9df2df' : '#005c56';
      const alpha = (this.selected.size && rank < 2 || !this.selected.size && this.highlightedRoute.size && !rank) ? .32 : 1;
      let points: Point[] | undefined;
      if (a === b) {
        const r = visible.get(a)!.rect, y = r.y > 30 ? r.y : r.y + r.h, lift = r.y > 30 ? -23 : 23;
        points = [{ x: r.x + r.w * .29, y }, { x: r.x + r.w * .29, y: y + lift }, { x: r.x + r.w * .71, y: y + lift }, { x: r.x + r.w * .71, y }];
      } else {
        const key = `${camera.frame}:${a}:${b}`; if (!this.cache.has(key) && performance.now() - started > 6) { pending++; continue; } if (!this.cache.has(key)) { if (this.cache.size > 2000) this.cache.clear(); this.cache.set(key, this.path(a, b, camera.frame)); }
        if (!framePaths.has(key)) framePaths.set(key, this.cache.get(key)?.map(p => ({ x: (p.x - camera.x) * camera.scale + viewport.w / 2, y: (p.y - camera.y) * camera.scale + viewport.h / 2 })));
        points = framePaths.get(key);
      }
      if (!points || points.length < 2) { hidden += group.ids.length; continue; }
      points = roundedRoute(points);
      const segments = points.slice(1).map((p, i) => clipped(points![i], p, viewport, 0)).filter(s => s !== undefined);
      if (!segments.length) { hidden += group.ids.length; continue; }
      const trace = () => { ctx.beginPath(); ctx.moveTo(points![0].x, points![0].y); for (const p of points!.slice(1)) ctx.lineTo(p.x, p.y); ctx.stroke(); };
      ctx.globalAlpha = alpha;
      ctx.setLineDash([]); ctx.strokeStyle = halo; ctx.lineWidth = rank ? 10 : 7.5; trace();
      ctx.strokeStyle = color; ctx.lineWidth = rank ? 5.5 : count > 1 ? 4 : 3.4;
      ctx.setLineDash(group.uncertain ? [3, 7] : status === '-' ? [11, 5] : []); trace(); ctx.setLineDash([]);
      ctx.fillStyle = color;
      const arrows = routeArrows(points, viewport);
      for (const { tip, angle, size } of arrows) arrow(ctx, tip, angle, size + (rank ? 2 : 0), halo);
      const label = count > 1 ? `${status}${count}` : status || (group.route === undefined ? '' : `R${group.route + 1}`);
      let badge: Rect | undefined;
      if (label && viewport.w >= 44 && viewport.h >= 32) {
        const w = Math.max(24, ctx.measureText(label).width + 16), h = 22;
        segments.sort(([a, b], [c, d]) => length(c, d) - length(a, b));
        const available = (r: Rect) => badges.every(({ rect: o }) => r.x + r.w + 3 < o.x || o.x + o.w + 3 < r.x || r.y + r.h + 3 < o.y || o.y + o.h + 3 < r.y);
        for (const [a, b] of segments.slice(0, 3)) {
          for (const t of [.42, .23, .74]) {
            const p = lerp(a, b, t), r = { x: Math.max(4, Math.min(viewport.w - w - 4, p.x - w / 2)), y: Math.max(4, Math.min(viewport.h - h - 4, p.y - h / 2)), w, h };
            badge ??= r;
            if (available(r)) { badge = r; break; }
          }
          if (badge && available(badge)) break;
        }
        if (badge) badges.push({ rect: badge, label, color, alpha, active: rank > 0 });
      }
      if (rank === 3) focusX ??= badge ? badge.x + badge.w / 2 : arrows[0]?.tip.x ?? lerp(...segments[0], .5).x;
      this.hits.push({ ...group, points, badge });
    }
    for (const { rect: r, label, color, alpha, active } of badges) {
      ctx.globalAlpha = Math.max(.55, alpha); ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, 8);
      ctx.fillStyle = active ? color : halo; ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = active ? halo : color; ctx.fillText(label, r.x + r.w / 2, r.y + r.h / 2 + .5);
    }
    ctx.restore(); return { drawn: this.hits.length, hidden, pending, guide: !!guide, focusX };
  }
}



