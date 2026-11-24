import { type CityLayout, type CityNode, type Rect, hashPath, intersects, contains } from './layout.js';
import { screenRect, type Camera, type Viewport } from './camera.js';
export interface Feature { id: number; rect: Rect; detail: boolean }
export interface CityFrame { features: Feature[]; buildings: number; aggregates: number; labels: number }
interface Colors { ground: string; street: string; line: string; ink: string; muted: string; accent: string; park: string; districts: string[]; roofs: string[]; selected: string; add: string; remove: string; modify: string }
const LIGHT: Colors = { ground: '#eeeee6', street: '#faf9f3', line: '#cbd0c4', ink: '#384c43', muted: '#798279', accent: '#246c58', park: '#d4ddc7', districts: ['#e0e5d6', '#e4e0d1', '#dce4e3', '#e8ded2', '#e4e1d9'], roofs: ['#a5b99a', '#c4b28b', '#9fb9b7', '#c7a78f', '#b5b0a1'], selected: '#ffffff', add: '#34865a', remove: '#b95149', modify: '#9e732b' };
const DARK: Colors = { ground: '#1b2824', street: '#26342e', line: '#405247', ink: '#dde6d8', muted: '#a2b1a3', accent: '#9dd2b4', park: '#344c38', districts: ['#334537', '#454334', '#344848', '#4a3d32', '#414338'], roofs: ['#648467', '#908462', '#638c89', '#a17d5d', '#85816c'], selected: '#192821', add: '#91c69f', remove: '#de9e92', modify: '#d3b779' };
export function visibleFeatures(layout: CityLayout, camera: Camera, viewport: Viewport, budget = 2000): Feature[] {
  const nodes = layout.nodes; const root = nodes[camera.frame];
  const full = screenRect({ x: 0, y: 0, w: root.width, h: root.height }, camera, viewport);
  const bounds = { x: -40, y: -40, w: viewport.w + 80, h: viewport.h + 80 };
  const result: Feature[] = [];
  const queue = [{ id: root.id, rect: full }];
  let allocated = 1;
  while (queue.length) {
    const item = queue.pop()!; if (!intersects(item.rect, bounds)) continue;
    const node = nodes[item.id];
    const average = Math.sqrt(item.rect.w * item.rect.h / Math.max(1, node.children.length));
    const expand = node.children.length > 0 && (node.kind === 'city' || (Math.min(item.rect.w, item.rect.h) > 100 && average > 42)) && allocated + node.children.length <= budget;
    result.push({ ...item, detail: expand });
    if (!expand) continue;
    const factor = item.rect.w / node.width;
    for (let i = node.children.length - 1; i >= 0; i--) {
      const child = nodes[node.children[i]];
      const rect = { x: item.rect.x + child.rect.x * factor, y: item.rect.y + child.rect.y * factor, w: child.rect.w * factor, h: child.rect.h * factor };
      if (intersects(rect, bounds)) { queue.push({ id: child.id, rect }); allocated++; }
    }
  }
  return result;
}
export class CityRenderer {
  private context: CanvasRenderingContext2D;
  private colors = LIGHT;
  private labelBoxes: Rect[] = [];
  private labels = 0;
  private grid?: CanvasPattern;
  private textWidths = new Map<string, number>();
  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false }); if (!context) throw new Error('Canvas 2D is not available. Use Files to browse this export.'); this.context = context;
  }
  refreshFonts() { this.textWidths.clear(); }
  setTheme(dark: boolean) { this.colors = dark ? DARK : LIGHT; this.grid = undefined; }
  render(layout: CityLayout, camera: Camera, viewport: Viewport, selected: number | undefined, hovered: number | undefined, changes: boolean, emphasis?: Set<number>): CityFrame {
    const ctx = this.context, c = this.colors; const dpr = Math.min(devicePixelRatio || 1, 2);
    const width = Math.round(viewport.w * dpr), height = Math.round(viewport.h * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, viewport.w, viewport.h);
    ctx.fillStyle = c.ground; ctx.fillRect(0, 0, viewport.w, viewport.h);
    const gap = 32; const ox = ((-camera.x * camera.scale + viewport.w / 2) % gap + gap) % gap; const oy = ((-camera.y * camera.scale + viewport.h / 2) % gap + gap) % gap;
    if (!this.grid) {
      const tile = document.createElement('canvas'); tile.width = tile.height = gap;
      const grid = tile.getContext('2d')!; grid.fillStyle = c.line; grid.globalAlpha = .45; grid.fillRect(0, 0, 1, 1);
      this.grid = ctx.createPattern(tile, 'repeat')!;
    }
    ctx.save(); ctx.translate(ox, oy); ctx.fillStyle = this.grid; ctx.fillRect(-ox, -oy, viewport.w, viewport.h); ctx.restore();
    const features = visibleFeatures(layout, camera, viewport);
    let buildings = 0, aggregates = 0;
    for (const feature of features) {
      const node = layout.nodes[feature.id]; ctx.globalAlpha = emphasis && !emphasis.has(feature.id) ? .22 : 1;
      if (node.kind === 'file') { this.building(node, feature.rect, feature.id === selected, feature.id === hovered, changes); buildings++; }
      else { this.district(node, feature.rect, feature.detail, feature.id === hovered, viewport); if (!feature.detail) aggregates++; }
    }
    ctx.globalAlpha = 1;
    this.labelBoxes = []; this.labels = 0;
    const sorted = [...features].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || Number(b.id === hovered) - Number(a.id === hovered) || Number(layout.nodes[a.id].kind === 'file') - Number(layout.nodes[b.id].kind === 'file') || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    for (const item of sorted) {
      const node = layout.nodes[item.id]; if (node.kind === 'city' || emphasis && !emphasis.has(item.id)) continue;
      if (node.kind === 'file') {
        if (item.rect.w < 88 || item.rect.h < 44) continue;
        this.label(node.name, item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h + 15, item.rect.w + 24, 10, true, viewport);
      } else if (item.detail) {
        const top = item.rect.y + Math.min(25, item.rect.h * .04);
        this.label(node.kind === 'block' ? `${node.name} / ${node.count} files` : node.name, item.rect.x + item.rect.w / 2, top, item.rect.w - 24, 11, false, viewport);
      } else if (item.rect.w > 70 && item.rect.h > 50) {
        this.label(node.name, item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h * .48, item.rect.w - 26, Math.min(18, Math.max(11, item.rect.w / 15)), true, viewport);
        this.label(`${node.count.toLocaleString()} ${node.count === 1 ? 'file' : 'files'}  /  zoom to explore`, item.rect.x + item.rect.w / 2, item.rect.y + item.rect.h * .48 + 24, item.rect.w - 26, 9, false, viewport);
      }
    }
    return { features, buildings, aggregates, labels: this.labels };
  }
  private rounded(rect: Rect, radius: number) {
    const ctx = this.context; ctx.beginPath(); ctx.roundRect(rect.x, rect.y, Math.max(0, rect.w), Math.max(0, rect.h), Math.max(0, Math.min(radius, rect.w / 2, rect.h / 2)));
  }
  private district(node: CityNode, rect: Rect, detail: boolean, hover: boolean, viewport: Viewport) {
    const ctx = this.context, c = this.colors;
    this.rounded(rect, node.kind === 'city' ? 20 : 8); ctx.fillStyle = detail ? c.street : c.districts[node.color]; ctx.fill();
    ctx.strokeStyle = hover ? c.accent : c.line; ctx.lineWidth = hover ? 2 : 1; ctx.stroke();
    if (node.kind === 'city') return;
    if (!detail && rect.w > 65 && rect.h > 65) {
      // Subtle cadastral marks suggest a neighborhood, not fabricated code entities.
      ctx.save(); this.rounded(rect, 8); ctx.clip(); ctx.strokeStyle = c.line; ctx.globalAlpha = .5; ctx.lineWidth = .7;
      const columns = Math.min(8, Math.max(2, Math.ceil(Math.sqrt(node.count))));
      for (let i = 1; i < columns; i++) {
        const x = rect.x + rect.w * i / columns; ctx.beginPath(); ctx.moveTo(x, rect.y + 10); ctx.lineTo(x, rect.y + rect.h - 10); ctx.stroke();
      }
      ctx.restore();
    }
    if (detail && Math.min(rect.w, rect.h) > 170) {
      ctx.fillStyle = c.park;
      const count = Math.min(18, Math.floor(rect.w / 35));
      const y = rect.y + rect.h - 8;
      if (y < -10 || y > viewport.h + 10) return;
      for (let i = 0; i < count; i++) {
        const x = rect.x + 16 + i * (rect.w - 32) / Math.max(1, count - 1);
        if (x < -8 || x > viewport.w + 8) continue;
        ctx.beginPath(); ctx.arc(x, y, 2.7, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  private building(node: CityNode, rect: Rect, selected: boolean, hovered: boolean, changes: boolean) {
    const ctx = this.context, c = this.colors; const variant = hashPath(node.path) % 4;
    if (rect.w < 2 || rect.h < 2) return;
    ctx.fillStyle = c.districts[node.color]; ctx.fillRect(rect.x - 4, rect.y - 4, rect.w + 8, rect.h + 8);
    this.rounded(rect, 2); ctx.fillStyle = c.roofs[node.color]; ctx.fill();
    ctx.strokeStyle = c.line; ctx.lineWidth = 1; ctx.stroke();
    if (rect.w > 24 && rect.h > 24) {
      const inset = Math.min(9, rect.w * .12, rect.h * .12);
      const opacity = ctx.globalAlpha; ctx.strokeStyle = c.street; ctx.lineWidth = .75; ctx.globalAlpha *= .65;
      ctx.strokeRect(rect.x + inset, rect.y + inset, rect.w - inset * 2, rect.h - inset * 2); ctx.globalAlpha = opacity;
      ctx.fillStyle = c.street;
      if (variant === 0 && rect.w > 50 && rect.h > 50) ctx.fillRect(rect.x + rect.w * .35, rect.y + rect.h * .35, rect.w * .3, rect.h * .3);
      if (variant === 1 && rect.w > 40 && rect.h > 40) ctx.fillRect(rect.x + rect.w * .62, rect.y + rect.h * .62, rect.w * .38 + 1, rect.h * .38 + 1);
      if (variant === 2 && rect.w > 60 && rect.h > 60) { ctx.fillRect(rect.x + rect.w * .35, rect.y - 1, rect.w * .3, rect.h * .22); ctx.fillRect(rect.x + rect.w * .35, rect.y + rect.h * .78, rect.w * .3, rect.h * .22 + 1); }
      if (rect.w > 80 && rect.h > 50) {
        ctx.fillStyle = c.districts[node.color];
        for (let i = 0; i < Math.min(7, Math.floor(rect.w / 25)); i++) ctx.fillRect(rect.x + 13 + i * 20, rect.y + 12, 8, 5);
      }
    }
    if (changes && node.status && node.status !== 'snapshot') {
      ctx.strokeStyle = node.status === 'added' ? c.add : node.status === 'deleted' ? c.remove : c.modify;
      ctx.lineWidth = 2; if (node.status === 'deleted') ctx.setLineDash([5, 3]); this.rounded(rect, 2); ctx.stroke(); ctx.setLineDash([]);
      if (rect.w > 28 && rect.h > 24) { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(rect.x + rect.w - 19, rect.y + 3, 16, 16); ctx.fillStyle = c.street; ctx.font = '600 10px Geist, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(node.status[0].toUpperCase(), rect.x + rect.w - 11, rect.y + 15); }
    }
    if (selected || hovered) {
      this.rounded({ x: rect.x - 3, y: rect.y - 3, w: rect.w + 6, h: rect.h + 6 }, 4); ctx.strokeStyle = c.selected; ctx.lineWidth = 6; ctx.stroke(); ctx.strokeStyle = c.accent; ctx.lineWidth = selected ? 3 : 1.5; ctx.stroke();
    }
  }
  private label(text: string, x: number, y: number, maxWidth: number, size: number, backing: boolean, viewport: Viewport) {
    if (this.labels >= 150 || maxWidth < 45 || x < -10 || y < 10 || x > viewport.w + 10 || y > viewport.h - 10) return;
    size = Math.round(size * 2) / 2;
    const ctx = this.context, c = this.colors; ctx.font = `${size > 12 ? 500 : 450} ${size}px Geist, sans-serif`;
    let value = text; if (this.measure(value) > maxWidth) {
      let lo = 0, hi = text.length;
      while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.measure(text.slice(0, mid) + '\u2026') <= maxWidth) lo = mid; else hi = mid - 1; }
      value = text.slice(0, lo) + '\u2026';
    }
    const width = this.measure(value); const box = { x: x - width / 2 - 5, y: y - size - 3, w: width + 10, h: size + 10 };
    if (this.labelBoxes.some(other => intersects(other, box))) return;
    this.labelBoxes.push(box); this.labels++;
    if (backing) { this.rounded(box, 4); ctx.globalAlpha = .94; ctx.fillStyle = c.street; ctx.fill(); ctx.globalAlpha = 1; }
    ctx.fillStyle = size < 10 ? c.muted : c.ink; ctx.textAlign = 'center'; ctx.fillText(value, x, y);
  }
  private measure(text: string): number {
    const key = `${this.context.font}:${text}`; const cached = this.textWidths.get(key);
    if (cached !== undefined) return cached;
    const width = this.context.measureText(text).width;
    if (this.textWidths.size >= 8192) this.textWidths.clear();
    this.textWidths.set(key, width); return width;
  }  minimap(canvas: HTMLCanvasElement, layout: CityLayout, camera: Camera, viewport: Viewport) {
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const node = layout.nodes[camera.frame], c = this.colors;
    const scale = Math.min(160 / node.width, 100 / node.height); const ox = (180 - node.width * scale) / 2, oy = (120 - node.height * scale) / 2;
    ctx.clearRect(0, 0, 180, 120); ctx.fillStyle = c.ground; ctx.fillRect(0, 0, 180, 120);
    for (const id of node.children) { const child = layout.nodes[id]; ctx.fillStyle = c.roofs[child.color]; ctx.fillRect(ox + child.rect.x * scale, oy + child.rect.y * scale, child.rect.w * scale, child.rect.h * scale); }
    const x = ox + (camera.x - viewport.w / camera.scale / 2) * scale, y = oy + (camera.y - viewport.h / camera.scale / 2) * scale;
    ctx.strokeStyle = c.accent; ctx.lineWidth = 1.5; ctx.strokeRect(x, y, viewport.w / camera.scale * scale, viewport.h / camera.scale * scale);
  }
}
export function hitFeature(features: Feature[], x: number, y: number): number | undefined {
  for (let i = features.length - 1; i >= 0; i--) if (contains(features[i].rect, x, y)) return features[i].id;
}




