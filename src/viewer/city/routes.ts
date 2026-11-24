import type { CityLayout, CityNode, Rect } from './layout.js';
import type { Camera, Viewport } from './camera.js';
import type { Feature } from './renderer.js';
export interface Point { x: number; y: number }
interface Segment { x1: number; y1: number; x2: number; y2: number }
export interface MapRelation { id: number; fromFile: number; toFile: number; confidence: string; versions: number; kind: string; count?: number; route?: number }
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
  private hits: { id: number; points: Point[] }[] = [];
  relations: MapRelation[] = [];
  highlighted = -1; highlightedRoute = new Set<number>();
  comparison = false;
  constructor(private layout: CityLayout) { for (const n of layout.nodes) if (n.file !== undefined) this.fileNodes.set(n.file, n.id); }
  set(relations: MapRelation[], comparison: boolean) { this.relations = relations.slice(0, 200); this.comparison = comparison; this.highlighted = -1; this.highlightedRoute.clear(); }
  hit(x: number, y: number): number | undefined {
    let best: number | undefined, nearest = 9;
    for (const path of this.hits) for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i], dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1))); const d = Math.hypot(x - a.x - t * dx, y - a.y - t * dy);
      if (d < nearest) { nearest = d; best = path.id; }
    }
    return best;
  }
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
  draw(ctx: CanvasRenderingContext2D, features: Feature[], camera: Camera, viewport: Viewport, dark: boolean): { drawn: number; hidden: number; pending: number } {
    const started = performance.now(); let pending = 0;
    this.hits = []; const visible = new Map(features.map(f => [f.id, f])); const nodes = this.layout.nodes;
    const representative = (file: number) => { let id = this.fileNodes.get(file); while (id !== undefined && id >= 0) { const f = visible.get(id); if (f && (nodes[id].kind === 'file' || !f.detail)) return id; id = nodes[id].parent; } return undefined; };
    const groups = new Map<string, { edge: MapRelation; a: number; b: number; count: number }>(); let hidden = 0;
    for (const edge of this.relations) {
      const a = representative(edge.fromFile), b = representative(edge.toFile);
      if (a === undefined || b === undefined) { hidden++; continue; }
      const key = `${a}:${b}:${edge.versions}:${edge.confidence}:${edge.route ?? 0}`; const group = groups.get(key); if (group) group.count += edge.count ?? 1; else groups.set(key, { edge, a, b, count: edge.count ?? 1 });
    }
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; let drawn = 0;
    for (const { edge, a, b, count } of groups.values()) {
      const selected = edge.id === this.highlighted || this.highlightedRoute.has(edge.id); const color = this.comparison && edge.versions === 1 ? '#bc6555' : this.comparison && edge.versions === 2 ? '#268565' : edge.route === 1 ? '#9b7738' : edge.route === 2 ? '#6b819d' : dark ? '#b4ddcc' : '#205d58';
      let points: Point[] | undefined;
      if (a === b) {
        const r = visible.get(a)!.rect; points = [{ x: r.x + r.w * .35, y: r.y }, { x: r.x + r.w * .35, y: r.y - 13 }, { x: r.x + r.w * .65, y: r.y - 13 }, { x: r.x + r.w * .65, y: r.y }];
      } else {
        const key = `${camera.frame}:${a}:${b}`; if (!this.cache.has(key) && performance.now() - started > 6) { pending++; continue; } if (!this.cache.has(key)) { if (this.cache.size > 2000) this.cache.clear(); this.cache.set(key, this.path(a, b, camera.frame)); }
        points = this.cache.get(key)?.map(p => ({ x: (p.x - camera.x) * camera.scale + viewport.w / 2, y: (p.y - camera.y) * camera.scale + viewport.h / 2 }));
      }
      if (!points || points.length < 2) { hidden++; continue; }
      const drawPath = () => { ctx.beginPath(); ctx.moveTo(points![0].x, points![0].y); for (let i = 1; i < points!.length; i++) { const p = points![i]; if (i + 1 < points!.length) ctx.arcTo(p.x, p.y, points![i + 1].x, points![i + 1].y, 5); else ctx.lineTo(p.x, p.y); } ctx.stroke(); };
      ctx.setLineDash([]); ctx.strokeStyle = dark ? '#1b2824' : '#faf9f3'; ctx.lineWidth = selected ? 8 : 6; drawPath();
      ctx.strokeStyle = color; ctx.lineWidth = selected ? 3.5 : 2.2; ctx.setLineDash(edge.confidence === 'resolved' ? this.comparison && edge.versions === 1 ? [7, 4] : [] : [3, 5]); drawPath(); ctx.setLineDash([]);
      const end = points.at(-1)!, before = points.at(-2)!; const angle = Math.atan2(end.y - before.y, end.x - before.x);
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(end.x, end.y); ctx.lineTo(end.x - 9 * Math.cos(angle - .45), end.y - 9 * Math.sin(angle - .45)); ctx.lineTo(end.x - 9 * Math.cos(angle + .45), end.y - 9 * Math.sin(angle + .45)); ctx.closePath(); ctx.fill();
      const mid = points[Math.floor(points.length / 2)]; if (count > 1 || edge.route !== undefined) { ctx.fillStyle = dark ? '#192320' : '#fff'; ctx.fillRect(mid.x - 9, mid.y - 8, 22, 16); ctx.fillStyle = color; ctx.font = '10px Geist, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(count > 1 ? String(count) : String((edge.route ?? 0) + 1), mid.x + 2, mid.y + 3); }
      this.hits.push({ id: edge.id, points }); drawn++;
    }
    ctx.restore(); return { drawn, hidden, pending };
  }
}



