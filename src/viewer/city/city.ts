import { RouteOverlay, type MapRelation } from './routes.js';
import { formatBytes, type Manifest } from '../../model.js';
import { type CityLayout, type CityNode } from './layout.js';
import { type Camera, type Viewport, fitCamera, zoomCamera, rebase, parentCamera } from './camera.js';
import { CityRenderer, hitFeature, type CityFrame } from './renderer.js';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
interface Options { openFile: (id: number) => void; error: (message: string) => void }
export class City {
  readonly ready: Promise<void>;
  private layout?: CityLayout;
  private routes?: RouteOverlay;
  private emphasis?: Set<number>;
  private camera: Camera = { frame: 0, x: 800, y: 550, scale: .5 };
  private viewport: Viewport = { w: 1000, h: 700 };
  private renderer: CityRenderer;
  private worker: Worker;
  private canvas = $<HTMLCanvasElement>('city-canvas');
  private frame?: CityFrame;
  private selected?: number;
  private hovered?: number;
  private files = new Map<number, number>();
  private paths = new Map<string, number>();
  private raf = 0;
  private animation = 0;
  private locationTimer?: ReturnType<typeof setTimeout>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private observer: ResizeObserver;
  private pointer = new Map<number, { x: number; y: number }>();
  private down?: { x: number; y: number; moved: boolean };
  private clickTimer?: ReturnType<typeof setTimeout>;
  private selectionVersion = 0;
  private changes = false;
  private displayedFrame = -1;
  private destroyed = false;
  constructor(private manifest: Manifest, private options: Options) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.renderer = new CityRenderer(this.canvas); this.renderer.setTheme(document.documentElement.dataset.theme === 'dark');
    const source = $('city-worker-source')?.textContent;
    if (!source) throw new Error('Missing city layout worker. Rebuild this export.');
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(source), c => c.charCodeAt(0))], { type: 'text/javascript' }));
    this.worker = new Worker(url); URL.revokeObjectURL(url);
    this.worker.onmessage = event => {
      if (event.data.type === 'error') { this.fail(event.data.message); return; }
      this.layout = event.data.layout; this.routes = new RouteOverlay(this.layout!);
      for (const node of this.layout!.nodes) {
        this.paths.set(node.path, node.id); for (const alias of node.aliases) this.paths.set(alias, node.id);
        if (node.file !== undefined) this.files.set(node.file, node.id);
      }
      this.resize(); this.camera = fitCamera(this.layout!.nodes[0], this.viewport);
      $('city-loading').hidden = true; this.canvas.dataset.ready = 'true'; this.resolveReady(); this.invalidate();
      this.worker.terminate();
    };
    this.worker.onerror = event => this.fail(`City layout failed: ${event.message}`);
    this.worker.postMessage({ files: manifest.files.map(f => ({ id: f.id, path: f.path, status: f.status, additions: f.additions, deletions: f.deletions, before: f.before ? { bytes: f.before.bytes } : undefined, after: f.after ? { bytes: f.after.bytes } : undefined })), name: manifest.name });
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe($('map-view'));
    document.fonts.ready.then(() => { this.renderer.refreshFonts(); this.invalidate(); });
    this.bindControls();
    $('city-scope').textContent = manifest.mode === 'diff' ? manifest.context ? 'CHANGES + CONTEXT' : 'CHANGED FILES ONLY' : 'OFFLINE CODE CITY';
    $('city-total').textContent = `${manifest.files.length.toLocaleString()} buildings / ${formatBytes(manifest.totalBytes)}`;
    $<HTMLInputElement>('city-changes').disabled = manifest.mode !== 'diff';
    this.changes = manifest.mode === 'diff'; $<HTMLInputElement>('city-changes').checked = this.changes;
  }
  async setRelations(edges: MapRelation[], comparison = false) { await this.ready; this.routes?.set(edges, comparison); this.invalidate(); }
  async emphasizeFiles(files?: number[]) {
    await this.ready; this.emphasis = files ? new Set<number>() : undefined;
    if (files && this.layout) for (const file of files) { let id = this.files.get(file); while (id !== undefined && id >= 0) { this.emphasis!.add(id); id = this.layout.nodes[id].parent; } }
    this.invalidate();
  }
  highlightRoute(ids: number[]) { if (this.routes) this.routes.highlightedRoute = new Set(ids); this.invalidate(); }
  highlightRelation(id: number) { if (this.routes) this.routes.highlighted = id; this.invalidate(); }  private fail(message: string) { $('city-loading').textContent = `${message} Open Files to continue browsing.`; this.rejectReady(new Error(message)); this.options.error(message); }
  resize() {
    const bounds = this.canvas.getBoundingClientRect(); if (bounds.width < 1 || bounds.height < 1) return;
    this.viewport = { w: bounds.width, h: bounds.height }; this.invalidate();
  }
  theme(dark: boolean) { this.renderer.setTheme(dark); this.invalidate(); }
  private invalidate() { if (!this.raf && !this.destroyed) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }
  private draw() {
    if (!this.layout || this.canvas.clientWidth === 0 || $('map-view').hidden) return;
    const started = performance.now(); this.camera = rebase(this.camera, this.layout, this.viewport);
    this.frame = this.renderer.render(this.layout, this.camera, this.viewport, this.selected, this.hovered, this.changes, this.emphasis);
    if (this.routes) { const stats = this.routes.draw(this.canvas.getContext('2d')!, this.frame.features, this.camera, this.viewport, document.documentElement.dataset.theme === 'dark'); this.canvas.dataset.routes = String(stats.drawn); const status = $('route-map-status'); if (status) status.textContent = `${stats.drawn} map connections${stats.hidden ? ` / ${stats.hidden} outside view, external or unroutable` : ''}${stats.pending ? ' / routing...' : ''}`; if (stats.pending) this.invalidate(); }
    this.renderer.minimap($<HTMLCanvasElement>('city-minimap'), this.layout, this.camera, this.viewport);
    const focus = this.layout.nodes[this.camera.frame];
    this.canvas.dataset.frame = focus.path; this.canvas.dataset.scale = this.camera.scale.toFixed(5);
    this.canvas.dataset.camera = `${this.camera.frame}:${this.camera.x.toFixed(5)}:${this.camera.y.toFixed(5)}:${this.camera.scale.toFixed(5)}`;
    this.canvas.dataset.shapes = String(this.frame.features.length); this.canvas.dataset.buildings = String(this.frame.buildings);
    this.canvas.dataset.labels = String(this.frame.labels);
    $('city-depth').textContent = this.frame.buildings > 0 ? 'BUILDINGS' : focus.kind === 'city' ? 'DISTRICTS' : 'NEIGHBORHOODS';
    $('city-frame-name').textContent = focus.kind === 'city' ? this.manifest.name : focus.name;
    $('city-minimap-label').textContent = focus.kind === 'city' ? 'CITY OVERVIEW' : 'LOCAL OVERVIEW';
    if (this.displayedFrame !== focus.id) { this.displayedFrame = focus.id; this.updateNavigation(); }
    const duration = performance.now() - started;
    this.canvas.dispatchEvent(new CustomEvent('graphicode:city-frame', { detail: { duration, shapes: this.frame.features.length } }));
    clearTimeout(this.locationTimer); this.locationTimer = setTimeout(() => this.writeLocation(), 180);
  }
  private writeLocation() {
    if (!this.layout || this.destroyed) return;
    const params = new URLSearchParams(location.hash.slice(1));
    params.set('view', 'city'); params.set('focus', this.layout.nodes[this.camera.frame].path);
    params.set('cx', this.camera.x.toPrecision(8)); params.set('cy', this.camera.y.toPrecision(8)); params.set('z', this.camera.scale.toPrecision(8));
    history.replaceState(null, '', `#${params}`);
  }
  async restore(params: URLSearchParams) {
    await this.ready; if (!this.layout) return;
    const id = this.paths.get(params.get('focus') ?? '') ?? 0; const node = this.layout.nodes[id];
    this.camera = fitCamera(node.kind === 'file' ? this.layout.nodes[node.parent] : node, this.viewport);
    const x = Number(params.get('cx')), y = Number(params.get('cy')), scale = Number(params.get('z'));
    if (params.has('cx') && params.has('cy') && [x, y, scale].every(Number.isFinite) && scale > 0 && scale <= 128 && Math.abs(x) < 1e9 && Math.abs(y) < 1e9) this.camera = { ...this.camera, x, y, scale };
    this.invalidate();
  }
  async selectFile(file: number, fly = true) {
    const version = ++this.selectionVersion; await this.ready;
    if (version !== this.selectionVersion || !this.layout) return;
    const id = this.files.get(file); if (id === undefined) return;
    this.selected = id; this.canvas.dataset.selected = this.layout.nodes[id].path;
    if (fly) this.focus(id); else this.invalidate();
  }
  clearSelection() { this.selectionVersion++; this.selected = undefined; delete this.canvas.dataset.selected; this.invalidate(); }
  fit() { if (this.layout) this.travel(fitCamera(this.layout.nodes[0], this.viewport)); }
  private focus(id: number) {
    if (!this.layout) return; this.resize();
    const node = this.layout.nodes[id];
    if (node.kind === 'file') {
      const parent = this.layout.nodes[node.parent];
      const scale = Math.min(128, this.viewport.w * .6 / Math.max(node.rect.w, 1), this.viewport.h * .55 / Math.max(node.rect.h, 1));
      this.travel({ frame: parent.id, x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2, scale });
    } else {
      // Fit its parcel in the parent frame, so neighboring districts remain reachable.
      if (node.parent < 0) { this.fit(); return; }
      const scale = Math.min(this.viewport.w * .78 / node.rect.w, this.viewport.h * .75 / node.rect.h);
      this.travel({ frame: node.parent, x: node.rect.x + node.rect.w / 2, y: node.rect.y + node.rect.h / 2, scale });
    }
  }
  private travel(target: Camera) {
    if (!this.layout) return;
    cancelAnimationFrame(this.animation); this.animation = 0;
    let start = { ...this.camera }; const ancestors = new Set<number>();
    for (let id = start.frame; id >= 0; id = this.layout.nodes[id].parent) ancestors.add(id);
    let common = target.frame; while (!ancestors.has(common)) common = this.layout.nodes[common].parent;
    let steps = 0; while (start.frame !== common && steps++ < 32) start = parentCamera(start, this.layout);
    let end = { ...target }; while (end.frame !== common && steps++ < 64) end = parentCamera(end, this.layout);
    // Very deep cross-district journeys use an immediate local frame, avoiding precision loss.
    const ratio = end.scale / Math.max(start.scale, Number.MIN_VALUE);
    if (start.frame !== common || end.frame !== common || ![start.x, start.y, end.x, end.y, start.scale, end.scale].every(Number.isFinite) || matchMedia('(prefers-reduced-motion: reduce)').matches || !Number.isFinite(ratio) || ratio > 1e7 || ratio < 1e-7) { this.camera = target; this.invalidate(); return; }
    const began = performance.now();
    const animate = (now: number) => {
      const t = Math.min(1, (now - began) / 340); const eased = 1 - (1 - t) ** 3;
      this.camera = { frame: common, x: start.x + (end.x - start.x) * eased, y: start.y + (end.y - start.y) * eased, scale: start.scale * Math.exp(Math.log(ratio) * eased) };
      this.invalidate();
      if (t < 1) this.animation = requestAnimationFrame(animate); else { this.camera = target; this.animation = 0; this.invalidate(); }
    };
    this.animation = requestAnimationFrame(animate);
  }
  private zoom(factor: number, point = { x: this.viewport.w / 2, y: this.viewport.h / 2 }) {
    cancelAnimationFrame(this.animation); this.animation = 0;
    this.camera = zoomCamera(this.camera, this.viewport, point, factor); this.invalidate();
  }
  private pan(dx: number, dy: number) { cancelAnimationFrame(this.animation); this.animation = 0; this.camera.x -= dx / this.camera.scale; this.camera.y -= dy / this.camera.scale; this.invalidate(); }
  private updateNavigation() {
    if (!this.layout) return;
    const node = this.layout.nodes[this.camera.frame];
    const trail: CityNode[] = []; for (let id = node.id; id >= 0; id = this.layout.nodes[id].parent) trail.unshift(this.layout.nodes[id]);
    const crumbs = $('city-breadcrumbs'); crumbs.replaceChildren();
    const visible = trail.length > 4 ? [trail[0], ...trail.slice(-3)] : trail;
    for (const item of visible) {
      const button = document.createElement('button'); button.textContent = item.kind === 'city' ? this.manifest.name : item.name; button.title = item.path.replace(/^\0/, ''); button.onclick = () => item.id === 0 ? this.fit() : this.focus(item.id); crumbs.append(button);
    }
    const list = $('city-neighborhoods'); list.replaceChildren();
    for (const id of node.children) {
      const item = this.layout.nodes[id]; const button = document.createElement('button'); button.className = 'city-place';
      const title = document.createElement('span'); title.textContent = item.name;
      const meta = document.createElement('small'); meta.textContent = item.kind === 'file' ? formatBytes(item.bytes) : `${item.count.toLocaleString()} files`;
      button.append(title, meta); button.title = item.path.startsWith('\0') ? `${item.name} (visual grouping, not a source folder)` : item.path;
      button.onclick = () => item.file !== undefined ? this.options.openFile(item.file) : this.focus(item.id); list.append(button);
    }
    $('city-empty').hidden = this.manifest.files.length > 0;
  }
  private local(event: { clientX: number; clientY: number }) { const rect = this.canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  private pick(point: { x: number; y: number }) {
    if (!this.frame || !this.layout) return;
    const relation = this.routes?.hit(point.x, point.y); if (relation !== undefined) { this.canvas.dispatchEvent(new CustomEvent('graphicode:relation-select', { detail: relation })); return; }
    const id = hitFeature(this.frame.features, point.x, point.y); if (id === undefined) return;
    const node = this.layout.nodes[id];
    if (node.file !== undefined) this.options.openFile(node.file);
    else if (node.id === this.camera.frame) this.zoom(1.8, point);
    else this.focus(node.id);
  }
  private hover(point: { x: number; y: number }) {
    if (!this.frame || !this.layout) return;
    const id = hitFeature(this.frame.features, point.x, point.y);
    if (this.hovered !== id) { this.hovered = id; this.invalidate(); }
    const tooltip = $('city-tooltip'); const node = id === undefined ? undefined : this.layout.nodes[id];
    if (!node || node.kind === 'city') { tooltip.hidden = true; return; }
    $('city-tooltip-name').textContent = node.path.startsWith('\0') ? node.name : node.path;
    $('city-tooltip-meta').textContent = `${node.kind === 'file' ? node.status === 'snapshot' ? 'FILE' : node.status?.toUpperCase() : node.kind.toUpperCase()} / ${formatBytes(node.bytes)}${node.kind !== 'file' ? ` / ${node.count} files` : ''}`;
    tooltip.style.left = `${Math.max(10, Math.min(this.viewport.w - 280, point.x + 18))}px`;
    tooltip.style.top = `${Math.max(10, Math.min(this.viewport.h - 65, point.y + 18))}px`; tooltip.hidden = false;
  }
  private bindControls() {
    $('city-zoom-in').onclick = () => this.zoom(1.5); $('city-zoom-out').onclick = () => this.zoom(1 / 1.5);
    $('city-fit').onclick = () => this.fit();
    $('city-parent').onclick = () => { if (this.layout) { const node = this.layout.nodes[this.camera.frame]; this.focus(node.parent >= 0 ? node.parent : 0); } };
    $<HTMLInputElement>('city-changes').onchange = event => { this.changes = (event.target as HTMLInputElement).checked; this.invalidate(); };
    this.canvas.addEventListener('wheel', event => { event.preventDefault(); $('city-tooltip').hidden = true; this.zoom(Math.exp(-Math.max(-300, Math.min(300, event.deltaY * (event.deltaMode === 1 ? 16 : 1))) * .003), this.local(event)); }, { passive: false });
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.pointerType === 'mouse') return;
      this.canvas.focus({ preventScroll: true }); this.canvas.setPointerCapture(event.pointerId);
      const point = this.local(event); this.pointer.set(event.pointerId, point);
      this.down = { ...point, moved: this.pointer.size > 1 }; this.canvas.classList.add('dragging'); $('city-tooltip').hidden = true;
    });
    this.canvas.addEventListener('pointermove', event => {
      const point = this.local(event), previous = this.pointer.get(event.pointerId);
      if (!previous) { if (event.pointerType === 'mouse') this.hover(point); return; }
      if (this.down && Math.hypot(point.x - this.down.x, point.y - this.down.y) > 4) this.down.moved = true;
      if (this.pointer.size >= 2) {
        const others = [...this.pointer.entries()].find(([id]) => id !== event.pointerId)![1];
        const oldDistance = Math.hypot(previous.x - others.x, previous.y - others.y);
        const newDistance = Math.hypot(point.x - others.x, point.y - others.y);
        const before = { x: (previous.x + others.x) / 2, y: (previous.y + others.y) / 2 };
        const after = { x: (point.x + others.x) / 2, y: (point.y + others.y) / 2 };
        if (oldDistance > 2) this.zoom(newDistance / oldDistance, before);
        this.pan(after.x - before.x, after.y - before.y); if (this.down) this.down.moved = true;
      } else this.pan(point.x - previous.x, point.y - previous.y);
      this.pointer.set(event.pointerId, point);
    });
    const end = (event: PointerEvent) => {
      const wasTracked = this.pointer.delete(event.pointerId);
      if (event.type === 'pointerup' && wasTracked && !this.down?.moved && this.pointer.size === 0) {
        clearTimeout(this.clickTimer); const point = this.local(event); this.clickTimer = setTimeout(() => this.pick(point), event.pointerType === 'touch' ? 0 : 180);
      }
      if (!this.pointer.size) { this.down = undefined; this.canvas.classList.remove('dragging'); }
      else if (this.down) this.down.moved = true;
    };
    this.canvas.addEventListener('pointerup', end); this.canvas.addEventListener('pointercancel', end); this.canvas.addEventListener('lostpointercapture', end);
    this.canvas.addEventListener('pointerleave', () => { $('city-tooltip').hidden = true; this.hovered = undefined; this.invalidate(); });
    this.canvas.addEventListener('dblclick', event => { event.preventDefault(); clearTimeout(this.clickTimer); this.zoom(2, this.local(event)); });
    this.canvas.addEventListener('keydown', event => {
      const key = event.key; if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', '+', '=', '-', 'Home', 'Enter', 'Escape'].includes(key)) return;
      event.preventDefault();
      if (key === 'ArrowUp') this.pan(0, 80); if (key === 'ArrowDown') this.pan(0, -80);
      if (key === 'ArrowLeft') this.pan(80, 0); if (key === 'ArrowRight') this.pan(-80, 0);
      if (key === '+' || key === '=') this.zoom(1.5); if (key === '-') this.zoom(1 / 1.5);
      if (key === 'Home') this.fit(); if (key === 'Enter') this.pick({ x: this.viewport.w / 2, y: this.viewport.h / 2 });
      if (key === 'Escape') $('city-parent').click();
    });
    $<HTMLCanvasElement>('city-minimap').onclick = event => {
      if (!this.layout) return; cancelAnimationFrame(this.animation); this.animation = 0;
      const canvas = event.currentTarget as HTMLCanvasElement; const rect = canvas.getBoundingClientRect();
      const point = { x: (event.clientX - rect.left) * 180 / rect.width, y: (event.clientY - rect.top) * 120 / rect.height };
      const node = this.layout.nodes[this.camera.frame]; const scale = Math.min(160 / node.width, 100 / node.height);
      this.camera.x = (point.x - (180 - node.width * scale) / 2) / scale; this.camera.y = (point.y - (120 - node.height * scale) / 2) / scale; this.invalidate();
    };
  }
  destroy() { this.destroyed = true; cancelAnimationFrame(this.raf); cancelAnimationFrame(this.animation); clearTimeout(this.clickTimer); clearTimeout(this.locationTimer); this.observer.disconnect(); this.worker.terminate(); }
}




