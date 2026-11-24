import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import ts from 'typescript';
import { parseDocument } from 'yaml';
import type { AnalysisFile, AnalysisConfig, ParsedFile, Declaration, RelationGraph, GraphSymbol, Relation, Side } from './model.js';
import { sideMask } from './model.js';
const REVISION = 'relations-2';
const supported = /\.(?:[cm]?[jt]sx?|kt|kts|java)$/;
interface Unit { input: AnalysisFile; parsed: ParsedFile }
interface Entry { unit: Unit; decl: Declaration; id: number }
export async function parseFiles(files: AnalysisFile[], assets: string, cache: string): Promise<Unit[]> {
  await mkdir(cache, { recursive: true }); const result: Unit[] = new Array(files.length); let next = 0;
  const workers: Worker[] = [];
  try {
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, os.availableParallelism() - 1), files.length) }, async () => {
      const worker = new Worker(path.join(assets, 'extract-worker.mjs')); workers.push(worker);
      for (;;) {
        const index = next++; if (index >= files.length) break; const input = files[index];
        const digest = createHash('sha256').update(`${REVISION}:${path.extname(input.path)}:`).update(input.text).digest('hex'); const target = path.join(cache, `${digest}.json`);
        let parsed: ParsedFile | undefined;
        try { const data = JSON.parse(await readFile(target, 'utf8')); if (data.revision === REVISION && Array.isArray(data.parsed?.declarations)) parsed = data.parsed; } catch {}
        if (!parsed) {
          parsed = await new Promise<ParsedFile>((resolve, reject) => {
            const cleanup = () => { worker.off('message', message); worker.off('error', error); clearTimeout(timer); };
            const message = (value: { result?: ParsedFile; error?: string }) => { cleanup(); resolve(value.result ?? { language: path.extname(input.path), declarations: [], imports: [], packageName: '', notes: [value.error ?? 'Analyzer failed'] }); };
            const error = (err: Error) => { cleanup(); reject(err); };
            const timer = setTimeout(() => { cleanup(); reject(new Error(`Analyzer timeout: ${input.path}`)); }, 30000);
            worker.once('message', message); worker.once('error', error); worker.postMessage({ id: index, path: input.path, text: input.text });
          });
          await writeFile(target, JSON.stringify({ revision: REVISION, parsed })).catch(() => {});
        }
        result[index] = { input, parsed };
      }
    }));
  } finally { await Promise.all(workers.map(w => w.terminate())); }
  return result;
}
function annotations(header: string, names: string[]): { name: string; body: string }[] {
  const values: { name: string; body: string }[] = [];
  for (const match of header.matchAll(/@(?:[\w]+\.)*(\w+)(?:\s*\(([^)]*)\))?/g)) if (names.includes(match[1])) values.push({ name: match[1], body: match[2] ?? '' });
  return values;
}
function mapping(header: string, retrofit = false): { method: string; path: string; constrained: boolean }[] {
  const names = retrofit ? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'HTTP'] : ['RequestMapping', 'GetMapping', 'PostMapping', 'PutMapping', 'PatchMapping', 'DeleteMapping', 'HeadMapping'];
  return annotations(header, names).flatMap(a => {
    const match = a.body.match(/(?:\b(?:value|path)\s*=\s*)?(?:\[|\{)?\s*"([^"\n]*)"/);
    const route = match?.[1] ?? ''; const pathValue = a.body.match(/\b(?:value|path)\s*=\s*"([^"\n]*)"/)?.[1] ?? route;
    const dynamic = !match && a.body.trim() !== '' || /[\[{}]/.test(a.body.replace(/"[^"]*"/g, ''));
    const method = a.name === 'RequestMapping' ? a.body.match(/RequestMethod\.(\w+)/)?.[1] ?? '*' : a.name === 'HTTP' ? a.body.match(/method\s*=\s*"(\w+)"/)?.[1] ?? 'DYNAMIC' : a.name.replace('Mapping', '').toUpperCase();
    return [{ method, path: dynamic ? '<dynamic mapping>' : pathValue, constrained: /\b(params|headers|consumes|produces)\s*=/.test(a.body) }];
  });
}
function normalizedRoute(value: string): string {
  return ('/' + value).replace(/\/+/g, '/').replace(/\/$/, '').replace(/\{[^}]+\}/g, '{}') || '/';
}
function qualifiedType(unit: Unit, type: string): string {
  if (type.includes('.')) return type;
  const explicit = unit.parsed.imports.filter(x => x.endsWith('.' + type));
  return explicit.length === 1 ? explicit[0] : unit.parsed.packageName ? `${unit.parsed.packageName}.${type}` : type;
}
// TypeScript sees only included in-memory sources. It cannot load plugins or execute project configuration.
function compilerTargets(units: Unit[]): Map<string, { file: number; start: number; abstract: boolean }> {
  const targets = new Map<string, { file: number; start: number; abstract: boolean }>();
  const groups = new Map<string, Unit[]>();
  for (const u of units) if (u.parsed.language === 'typescript') { const key = `${u.input.repo}:${u.input.side}`; if (!groups.has(key)) groups.set(key, []); groups.get(key)!.push(u); }
  for (const group of groups.values()) {
    const input = new Map(group.map(u => [`/${u.input.path}`, u]));
    const options: ts.CompilerOptions = { noEmit: true, noLib: true, allowJs: true, checkJs: true, target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve, skipLibCheck: true };
    const host = ts.createCompilerHost(options); host.getCurrentDirectory = () => '/'; host.fileExists = name => input.has(name); host.readFile = name => input.get(name)?.input.text;
    host.getSourceFile = (name, version) => input.has(name) ? ts.createSourceFile(name, input.get(name)!.input.text, version, true) : undefined;
    const directories = new Set<string>(['/']); for (const name of input.keys()) { let dir = path.posix.dirname(name); while (dir !== '/') { directories.add(dir); dir = path.posix.dirname(dir); } }
    host.directoryExists = dir => directories.has(dir.replace(/\/$/, '') || '/'); host.writeFile = () => {};
    const program = ts.createProgram([...input.keys()], options, host); const checker = program.getTypeChecker();
    for (const source of program.getSourceFiles()) {
      const unit = input.get(source.fileName)!;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (declaration) { const destination = input.get(declaration.getSourceFile().fileName); if (destination) targets.set(`${unit.input.file}:${unit.input.side}:${node.getStart(source)}`, { file: destination.input.file, start: declaration.getStart(), abstract: ts.isMethodSignature(declaration) || ts.isCallSignatureDeclaration(declaration) }); }
        }
        if (ts.isIdentifier(node) && ts.isJsxExpression(node.parent) && ts.isJsxAttribute(node.parent.parent)) {
          let symbol = checker.getSymbolAtLocation(node); if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
          let declaration: ts.Node | undefined = symbol?.valueDeclaration; if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) declaration = declaration.initializer;
          if (declaration) { const destination = input.get(declaration.getSourceFile().fileName); if (destination) targets.set(`${unit.input.file}:${unit.input.side}:${node.getStart(source)}`, { file: destination.input.file, start: declaration.getStart(), abstract: false }); }
        }
        ts.forEachChild(node, visit);
      }; visit(source);
    }
  }
  return targets;
}
export async function analyze(files: AnalysisFile[], config: AnalysisConfig, assets: string, cache: string): Promise<RelationGraph> {
  const eligible = files.filter(f => !f.skipReason && supported.test(f.path) && Buffer.byteLength(f.text) <= 2 * 1024 * 1024);
  const units = await parseFiles(eligible, assets, cache);
  return assemble(units, files, config);
}
export function assemble(units: Unit[], files: AnalysisFile[], config: AnalysisConfig = {}): RelationGraph {
  const graph: RelationGraph = { version: 1, symbols: [], edges: [], coverage: [] };
  const symbolIds = new Map<string, number>(), edgeIds = new Map<string, number>();
  const entries: Entry[] = [], byPosition = new Map<string, Entry>(), byLocal = new Map<string, Entry>();
  const byClass = new Map<string, Entry[]>(), byMethod = new Map<string, Entry[]>();
  const addSymbol = (key: string, value: Omit<GraphSymbol, 'id' | 'key' | 'versions'>, side: Side) => {
    let id = symbolIds.get(key); if (id === undefined) { id = graph.symbols.length; symbolIds.set(key, id); graph.symbols.push({ id, key, ...value, versions: 0 }); }
    const symbol = graph.symbols[id]; symbol.versions |= sideMask(side); if (side === 'before') symbol.beforeLine = value.line; else { symbol.line = value.line; symbol.endLine = value.endLine; }
    return id;
  };
  const edge = (from: number, to: number, kind: Relation['kind'], confidence: Relation['confidence'], unit: Unit, line: number, reason: string, condition?: string) => {
    const key = `${from}:${to}:${kind}:${confidence}:${condition ?? ''}`; const mask = sideMask(unit.input.side); const previous = edgeIds.get(key);
    if (previous !== undefined) { const e = graph.edges[previous]; e.versions |= mask; if (mask === 1) e.beforeLine = line; else e.line = line; return; }
    edgeIds.set(key, graph.edges.length); graph.edges.push({ from, to, kind, confidence, versions: mask, file: unit.input.file, line, ...(mask === 1 ? { beforeLine: line } : {}), reason, condition });
  };
  for (const u of units) {
    graph.coverage.push({ file: u.input.file, side: u.input.side, language: u.parsed.language, status: u.parsed.notes.length ? 'partial' : 'parsed', notes: [...u.parsed.notes, 'Static included-source analysis; dynamic dispatch and runtime behavior are not proven.'] });
    const occurrences = new Map<string, number>();
    for (const d of u.parsed.declarations) {
      const signature = `${d.owner}.${d.name}/${d.arity}:${Object.values(d.types).join(',')}`;
      const occurrence = occurrences.get(signature) ?? 0; occurrences.set(signature, occurrence + 1);
      const id = addSymbol(`${u.input.repo}:${u.input.identityPath}:${signature}:${occurrence}`, { file: u.input.file, repo: u.input.repo, name: `${d.owner ? d.owner + '.' : ''}${d.name}`, kind: d.kind, line: d.line, endLine: d.endLine }, u.input.side);
      const entry = { unit: u, decl: d, id }; entries.push(entry); byPosition.set(`${u.input.file}:${u.input.side}:${d.start}`, entry); byLocal.set(`${u.input.file}:${u.input.side}:${d.local}`, entry);
      const key = `${u.input.repo}:${u.input.side}:${d.kind === 'class' ? qualifiedType(u, d.name) : d.owner + '.' + d.name}`;
      const map = d.kind === 'class' ? byClass : byMethod; if (!map.has(key)) map.set(key, []); map.get(key)!.push(entry);
    }
  }
  const parsedKeys = new Set(units.map(u => `${u.input.file}:${u.input.side}`));
  for (const f of files) if (!parsedKeys.has(`${f.file}:${f.side}`)) graph.coverage.push({ file: f.file, side: f.side, language: path.extname(f.path).slice(1), status: f.skipReason || supported.test(f.path) ? 'skipped' : 'unsupported', notes: [f.skipReason ?? (supported.test(f.path) ? 'Source exceeds the 2 MiB analysis limit.' : 'No executable relationship analyzer for this language.')] });
  const classFor = (e: Entry) => byClass.get(`${e.unit.input.repo}:${e.unit.input.side}:${qualifiedType(e.unit, e.decl.owner)}`)?.find(c => c.unit.input.file === e.unit.input.file);
  const external = (entry: Entry, name: string, reason: string) => addSymbol(`${entry.unit.input.repo}:external:${entry.id}:${name}:${reason}`, { file: -1, repo: entry.unit.input.repo, name, kind: 'external', line: entry.decl.line, endLine: entry.decl.line }, entry.unit.input.side);
  const endpoints = new Map<string, { entry: Entry; constrained: boolean }[]>();
  for (const e of entries) {
    const owner = classFor(e); const service = config.repositories?.find(r => r.id === e.unit.input.repo)?.service;
    if (e.decl.kind !== 'function' || !owner || !/@(?:RestController|Controller)\b/.test(owner.decl.annotations) || !service) continue;
    const prefixes = mapping(owner.decl.annotations); const methods = mapping(e.decl.annotations);
    for (const route of methods) {
      if (route.path.includes('<dynamic')) continue;
      for (const prefix of prefixes.length ? prefixes : [{ path: '', method: '*', constrained: false }]) {
        if (prefix.path.includes('<dynamic')) continue;
        const method = route.method === '*' ? prefix.method : route.method;
        const key = `${e.unit.input.side}:${service}:${method}:${normalizedRoute(prefix.path + '/' + route.path)}`;
        if (!endpoints.has(key)) endpoints.set(key, []); endpoints.get(key)!.push({ entry: e, constrained: route.constrained || prefix.constrained });
        graph.symbols[e.id].kind = 'endpoint';
      }
    }
  }
  const contracts = new Map<string, Set<string>>();
  for (const spec of config.contracts ?? []) for (const file of files.filter(f => f.repo === spec.repo && f.path === spec.path)) {
    const key = `${file.side}:${spec.service}`;
    try {
      const document = parseDocument(file.text); if (document.errors.length) throw new Error('Invalid YAML');
      const data = document.toJS({ maxAliasCount: 20 }); if (!/^3\.[01]\./.test(String(data?.openapi))) throw new Error('Expected OpenAPI 3.0 or 3.1');
      const routes = new Set<string>();
      for (const [route, operations] of Object.entries(data.paths ?? {})) for (const method of Object.keys(operations as object)) if (/^(get|post|put|patch|delete|head|options|trace)$/.test(method)) routes.add(`${method.toUpperCase()}:${normalizedRoute(route)}`);
      contracts.set(key, routes);
      if (file.text.includes('$ref')) graph.coverage.push({ file: file.file, side: file.side, language: 'openapi', status: 'partial', notes: ['References are not dereferenced; remote resources are never fetched.'] });
    } catch (error) { contracts.set(key, new Set()); graph.coverage.push({ file: file.file, side: file.side, language: 'openapi', status: 'partial', notes: [`Contract unavailable: ${(error as Error).message}`] }); }
  }
  const httpEdge = (e: Entry, method: string, url: string, client: string, line: number, condition?: string) => {
    const bindings = (config.bindings ?? []).filter(b => b.from === e.unit.input.repo && (!b.client || b.client === client));
    const matches = bindings.filter(b => !b.baseUrl || !/^https?:/.test(url) || url.startsWith(b.baseUrl.replace(/\/$/, '') + '/') || url === b.baseUrl);
    let reason = ''; let target: { entry: Entry; constrained: boolean }[] = [];
    if (url.includes('<dynamic') || method === 'DYNAMIC') reason = 'Dynamic HTTP destination cannot be proven.';
    else if (matches.length !== 1) reason = 'An explicit, unique client-to-service binding is required.';
    else {
      const binding = matches[0]; let route = url;
      if (/^https?:/.test(route)) {
        if (!binding.baseUrl) reason = 'Absolute URL requires a matching configured baseUrl.';
        else route = route.slice(binding.baseUrl.replace(/\/$/, '').length);
      }
      if (!reason) {
        route = normalizedRoute(route.split('?')[0]); const contract = contracts.get(`${e.unit.input.side}:${binding.service}`);
        if (contract && !contract.has(`${method}:${route}`)) reason = 'OpenAPI contract does not declare this method/path; contract may be incomplete.';
        else target = [...(endpoints.get(`${e.unit.input.side}:${binding.service}:${method}:${route}`) ?? []), ...(endpoints.get(`${e.unit.input.side}:${binding.service}:*:${route}`) ?? [])];
        if (!reason && target.length !== 1) reason = target.length > 1 ? 'Multiple server handlers match; no endpoint was selected.' : 'No matching included server handler; scope may be incomplete.';
      }
    }
    if (reason) edge(e.id, external(e, `${method} ${url}`, reason), 'http', 'unresolved', e.unit, line, reason, condition);
    else edge(e.id, target[0].entry.id, 'http', target[0].constrained || e.unit.parsed.notes.length ? 'probable' : 'resolved', e.unit, line, target[0].constrained ? 'Method/path match; additional Spring mapping conditions require verification.' : 'Explicit service binding and unique method/path match (static, not observed traffic).', condition);
  };
  const compiler = compilerTargets(units);
  for (const e of entries) {
    const u = e.unit, d = e.decl, owner = classFor(e); const mask = sideMask(u.input.side);
    if (d.eventParent) { const parent = byLocal.get(`${u.input.file}:${u.input.side}:${d.eventParent}`); if (parent) edge(parent.id, e.id, d.eventKind ?? 'event', u.parsed.notes.length ? 'probable' : 'resolved', u, d.line, 'Explicit callback registration; execution is conditional on the event.'); }
    for (const route of mapping(d.annotations, true)) httpEdge(e, route.method, route.path, d.owner, d.line);
    for (const call of d.calls) {
      if (call.http && !compiler.has(`${u.input.file}:${u.input.side}:${call.start}`)) { httpEdge(e, call.http.method, call.http.path, call.receiver || 'fetch', call.line, call.condition); continue; }
      let candidates: Entry[] = [], confidence: Relation['confidence'] = u.parsed.notes.length ? 'probable' : 'resolved';
      if (u.parsed.language === 'typescript') {
        const found = compiler.get(`${u.input.file}:${u.input.side}:${call.start}`);
        if (found) { const target = byPosition.get(`${found.file}:${u.input.side}:${found.start}`); if (target) candidates = [target]; if (found.abstract) confidence = 'probable'; }
      } else {
        const receiver = call.receiver.replace(/^this\./, '');
        const type = !receiver || receiver === 'this' ? d.owner : (Object.hasOwn(d.types, receiver) ? d.types[receiver] : undefined) ?? (owner && Object.hasOwn(owner.decl.types, receiver) ? owner.decl.types[receiver] : undefined) ?? (/^[A-Z]\w*$/.test(receiver) ? receiver : '');
        if (type) {
          const classes = byClass.get(`${u.input.repo}:${u.input.side}:${qualifiedType(u, type)}`) ?? [];
          if (classes.length === 1) candidates = (byMethod.get(`${u.input.repo}:${u.input.side}:${classes[0].decl.name}.${call.name}`) ?? []).filter(x => x.unit.input.file === classes[0].unit.input.file && x.decl.arity === call.argc);
          if (!candidates.length && classes.length === 1 && classes[0].decl.bases.some(b => /^(JpaRepository|CrudRepository|PagingAndSortingRepository)$/.test(b))) {
            const entity = classes[0].decl.annotations.match(/(?:JpaRepository|CrudRepository|PagingAndSortingRepository)\s*<\s*([\w.]+)/)?.[1];
            const entityClass = entity ? byClass.get(`${u.input.repo}:${u.input.side}:${qualifiedType(classes[0].unit, entity)}`) : undefined;
            const table = entityClass?.length === 1 ? annotations(entityClass[0].decl.annotations, ['Table'])[0]?.body.match(/name\s*=\s*"([^"]+)"/)?.[1] : undefined;
            if (table && /^(find|exists|count|read|get|save|delete|remove)/.test(call.name)) {
              const tableId = addSymbol(`${u.input.repo}:table:${table}`, { file: entityClass![0].unit.input.file, repo: u.input.repo, name: table, kind: 'table', line: entityClass![0].decl.line, endLine: entityClass![0].decl.endLine }, u.input.side);
              edge(e.id, tableId, /^(save|delete|remove)/.test(call.name) ? 'write' : 'read', confidence, u, call.line, `Declared ${type}<${entity}> and explicit @Table; SQL/runtime execution is not inferred.`, call.condition); continue;
            }
          }
        }
        if (!receiver && !candidates.length) candidates = (byMethod.get(`${u.input.repo}:${u.input.side}:.${call.name}`) ?? []).filter(x => x.unit === u && x.decl.arity === call.argc);
      }
      if (candidates.length === 1 && graph.symbols[candidates[0].id].versions & mask) edge(e.id, candidates[0].id, graph.symbols[candidates[0].id].kind === 'state' ? 'state' : call.kind ?? 'call', confidence, u, call.line, 'Unique included declaration from compiler or explicit receiver type; not a runtime trace.', call.condition);
      else edge(e.id, external(e, `${call.receiver ? call.receiver + '.' : ''}${call.name}`, 'Unresolved call'), 'call', 'unresolved', u, call.line, candidates.length > 1 ? 'Overloaded or ambiguous call; no target selected.' : 'Dynamic, external, unsupported or excluded target; no target selected.', call.condition);
    }
  }
  return graph;
}





