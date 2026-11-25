import type { FileEntry } from '../model.js';
import type { Fact, InsightData, LensQuery, LensResult, LensRow, LensConnection } from './model.js';
import type { GraphSymbol, Side } from '../relations/model.js';
import { EdgeTable, KINDS } from '../relations/query.js';
const stage = (path: string) => /(?:test|spec|scenario)/i.test(path) ? 'Tests' : /\.md$/i.test(path) ? 'Docs' : /screen|page|component/i.test(path) ? 'UI' : /viewmodel|reducer|slice|intent/i.test(path) ? 'State' : /controller|remote\/service|client|service\.(kt|ts)/i.test(path) ? 'API' : /repository|entity|liquibase|migration/i.test(path) ? 'Data' : 'Logic';
const mask = (side: Side) => side === 'before' ? 1 : 2;
export class InsightIndex {
  private limited: Set<string>;
  private fileFacts = new Map<number, number[]>();
  private kindFacts = new Map<string, number[]>();
  private incoming = new Map<number, number[]>();
  private outgoing = new Map<number, number[]>();
  private writes = new Map<number, number[]>();
  private features = new Map<string, Set<number>>();
  constructor(readonly data: InsightData, private files: FileEntry[], private symbols: GraphSymbol[], private edges: EdgeTable) {
    this.limited = new Set((data.limited ?? []).map(f => `${f.file}:${f.side}`));
    for (const f of data.features) this.features.set(f.id, new Set(f.files));
    const add = (m: Map<number, number[]>, key: number, value: number) => { if (!m.has(key)) m.set(key, []); m.get(key)!.push(value); };
    data.facts.forEach((f, i) => { add(this.fileFacts, f.file, i); if (!this.kindFacts.has(f.kind)) this.kindFacts.set(f.kind, []); this.kindFacts.get(f.kind)!.push(i); });
    for (let i = 0; i < edges.length; i++) { const a = symbols[edges.from[i]]?.file, b = symbols[edges.to[i]]?.file; if (a >= 0) add(this.outgoing, a, i); if (b >= 0) add(this.incoming, b, i); if (edges.kind[i] === KINDS.indexOf('write') && edges.confidence[i] !== 2) add(this.writes, edges.to[i], i); }
  }
  async query(q: LensQuery, cancelled = () => false): Promise<LensResult> {
    const started = performance.now(), query = (q.text ?? '').trim().toLowerCase(), scope = q.feature ? this.features.get(q.feature) ?? new Set<number>() : undefined;
    const result: LensResult = { rows: [], total: 0, files: [], connections: [], note: '', partial: false }, visible = new Set<number>();
    const offset = Math.max(0, Math.min(5000000, Math.floor(q.offset ?? 0))); let work = 0, stopped = false;
    const connectionKeys = new Set<string>();
    const scoped = (id: number) => id >= 0 && !!this.files[id] && (!scope || scope.has(id)) && (q.file === undefined || q.file === id);
    const matches = (value: string) => !query || value.toLowerCase().includes(query);
    const add = (row: LensRow) => { const n = result.total++; if (n >= offset && n < offset + 100) { result.rows.push(row); if (row.file !== undefined) visible.add(row.file); for (const id of row.files ?? []) if (visible.size < 2000) visible.add(id); } };
    const tick = async () => { if (stopped) return false; if (++work % 8192 === 0) await new Promise(resolve => setTimeout(resolve, 0)); if (cancelled() || performance.now() - started > 1500) { stopped = true; result.partial = true; return false; } return true; };
    const sides: Side[] = q.side === 'compare' ? ['before', 'after'] : [q.side];
    const factMatches = (f: Fact) => matches(`${f.label} ${f.key} ${this.files[f.file].path} ${f.detail}`);
    const factRow = (f: Fact): LensRow => ({ title: f.label, detail: `${f.kind}${f.role ? ' / ' + f.role : ''}: ${f.detail}`, file: f.file, line: f.line, side: f.side, confidence: f.confidence, symbol: f.symbol });
    const finish = (note: string) => { result.files = [...visible]; result.note = `${note}${result.partial ? ' Budget reached; this result is partial.' : ''}${this.data.notes.length ? ' Extraction limits: ' + this.data.notes.slice(0, 5).join(' ') : ''}`; return result; };
    const connect = (fromFile: number, toFile: number, kind: string, versions: number, confidence: LensConnection['confidence'] = 'probable') => { const key = `${fromFile}:${toFile}:${kind}:${versions}:${confidence}`; if (fromFile !== toFile && !connectionKeys.has(key) && result.connections.length < 200 && fromFile >= 0 && toFile >= 0) { connectionKeys.add(key); result.connections.push({ fromFile, toFile, kind, versions, confidence }); } };
    if (q.lens === 'impact') {
      const seeds = this.files.filter(f => scoped(f.id) && (q.file !== undefined || f.status !== 'snapshot') && matches(f.path));
      if (!seeds.length) return finish('Select a file, or export a diff. Impact starts at changed files, never all files by default.');
      for (const side of sides) {
        const eligibleSeeds = seeds.filter(f => side === 'before' ? !!f.before : !!f.after); if (eligibleSeeds.length > 5000) result.partial = true;
        const seen = new Map<number, { depth: number; probable: boolean }>(), queue = eligibleSeeds.slice(0, 5000).map(f => ({ id: f.id, depth: 0, probable: false }));
        for (const seed of queue) seen.set(seed.id, { depth: 0, probable: false }); let examined = 0;
        for (let h = 0; h < queue.length; h++) {
          if (!await tick() || seen.size > 5000 || examined >= 200000) { result.partial = true; break; }
          const current = queue[h]; add({ title: this.files[current.id].path, detail: current.depth ? `${side}: ${current.depth === 1 ? 'direct' : 'transitive'} incoming dependency, ${current.depth} hop(s). Possible impact, not proven breakage.` : `${side}: selected/changed file`, file: current.id, side, line: 1, confidence: current.probable ? 'probable' : 'resolved', status: current.depth ? 'dependent' : 'seed' });
          if (current.depth >= 6) { if ((this.incoming.get(current.id)?.length ?? 0) > 0) result.partial = true; continue; }
          for (const id of this.incoming.get(current.id) ?? []) {
            if (++examined >= 200000 || !await tick()) { result.partial = true; break; }
            if (!(this.edges.mask[id] & mask(side)) || this.edges.confidence[id] === 2 || this.edges.confidence[id] === 1 && !q.probable) continue;
            const from = this.symbols[this.edges.from[id]].file; if (from < 0) continue;
            const probable = current.probable || this.edges.confidence[id] !== 0;
            connect(from, current.id, 'impact', mask(side), probable ? 'probable' : 'resolved');
            if (!seen.has(from)) { if (seen.size >= 5000) { result.partial = true; continue; } seen.set(from, { depth: current.depth + 1, probable }); queue.push({ id: from, depth: current.depth + 1, probable }); }
          }
        }
      }
      return finish('Before/after traversals are independent. Up to 6 hops / 5000 files / 200000 edges per side; external and unresolved calls do not prove impact.');
    }
    if (q.lens === 'branches') {
      for (const ref of this.data.history.refs) {
        if (!await tick()) break;
        const commits = this.data.history.commits.filter(c => c.repo === ref.repo && c.files.some(scoped) && matches(`${c.subject} ${c.hash}`));
        const present = commits.filter(c => c.refs.includes(ref.name)), byPatch = new Set(present.map(c => c.patch).filter(Boolean));
        const equivalent = commits.filter(c => !c.refs.includes(ref.name) && c.patch && byPatch.has(c.patch));
        add({ title: `${ref.repo} / ${ref.name}`, detail: `${ref.sha.slice(0, 12)}: ${present.length} scoped commits observed, ${equivalent.length} patch-equivalent candidates. ${ref.truncated ? 'History window truncated.' : 'Scanned history window complete.'} Missing commits may exist through squash or outside the window.`, files: [...new Set(present.flatMap(c => c.files))].slice(0, 2000), status: 'local ref' });
        for (const c of present.slice(0, 20)) add({ title: `${c.hash.slice(0, 10)} ${c.subject}`, detail: `${c.date} / ${ref.name}${c.revert ? ` / reverts ${c.revert.slice(0, 10)}` : ''}`, file: c.files.find(scoped), line: 1, files: c.files, status: c.revert ? 'revert' : 'observed commit' });
      }
      return finish(this.data.history.notes.join(' '));
    }
    if (q.lens === 'history') {
      const counts = new Map<number, number>(), together = new Map<number, number>();
      const commits = this.data.history.commits.filter(c => c.files.some(scoped));
      for (const c of commits) {
        if (!await tick()) break;
        for (const id of c.files) { if (scoped(id)) counts.set(id, (counts.get(id) ?? 0) + 1); if (q.file !== undefined && id !== q.file && !c.broad && c.files.length <= 30) together.set(id, (together.get(id) ?? 0) + 1); }
      }
      for (const [file, score] of [...counts].sort((a, b) => b[1] - a[1])) if (matches(this.files[file].path)) add({ title: this.files[file].path, detail: `${score} distinct scoped commit touches (bounded export). Not a defect count.`, file, line: 1, score, status: 'hotspot' });
      for (const [file, score] of [...together].sort((a, b) => b[1] - a[1]).slice(0, 30)) { add({ title: `Often changes with: ${this.files[file].path}`, detail: `${score} small commits shared with selected file. Historical correlation, not a dependency.`, file, line: 1, score, status: 'co-change' }); connect(q.file!, file, 'co-change', 3); }
      for (const c of commits) { if (!await tick()) break; if (matches(`${c.hash} ${c.subject} ${c.date}`)) add({ title: `${c.hash.slice(0, 10)} ${c.subject}`, detail: `${c.date} / ${c.repo} / ${c.refs.join(', ')}${c.revert ? ` / reverts ${c.revert.slice(0, 10)}` : ''}`, file: c.files.find(scoped), line: 1, files: c.files, status: c.revert ? 'revert' : 'commit' }); }
      return finish(this.data.history.notes.join(' '));
    }
    if (q.lens === 'feature') {
      const selected = this.files.filter(f => scoped(f.id) && matches(f.path) && (q.side === 'compare' || (q.side === 'before' ? f.before : f.after)));
      const selectedIds = new Set(selected.map(f => f.id));
      for (const file of selected) {
        if (!await tick()) break;
        add({ title: file.path, detail: `${stage(file.path)} / ${file.status} / ${q.feature?.startsWith('auto:') ? 'inferred file membership' : q.feature ? 'declared file membership' : 'included file'}`, file: file.id, line: 1, side: q.side === 'compare' ? file.after ? 'after' : 'before' : q.side, status: stage(file.path) });
        for (const e of this.outgoing.get(file.id) ?? []) { if (result.connections.length >= 200 || !await tick()) break; const target = this.symbols[this.edges.to[e]].file; if (selectedIds.has(target) && this.edges.confidence[e] !== 2 && (q.probable || this.edges.confidence[e] === 0) && (q.side === 'compare' || this.edges.mask[e] & mask(q.side))) connect(file.id, target, this.edges.get(e).kind, this.edges.mask[e], this.edges.get(e).confidence); }
      }
      return finish('File membership is not an execution sequence. Solid arrows use resolved graph edges; choose a symbol in Journeys for ordered paths. External dependencies may be outside the selected capability.');
    }
    const kinds = q.lens === 'state' ? ['state', 'error', 'navigation'] : q.lens === 'contracts' ? ['contract', 'schema'] : q.lens === 'recovery' ? ['async', 'transaction', 'table'] : q.lens === 'gates' ? ['gate', 'migration', 'table'] : q.lens === 'scenarios' ? ['scenario', 'test', 'document'] : ['component'];
    const candidates: Fact[] = [];
    const keys = new Map<string, Fact>();
    const paired = new Map<string, { before?: Fact; after?: Fact }>();
    const byKind = this.kindFacts;
    const indices = q.file !== undefined ? this.fileFacts.get(q.file) ?? [] : (function* () { for (const kind of kinds) yield* byKind.get(kind) ?? []; })();
    for (const id of indices) { if (!await tick()) break; const f = this.data.facts[id]; if (scoped(f.file) && kinds.includes(f.kind) && (q.side === 'compare' || f.side === q.side) && (q.lens === 'contracts' && q.side === 'compare' || factMatches(f))) { candidates.push(f); const k = `${f.side}:${f.kind}:${f.key}`, prior = keys.get(k); if (prior) { const first = ['declaration', 'dispatch', 'client'].includes(f.role ?? ''); connect(first ? f.file : prior.file, first ? prior.file : f.file, 'evidence association', mask(f.side)); } else keys.set(k, f); if (q.lens === 'contracts' && q.side === 'compare') { const key = `${f.file}:${f.kind}:${f.key}:${f.role ?? ''}`; if (!paired.has(key)) paired.set(key, {}); paired.get(key)![f.side] = f; } else add(factRow(f)); } }
    if (q.lens === 'contracts' && q.side === 'compare') {
      let projected = 0;
      for (const { before, after } of paired.values()) {
        if (++projected % 8192 === 0 && !await tick()) break;
        if (!(before && factMatches(before) || after && factMatches(after))) continue;
        const coverageGap = !before && after && this.limited.has(`${after.file}:before`) || !after && before && this.limited.has(`${before.file}:after`);
        const status = coverageGap ? 'unpaired (coverage limited)' : result.partial && (!before || !after) ? 'unpaired (partial scan)' : !before ? 'added' : !after ? 'removed' : before.fingerprint !== after.fingerprint ? 'changed' : 'unchanged';
        const f = after ?? before!; add({ ...factRow(f), status, detail: `${status}: ${f.detail}${before && after && status === 'changed' ? ` Before ${before.detail}; after ${after.detail}` : ''}` });
      }
    }
    // Shared keys are associations, never synthetic runtime edges.
    if (q.file !== undefined && ['state', 'contracts', 'scenarios'].includes(q.lens)) {
      for (const f of this.data.facts) {
        if (!await tick()) break;
        if (f.file === q.file || scope && !scope.has(f.file)) continue;
        if (keys.has(`${f.side}:${f.kind}:${f.key}`)) {
          add({ ...factRow(f), status: 'matching evidence' });
          connect(q.file, f.file, 'evidence association', mask(f.side));
        }
      }
    }
    if (q.file !== undefined && (q.lens === 'contracts' || q.lens === 'components')) {
      const consumers = new Set<string>();
      for (const e of this.incoming.get(q.file) ?? []) {
        if (!await tick()) break;
        const edge = this.edges.get(e), from = this.symbols[edge.from], to = this.symbols[edge.to];
        if (from.file < 0 || from.file === q.file || edge.confidence === 'unresolved' || edge.confidence === 'probable' && !q.probable) continue;
        for (const side of sides) if (edge.versions & mask(side)) {
          const key = `${from.id}:${to.id}:${side}`; if (consumers.has(key)) continue; consumers.add(key);
          add({ title: `${from.name} uses ${to.name}`, detail: edge.reason, file: from.file, symbol: from.id, line: side === 'before' ? edge.beforeLine ?? edge.line : edge.line, side, confidence: edge.confidence, status: 'graph consumer' });
          connect(from.file, to.file, edge.kind, mask(side), edge.confidence);
        }
      }
    }
    if (q.lens === 'components' && q.file !== undefined) {
      const names = new Set(candidates.filter(f => f.role === 'declaration').map(f => `${f.side}:${f.key}`));
      for (const f of this.data.facts) { if (!await tick()) break; if (f.kind === 'component' && f.role === 'consumer' && names.has(`${f.side}:${f.key}`) && f.file !== q.file) { add(factRow(f)); connect(q.file, f.file, 'UI use candidate', mask(f.side)); } }
    }
    if (q.lens === 'scenarios') {
      const basename = (s: string) => s.replace(/\\/g, '/').split('/').at(-1)!;
      const byName = new Map<string, number[]>(); for (const file of this.files) { const name = basename(file.path); if (!byName.has(name)) byName.set(name, []); byName.get(name)!.push(file.id); }
      for (const f of candidates) { if (!await tick()) break; if (f.role !== 'reference' || /^(?:https?:|\/|[A-Za-z]:)/.test(f.key)) continue; for (const id of byName.get(basename(f.key)) ?? []) { if (!await tick()) break; if (!(f.side === 'before' ? this.files[id].before : this.files[id].after)) continue; add({ title: `Referenced: ${this.files[id].path}`, detail: 'Included basename match to a document reference; verify path when names are duplicated. No test run implied.', file: id, line: 1, side: f.side, confidence: 'probable' }); connect(f.file, id, 'document reference', mask(f.side)); } }
    }
    if (q.lens === 'recovery') {
      for (const [target, edgeIds] of this.writes) {
        if (!await tick()) break;
        if (!matches(this.symbols[target].name)) continue;
        for (const side of sides) {
          const writers = new Map<number, number>(); let inScope = false;
          for (const e of edgeIds) {
            if (!await tick()) break;
            if (!(this.edges.mask[e] & mask(side))) continue;
            const file = this.symbols[this.edges.from[e]].file;
            if (file < 0) continue; writers.set(file, e); if (scoped(file)) inScope = true;
          }
          if (inScope && writers.size > 1) {
            const origin = [...writers.keys()].find(scoped)!;
            for (const [file, e] of writers) {
              add({ title: 'Shared write: ' + this.symbols[target].name, detail: 'Multiple included files write this table. Review transactions and scheduling; this is not proof of a race.', file, line: side === 'before' ? this.edges.before[e] || this.edges.line[e] : this.edges.line[e], side, confidence: 'probable', status: 'review point' });
              connect(origin, file, 'shared write review', mask(side));
            }
          }
        }
      }
    }
    return finish('Evidence associations are dashed and are not execution paths. Sides never mix. Static extraction may miss dynamic behavior; source is authoritative.');
  }
}
