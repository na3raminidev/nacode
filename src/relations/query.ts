import { sideMask, type GraphQuery, type GraphResult, type RelationGraph, type Relation, type GraphSymbol } from './model.js';
export const KINDS = ['call', 'event', 'http', 'read', 'write', 'async', 'state', 'import'] as const;
export const CONFIDENCE = ['resolved', 'probable', 'unresolved'] as const;
export class EdgeTable {
  readonly from: Uint32Array; readonly to: Uint32Array; readonly mask: Uint8Array; readonly kind: Uint8Array; readonly confidence: Uint8Array;
  readonly file: Int32Array; readonly line: Uint32Array; readonly before: Uint32Array; readonly reason: Uint32Array; readonly condition: Uint32Array;
  private strings = ['']; private dictionary = new Map<string, number>([['', 0]]);
  constructor(readonly length: number) {
    this.from = new Uint32Array(length); this.to = new Uint32Array(length); this.mask = new Uint8Array(length); this.kind = new Uint8Array(length); this.confidence = new Uint8Array(length);
    this.file = new Int32Array(length); this.line = new Uint32Array(length); this.before = new Uint32Array(length); this.reason = new Uint32Array(length); this.condition = new Uint32Array(length);
  }
  private intern(value: string) { let id = this.dictionary.get(value); if (id === undefined) { id = this.strings.length; this.strings.push(value); this.dictionary.set(value, id); } return id; }
  set(i: number, e: Relation) {
    this.from[i] = e.from; this.to[i] = e.to; this.mask[i] = e.versions; this.kind[i] = KINDS.indexOf(e.kind); this.confidence[i] = CONFIDENCE.indexOf(e.confidence);
    this.file[i] = e.file; this.line[i] = e.line; this.before[i] = e.beforeLine ?? 0; this.reason[i] = this.intern(e.reason); this.condition[i] = this.intern(e.condition ?? '');
  }
  get(i: number): Relation { return { from: this.from[i], to: this.to[i], kind: KINDS[this.kind[i]], confidence: CONFIDENCE[this.confidence[i]], versions: this.mask[i], file: this.file[i], line: this.line[i], beforeLine: this.before[i] || undefined, reason: this.strings[this.reason[i]], condition: this.strings[this.condition[i]] || undefined }; }
}
export class GraphIndex {
  readonly symbols: GraphSymbol[]; readonly edges: EdgeTable;
  private degrees: [Uint32Array, Uint32Array];
  private out: Uint32Array; private inbound: Uint32Array; private outOffsets: Uint32Array; private inOffsets: Uint32Array;
  constructor(graph: Pick<RelationGraph, 'symbols' | 'edges'> | { symbols: GraphSymbol[]; edges: EdgeTable }) {
    this.symbols = graph.symbols;
    this.edges = graph.edges instanceof EdgeTable ? graph.edges : new EdgeTable(graph.edges.length);
    if (!(graph.edges instanceof EdgeTable)) graph.edges.forEach((e, i) => this.edges.set(i, e));
    const n = this.symbols.length, m = this.edges.length;
    this.degrees = [new Uint32Array(n), new Uint32Array(n)]; for (let i = 0; i < m; i++) if (this.edges.kind[i] !== 7) { if (this.edges.mask[i] & 1) this.degrees[0][this.edges.from[i]]++; if (this.edges.mask[i] & 2) this.degrees[1][this.edges.from[i]]++; }
    this.outOffsets = new Uint32Array(n + 1); this.inOffsets = new Uint32Array(n + 1);
    for (let i = 0; i < m; i++) { if (this.edges.from[i] >= n || this.edges.to[i] >= n) throw new Error('Graph edge endpoint is outside the symbol table'); this.outOffsets[this.edges.from[i] + 1]++; this.inOffsets[this.edges.to[i] + 1]++; }
    for (let i = 1; i <= n; i++) { this.outOffsets[i] += this.outOffsets[i - 1]; this.inOffsets[i] += this.inOffsets[i - 1]; }
    this.out = new Uint32Array(m); this.inbound = new Uint32Array(m); const out = this.outOffsets.slice(), inbound = this.inOffsets.slice();
    for (let i = 0; i < m; i++) { this.out[out[this.edges.from[i]]++] = i; this.inbound[inbound[this.edges.to[i]]++] = i; }
  }
  async query(query: GraphQuery, cancelled = () => false): Promise<GraphResult> {
    const mask = sideMask(query.side), started = performance.now();
    const result: GraphResult = { edges: [], paths: [], truncated: false, visited: 0, examined: 0 };
    const maxNodes = Math.min(50000, query.maxNodes ?? 50000), maxEdges = Math.min(200000, query.maxEdges ?? 200000), deadline = Math.min(1000, query.deadlineMs ?? 1000), depth = Math.max(1, Math.min(24, query.depth ?? (query.mode === 'out' || query.mode === 'in' ? 1 : 24)));
    const expired = () => cancelled() || performance.now() - started > deadline || result.visited >= maxNodes || result.examined >= maxEdges;
    const eligible = (id: number, inspect = false) => !!(this.edges.mask[id] & mask) && (inspect || this.edges.confidence[id] === 0 || !!query.probable && this.edges.confidence[id] === 1) && this.edges.kind[id] !== 7;
    if (query.start === undefined || !this.symbols[query.start] || !(this.symbols[query.start].versions & mask)) return { ...result, reason: 'Select a symbol present in this version.' };
    if (query.target !== undefined && (!this.symbols[query.target] || !(this.symbols[query.target].versions & mask))) return { ...result, reason: 'Destination is absent from this version.' };
    const incoming = query.mode === 'in', offsets = incoming ? this.inOffsets : this.outOffsets, adjacency = incoming ? this.inbound : this.out;
    const inspect = query.mode === 'in' || query.mode === 'out'; const found = new Set<number>(), visited = new Set<number>();
    const queue: { node: number; nodes: number[]; edges: number[] }[] = [{ node: query.start, nodes: [query.start], edges: [] }]; let head = 0;
    while (head < queue.length) {
      if (expired()) { result.truncated = true; result.reason = cancelled() ? 'Cancelled' : 'Query budget reached; results are partial.'; break; }
      const current = queue[head++]; result.visited++;
      if (!inspect && current.edges.length && (query.target !== undefined ? current.node === query.target : this.symbols[current.node].kind !== 'external' && (this.symbols[current.node].kind === 'table' || this.degrees[query.side === 'before' ? 0 : 1][current.node] === 0))) {
        result.paths.push(current.edges); current.edges.forEach(e => found.add(e));
        if (result.paths.length === 3) { result.truncated = head < queue.length; result.reason = result.truncated ? 'Showing the first 3 shortest discovered routes; more may exist.' : undefined; break; } continue;
      }
      if (current.edges.length >= depth) { if (offsets[current.node] !== offsets[current.node + 1]) { result.truncated = true; result.reason ??= 'Depth limit reached; additional branches may exist.'; } continue; }
      for (let at = offsets[current.node]; at < offsets[current.node + 1]; at++) {
        if (expired() || queue.length - head >= maxNodes) { result.truncated = true; result.reason = 'Traversal budget reached; results are partial.'; break; }
        if (result.examined && result.examined % 1024 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (cancelled()) { result.truncated = true; result.reason = 'Cancelled'; break; } }
        const id = adjacency[at]; result.examined++; if (!eligible(id, inspect)) continue;
        const next = incoming ? this.edges.from[id] : this.edges.to[id];
        if (inspect) {
          if (found.size >= 200) { result.truncated = true; result.reason = 'Showing 200 relationships. Narrow the symbol or direction.'; break; }
          found.add(id); if (visited.has(next)) continue; visited.add(next);
        } else if (current.nodes.includes(next)) continue;
        queue.push({ node: next, nodes: [...current.nodes, next], edges: [...current.edges, id] });
      }
      if (result.visited % 128 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    result.edges = [...found];
    if (!result.edges.length && !result.reason) result.reason = 'No route found in the analyzed scope. Unresolved calls, exclusions or missing adapters may hide connections.';
    return result;
  }
}


