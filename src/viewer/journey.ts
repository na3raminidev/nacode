import type { Manifest } from '../model.js';
import type { City } from './city/city.js';
import type { GraphSymbol, Relation, GraphResult, GraphQuery, Side, Coverage } from '../relations/model.js';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (tag: string, value: string, cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e; };
interface DisplayEdge extends Relation { id: number; count?: number }
export class Journey {
  private worker?: Worker;
  private id = 0; private searchId = 0; private ready = false;
  private from?: GraphSymbol; private to?: GraphSymbol; private file?: number;
  private searchTarget: 'from' | 'to' = 'from'; private timer?: ReturnType<typeof setTimeout>;
  private symbols = new Map<number, GraphSymbol>(); private edges: DisplayEdge[] = [];
  private mode: GraphQuery['mode'] = 'journey'; private context: number[] = [];
  private lastResult?: GraphResult; private partialComparison?: { edges: DisplayEdge[]; result: GraphResult; symbols: GraphSymbol[] };
  constructor(private manifest: Manifest, private city: City | undefined, private open: (file: number, line: number, side: Side) => void) {
    $('journeys-open').onclick = () => this.toggle(); $('journey-close').onclick = () => this.toggle(false);
    $('journey-clear').onclick = () => { this.id++; this.worker?.postMessage({ type: 'cancel' }); this.partialComparison = undefined; $('journey-evidence').hidden = true; this.from = this.to = undefined; this.edges = []; this.symbols.clear(); this.labels(); $('journey-results').replaceChildren(); void city?.setRelations([]).catch(() => {}); this.restoreContext(); $('journey-status').textContent = 'Choose a starting symbol. Static paths are not runtime traces.'; };
    $('journey-from').onclick = () => this.search('from'); $('journey-to').onclick = () => this.search('to');
    $<HTMLInputElement>('journey-search').oninput = () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.find(), 120); };
    for (const mode of ['in', 'out', 'journey', 'path', 'overview'] as const) $(`journey-${mode}`).onclick = () => { this.mode = mode; this.run(); };
    $('journey-cancel').onclick = () => { this.id++; this.partialComparison = undefined; this.worker?.postMessage({ type: 'cancel' }); $('journey-status').textContent = 'Cancelled. Previous results retained.'; };
    $('journey-version').onchange = () => { this.partialComparison = undefined; this.run(); };
    $('journey-probable').onchange = () => this.run();
    $('journey-context').onchange = () => this.restoreContext();
    $('journey-coverage').onclick = () => { this.worker?.postMessage({ type: 'coverage', file: this.file }); };
    $('city-canvas').addEventListener('graphicode:relation-select', event => { const id = (event as CustomEvent<number>).detail; this.toggle(true); this.selectEdge(id); });
    if (manifest.mode !== 'diff') { for (const option of Array.from($<HTMLSelectElement>('journey-version').options)) if (option.value !== 'after') option.disabled = true; }
    if (!manifest.relationships) { $('journey-status').textContent = 'Relationships are not embedded in this export. Regenerate with --relationships auto.'; return; }
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob($('graph-worker-source').textContent!), c => c.charCodeAt(0))], { type: 'text/javascript' }));
    this.worker = new Worker(url); URL.revokeObjectURL(url);
    this.worker.onerror = event => { $('journey-status').textContent = `Graph unavailable: ${event.message}. Files and code remain accessible.`; };
    this.worker.onmessage = event => this.receive(event.data);
    this.worker.postMessage({ type: 'init', ...manifest.relationships, changedFiles: manifest.mode === 'diff' ? manifest.files.filter(f => f.status !== 'snapshot').map(f => f.id) : [] });
    window.addEventListener('beforeunload', () => this.worker?.terminate());
  }
  selectFile(file: number) { this.file = file; if (!$('journey-panel').hidden && !this.from) this.search('from'); }
  private toggle(open = $('journey-panel').hidden) { $('journey-panel').hidden = !open; $('journeys-open').setAttribute('aria-expanded', String(open)); if (open && this.ready && !this.from) this.search('from'); }
  private version() { return $<HTMLSelectElement>('journey-version').value; }
  private restoreContext() { void this.city?.emphasizeFiles(this.manifest.context && !$<HTMLInputElement>('journey-context').checked ? this.context : undefined); }
  private labels() { $('journey-from').textContent = this.from ? `From: ${this.from.name}` : 'Choose start'; $('journey-to').textContent = this.to ? `To: ${this.to.name}` : 'Choose destination (optional)'; }
  private search(target: 'from' | 'to') { this.searchTarget = target; $('journey-search-label').textContent = target === 'from' ? 'STARTING SYMBOL' : 'DESTINATION SYMBOL'; $('journey-search-results').hidden = false; $<HTMLInputElement>('journey-search').value = ''; this.find(); $<HTMLInputElement>('journey-search').focus(); }
  private find() {
    if (!this.ready) return; const query = $<HTMLInputElement>('journey-search').value;
    this.worker!.postMessage({ type: 'search', id: ++this.searchId, query, side: this.version() === 'before' ? 'before' : 'after', file: !query && this.searchTarget === 'from' ? this.file : undefined });
  }
  private run() {
    if (!this.ready) { $('journey-status').textContent = 'Graph is still loading or was not exported.'; return; }
    if (this.mode !== 'overview' && !this.from || this.mode === 'path' && !this.to) { $('journey-status').textContent = this.mode === 'path' ? 'Choose start and destination.' : 'Choose a starting symbol.'; this.search(!this.from ? 'from' : 'to'); return; }
    this.worker!.postMessage({ type: 'cancel' }); this.partialComparison = undefined; $('journey-status').textContent = 'Finding bounded static routes...'; this.sendQuery(this.version() === 'compare' ? 'before' : this.version() as Side);
  }
  private sendQuery(side: Side) {
    const id = ++this.id;
    if (this.mode === 'overview') this.worker!.postMessage({ type: 'overview', id, side, files: this.manifest.files.map(f => f.path), workspace: !!this.manifest.repositories });
    else this.worker!.postMessage({ type: 'query', id, query: { mode: this.mode, start: this.from?.id, target: this.mode === 'path' ? this.to?.id : undefined, side, probable: $<HTMLInputElement>('journey-probable').checked } });
  }
  private receive(message: any) {
    if (message.type === 'need') this.worker!.postMessage({ type: 'block', block: message.block, data: $(message.block)?.textContent });
    else if (message.type === 'progress') $('journey-status').textContent = `Loading graph ${message.loaded}/${message.total}... Map and source are ready to use.`;
    else if (message.type === 'ready') { this.ready = true; this.context = message.context; $('journey-panel').dataset.ready = 'true'; $('journey-status').textContent = `${message.symbols.toLocaleString()} symbols / ${message.edges.toLocaleString()} connections. Static analysis, not runtime traffic.`; $('journey-coverage').textContent = `Coverage: ${message.coverage.parsed ?? 0} parsed / ${(message.coverage.partial ?? 0) + (message.coverage.unsupported ?? 0) + (message.coverage.skipped ?? 0)} limited`; this.restoreContext(); if (!$('journey-panel').hidden) this.find(); }
    else if (message.type === 'search' && message.id === this.searchId) {
      const list = $('journey-search-results'); list.replaceChildren();
      for (const symbol of message.results as GraphSymbol[]) {
        const button = text('button', '', 'journey-symbol'); button.append(text('strong', symbol.name), text('small', `${this.manifest.files[symbol.file]?.path ?? symbol.repo} : ${this.version() === 'before' ? symbol.beforeLine ?? symbol.line : symbol.line}`));
        button.onclick = () => { if (this.searchTarget === 'from') this.from = symbol; else this.to = symbol; this.labels(); list.hidden = true; void this.city?.selectFile(symbol.file, false); if (this.searchTarget === 'from') { this.mode = 'out'; this.run(); } }; list.append(button);
      }
      list.append(text('p', `Showing ${message.results.length} / ${message.count}. Type to search all included symbols.`, 'muted'));
    } else if (message.type === 'coverage') {
      const list = $('journey-results'); list.replaceChildren(text('p', `Coverage: showing ${message.rows.length} / ${message.count} records. Parsed does not mean complete runtime coverage.`, 'muted'));
      for (const row of message.rows as Coverage[]) { const item = text('div', '', 'journey-evidence'); item.append(text('strong', `${this.manifest.files[row.file]?.path ?? 'Unknown'} / ${row.side} / ${row.status}`), text('p', row.notes.join(' '))); list.append(item); }
    } else if (message.type === 'result' && message.id === this.id) {
      if (this.version() === 'compare' && !this.partialComparison) { this.partialComparison = message; this.sendQuery('after'); return; }
      const before = this.partialComparison; this.partialComparison = undefined;
      this.edges = before ? [...new Map([...before.edges, ...message.edges].map(e => [e.id, e])).values()] as DisplayEdge[] : message.edges;
      this.symbols = new Map([...(before?.symbols ?? []), ...message.symbols].map((s: GraphSymbol) => [s.id, s])); this.lastResult = message.result;
      this.showResult(message.result, before?.result); void this.city?.setRelations(this.edges.map(e => ({ id: e.id, fromFile: this.symbols.get(e.from)!.file, toFile: this.symbols.get(e.to)!.file, confidence: e.confidence, versions: e.versions, kind: e.kind, count: e.count, route: message.result.paths.findIndex((p: number[]) => p.includes(e.id)) >= 0 ? message.result.paths.findIndex((p: number[]) => p.includes(e.id)) : undefined })), this.version() === 'compare');
      const focus = [...new Set([...this.edges.flatMap(e => [this.symbols.get(e.from)!.file, this.symbols.get(e.to)!.file]), ...this.context])].filter(f => f >= 0);
      void this.city?.emphasizeFiles(focus.length && this.mode !== 'overview' ? focus : this.manifest.context && !$<HTMLInputElement>('journey-context').checked ? this.context : undefined);
      if (this.mode === 'path' || this.mode === 'journey' || this.mode === 'overview') this.city?.fit();
    } else if (message.type === 'error' && (message.id === undefined || message.id === this.id)) $('journey-status').textContent = `Graph unavailable: ${message.message}. Code browsing remains available.`;
  }
  private showResult(result: GraphResult, before?: GraphResult) { $('journey-evidence').hidden = true;
    const list = $('journey-results'); list.replaceChildren();
    $('journey-status').textContent = `${this.edges.length} connections / ${result.visited} states inspected. ${result.reason ?? ''}${before ? ` Before: ${before.reason ?? `${before.paths.length} routes`}. Before and after are queried separately.` : ''}`;
    if (before) list.append(text('h3', 'Before / after comparison'));
    for (const [side, data] of before ? [['before', before], ['after', result]] as const : [[this.version(), result]] as const) for (let i = 0; i < data.paths.length; i++) {
      const route = text('button', `${side.toUpperCase()} / Route ${i + 1} / ${data.paths[i].length} steps`, 'journey-path'); route.onclick = () => { const ids = new Set(data.paths[i]); this.city?.highlightRoute(data.paths[i]); for (const item of list.querySelectorAll<HTMLElement>('[data-edge]')) item.classList.toggle('on-route', ids.has(Number(item.dataset.edge))); }; list.append(route);
    }
    for (const edge of this.edges) {
      const a = this.symbols.get(edge.from)!, b = this.symbols.get(edge.to)!; const button = text('button', '', 'journey-edge'); button.dataset.edge = String(edge.id);
      const status = this.manifest.mode !== 'diff' ? '' : edge.versions === 1 ? 'REMOVED' : edge.versions === 2 ? 'ADDED' : 'UNCHANGED';
      button.append(text('small', `${edge.kind.toUpperCase()} / ${edge.confidence.toUpperCase()} ${status}${edge.count ? ` / ${edge.count} grouped` : ''}`), text('strong', `${a.name} → ${b.name}`), text('span', edge.condition ?? edge.reason)); button.onclick = () => this.selectEdge(edge.id); list.append(button);
    }
  }
  private selectEdge(id: number) {
    const e = this.edges.find(edge => edge.id === id); if (!e) return;
    this.city?.highlightRelation(id); const side: Side = this.version() === 'before' || this.version() === 'compare' && e.versions === 1 ? 'before' : 'after';
    const file = this.manifest.files[e.file], line = side === 'before' ? e.beforeLine ?? e.line : e.line;
    const evidence = $('journey-evidence'); evidence.hidden = false; evidence.replaceChildren(text('strong', `${e.kind} / ${e.confidence}`), text('p', e.reason), text('p', `${file?.path ?? 'External'}:${line} (${side})`));
    if (e.condition) evidence.append(text('p', `Condition: ${e.condition}`));
    const open = text('button', 'Open source evidence', 'journey-path'); open.onclick = () => { this.open(e.file, line, side); if (matchMedia('(max-width: 760px)').matches) this.toggle(false); }; evidence.append(open);
    const target = this.symbols.get(e.to); if (target && target.file >= 0) { const next = text('button', 'Continue from destination', 'journey-path'); next.onclick = () => { this.from = target; this.labels(); this.mode = 'out'; this.run(); }; evidence.append(next); }
  }
}



