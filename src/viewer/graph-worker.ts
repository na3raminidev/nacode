import { InsightIndex } from '../insights/query.js';
import type { InsightData } from '../insights/model.js';
import type { FileEntry } from '../model.js';
let insightData: InsightData | undefined, insightIndex: InsightIndex | undefined, files: FileEntry[] = [];
import { EdgeTable, GraphIndex } from '../relations/query.js';
import type { GraphQuery, GraphSymbol, Coverage, Relation } from '../relations/model.js';
let table: EdgeTable, symbols: GraphSymbol[] = [], coverage: Coverage[] = [], index: GraphIndex | undefined;
let changedFiles = new Set<number>();
let blocks: string[] = [], cursor = 0, edgeCursor = 0, generation = 0;
const errors = (id: number | undefined, error: unknown) => self.postMessage({ type: 'error', id, message: (error as Error).message });
self.onmessage = async event => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      files = message.files ?? []; changedFiles = new Set(message.changedFiles ?? []); table = new EdgeTable(message.edges); blocks = message.blocks; self.postMessage({ type: 'need', block: blocks[cursor] });
    } else if (message.type === 'block') {
      if (message.block !== blocks[cursor] || !message.data) throw new Error('Missing or out-of-order graph block');
      const bytes = Uint8Array.from(atob(message.data), c => c.charCodeAt(0));
      const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); const value = JSON.parse(text);
      if (value.insights) insightData = value.insights; if (value.facts && insightData) insightData.facts.push(...value.facts);
      if (value.symbols) symbols.push(...value.symbols); if (value.coverage) coverage = value.coverage;
      for (const e of value.edges ?? []) table.set(edgeCursor++, { from: e[0], to: e[1], kind: e[2], confidence: e[3], versions: e[4], file: e[5], line: e[6], beforeLine: e[7] ?? undefined, reason: e[8], condition: e[9] ?? undefined });
      self.postMessage({ type: 'progress', loaded: ++cursor, total: blocks.length });
      if (cursor < blocks.length) self.postMessage({ type: 'need', block: blocks[cursor] });
      else {
        if (edgeCursor !== table.length) throw new Error('Incomplete graph edge table'); index = new GraphIndex({ symbols, edges: table });
        const counts: Record<string, number> = {}; for (const c of coverage) counts[c.status] = (counts[c.status] ?? 0) + 1;
        const context = new Set(changedFiles); for (let i = 0; i < table.length; i++) { const a = symbols[table.from[i]].file, b = symbols[table.to[i]].file; if (changedFiles.has(a) || changedFiles.has(b)) { if (a >= 0) context.add(a); if (b >= 0) context.add(b); } }
        if (insightData) { insightIndex = new InsightIndex(insightData, files, symbols, table); self.postMessage({ type: 'insights-ready', features: insightData.features, facts: insightData.facts.length }); }
        self.postMessage({ type: 'ready', symbols: symbols.length, edges: table.length, coverage: counts, context: [...context] });
      }
    } else if (message.type === 'insight-query') {
      if (!insightIndex) { self.postMessage({ type: 'insight-error', id: message.id, message: 'Insights were not embedded or are still loading.' }); return; }
      const token = ++generation;
      try { const result = await insightIndex.query(message.query, () => token !== generation); if (token === generation) self.postMessage({ type: 'insight-result', id: message.id, result }); }
      catch { self.postMessage({ type: 'insight-error', id: message.id, message: 'Evidence query failed; source browsing remains available.' }); }
    } else if (message.type === 'symbol') { const symbol = symbols[message.id]; if (symbol) self.postMessage({ type: 'symbol', symbol, side: message.side });
    } else if (message.type === 'cancel') generation++;
    else if (message.type === 'search') {
      if (!index) throw new Error('Graph is still loading'); const query = String(message.query).toLowerCase(); const mask = message.side === 'before' ? 1 : 2;
      const results = []; let count = 0;
      for (const symbol of symbols) if (symbol.versions & mask && symbol.kind !== 'external' && symbol.name !== '<module>' && (message.file === undefined || symbol.file === message.file) && (!query || symbol.name.toLowerCase().includes(query))) { count++; if (results.length < 80) results.push(symbol); }
      self.postMessage({ type: 'search', id: message.id, results, count });
    } else if (message.type === 'coverage') self.postMessage({ type: 'coverage', rows: coverage.filter(c => message.file === undefined || c.file === message.file).slice(0, 200), count: coverage.filter(c => message.file === undefined || c.file === message.file).length });
    else if (message.type === 'query') {
      if (!index) throw new Error('Graph is still loading'); const token = ++generation;
      const result = await index.query(message.query as GraphQuery, () => token !== generation); if (token !== generation) return;
      const ids = new Set<number>(); const edges = result.edges.map(id => { const edge = table.get(id); ids.add(edge.from); ids.add(edge.to); return { id, ...edge }; });
      self.postMessage({ type: 'result', id: message.id, result, edges, symbols: [...ids].map(id => symbols[id]) });
    } else if (message.type === 'overview') {
      if (!index) return; const token = ++generation; const groups = new Map<string, { edge: number; count: number }>(); const mask = message.side === 'before' ? 1 : 2;
      const district = (file: number) => (message.files[file] ?? '').split('/').slice(0, message.workspace ? 1 : 1).join('/');
      for (let i = 0; i < table.length; i++) {
        if (i % 50000 === 0) { await new Promise(resolve => setTimeout(resolve, 0)); if (token !== generation) return; }
        if (!(table.mask[i] & mask) || table.confidence[i] !== 0) continue;
        const a = symbols[table.from[i]], b = symbols[table.to[i]]; if (a.file < 0 || b.file < 0 || a.file === b.file) continue;
        const key = `${district(a.file)}>${district(b.file)}`; const group = groups.get(key); if (group) group.count++; else groups.set(key, { edge: i, count: 1 });

      }
      const selected = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 40); const ids = new Set<number>();
      const edges = selected.map(group => { const e = table.get(group.edge); ids.add(e.from); ids.add(e.to); return { id: group.edge, ...e, count: group.count }; });
      self.postMessage({ type: 'result', id: message.id, result: { edges: selected.map(g => g.edge), paths: [], truncated: groups.size > 40, visited: symbols.length, examined: table.length, reason: `District overview: ${selected.length} / ${groups.size} grouped connections. Each line represents a group, not one complete route.` }, edges, symbols: [...ids].map(id => symbols[id]) });
    }
  } catch (error) { errors(message.id, error); }
};
