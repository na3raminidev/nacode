import ts from 'typescript';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Minimatch } from 'minimatch';
import type { AnalysisFile, AnalysisConfig, RelationGraph, GraphSymbol } from '../relations/model.js';
import type { Fact, FactKind, Feature, InsightData } from './model.js';
export function redact(value: string): string {
  return value.replace(/\b(?:gh[pousr]_[\w]{15,}|github_pat_[\w]+|sk-[\w-]{20,})\b/g, '[redacted]')
    .replace(/\b\d{10,}\b/g, '[redacted-id]').replace(/([\w.+-]+)@([\w.-]+\.[A-Za-z]{2,})/g, '[redacted-email]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
    .replace(/\b(password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^,;\s]+/gi, '$1=[redacted]').slice(0, 400);
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const normalize = (s: string) => s.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
const noun = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)[0];
const generic = new Set(['index', 'main', 'app', 'base', 'test', 'spec', 'readme', 'common', 'shared', 'core', 'use', 'get', 'set', 'data', 'api', 'config', 'src']);
export function collectInsights(files: AnalysisFile[], graph: RelationGraph, config: AnalysisConfig = {}): InsightData {
  const facts: Fact[] = [], features = new Map<string, { label: string; files: Set<number>; declared: boolean }>(), notes: string[] = [];
  const rules = (config.features ?? []).map(f => ({ ...f, patterns: f.include.map(p => new Minimatch(p, { dot: true })) }));
  const limited: { file: number; side: AnalysisFile['side'] }[] = [];
  const symbolIndex = new Map<string, GraphSymbol[]>();
  for (const s of graph.symbols) if (s.file >= 0 && s.name !== '<module>') for (const side of ['before', 'after'] as const) if (s.versions & (side === 'before' ? 1 : 2)) { const k = `${s.file}:${side}`; if (!symbolIndex.has(k)) symbolIndex.set(k, []); symbolIndex.get(k)!.push(s); }
  for (const [key, list] of symbolIndex) list.sort((a, b) => key.endsWith(':before') ? (a.beforeLine ?? a.line) - (b.beforeLine ?? b.line) : a.line - b.line);
  const addFeature = (id: string, label: string, file: number, declared: boolean) => { if (!features.has(id)) features.set(id, { label, files: new Set(), declared }); features.get(id)!.files.add(file); };
  for (const file of files) {
    const full = `${file.repo}/${file.path}`, basename = path.posix.basename(file.path).replace(/\.[^.]+$/, '');
    const explicit = rules.filter(f => f.patterns.some(p => p.match(full) || p.match(file.path)));
    for (const f of explicit) addFeature(f.id, f.label ?? f.id, file.file, true);
    if (!explicit.length) {
      const segment = file.path.match(/(?:^|\/)(?:features?|services)\/([^/]+)/)?.[1];
      const names = new Set([segment, noun(basename)].filter((x): x is string => !!x && x.length > 2 && !generic.has(x)));
      for (const n of names) addFeature(`auto:${n}`, n, file.file, false);
    }
    if (file.skipReason || facts.length >= 500000) { limited.push({ file: file.file, side: file.side }); if (file.skipReason) notes.push(`File ${file.file} (${file.side}): ${file.skipReason}`); continue; }
    if (!file.text) continue;
    const lines = file.text.split(/\r?\n/), local = new Set<string>(); let count = 0;
    const symbols = symbolIndex.get(`${file.file}:${file.side}`) ?? [];
    const add = (kind: FactKind, label: string, line: number, detail: string, key = label, role?: string, fingerprint?: string) => {
      if (count >= 1500 || facts.length >= 500000) { count++; return; }
      const k = `${kind}:${line}:${key}:${role ?? ''}`; if (local.has(k)) return; local.add(k);
      if (++count > 1500 || facts.length >= 500000) return;
      // Bound containment search; a missing symbol is preferable to an invented association.
      const start = (s: GraphSymbol) => file.side === 'before' ? s.beforeLine ?? s.line : s.line;
      const end = (s: GraphSymbol) => file.side === 'before' ? s.beforeEndLine ?? s.endLine : s.endLine;
      let low = 0, high = symbols.length, symbol: GraphSymbol | undefined;
      while (low < high) { const mid = (low + high) >>> 1; if (start(symbols[mid]) <= line) low = mid + 1; else high = mid; }
      for (let at = low - 1; at >= Math.max(0, low - 64); at--) { const s = symbols[at]; if (end(s) >= line && (!symbol || end(s) - start(s) < end(symbol) - start(symbol))) symbol = s; }
      facts.push({ id: facts.length, file: file.file, side: file.side, line, symbol: symbol?.id, kind, label: redact(label), key: redact(key) === key ? key : `redacted:${hash(key)}`, detail: redact(detail), confidence: 'probable', role, fingerprint });
    };
    const isDoc = /\.md$/i.test(file.path), isTest = /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|(?:Test|Spec|\.test|\.spec)\.[^.]+$/i.test(file.path);
    if (isDoc) add('document', basename, 1, 'Included documentation; verify against current source.', basename);
    if (isTest) add('test', basename, 1, 'Test source exists. No execution or passing status is inferred.', basename.replace(/Test|Spec|\.test|\.spec/g, ''));
    const source = /\.[cm]?[jt]sx?$/.test(file.path) ? ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true) : undefined;
    if (source) {
      const visit = (n: ts.Node) => {
        const line = source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
          const name = n.tagName.getText(source); if (/^[A-Z]/.test(name)) add('component', name, line, 'Explicit JSX use; declaration binding must be verified.', name, 'consumer');
        }
        if (ts.isFunctionDeclaration(n) && n.name && /^[A-Z]/.test(n.name.text)) add('component', n.name.text, line, 'Uppercase function declaration; component candidate.', n.name.text, 'declaration');
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isArrowFunction(n.initializer) && /^[A-Z]/.test(n.name.getText(source))) add('component', n.name.getText(source), line, 'Uppercase arrow declaration; component candidate.', n.name.getText(source), 'declaration');
        if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) {
          const members = ts.isInterfaceDeclaration(n) ? n.members : (n.type as ts.TypeLiteralNode).members;
          for (const m of members) if (ts.isPropertySignature(m) && m.name) { const field = m.name.getText(source), type = m.type?.getText(source) ?? 'unknown'; add('schema', `${n.name.text}.${field}`, source.getLineAndCharacterOfPosition(m.getStart(source)).line + 1, `${m.questionToken ? 'optional' : 'required'}: ${type}`, `${n.name.text}.${field}`, 'field', hash(`${!!m.questionToken}:${type}`)); }
        }
        if (ts.isCallExpression(n)) {
          const name = n.expression.getText(source), arg = n.arguments[0];
          if (/\b(?:sendAction|dispatch|setScreen|sendEffect|emitEffect|onIntent)$/.test(name) && arg) { const value = arg.getText(source).split(/[({]/)[0].replace(/['"]/g, '').trim(); add('state', value, line, `${name} dispatch; registration/handling is conditional.`, value, 'dispatch'); }
          if (/\b(?:navigateToFeature|completeFeature|navigateTo|navigate|push|popBackStack|useBackAction)$/.test(name)) add('navigation', name, line, arg ? `Navigation argument: ${arg.getText(source).slice(0, 100)}` : 'Navigation/back action.', arg ? arg.getText(source).split(/[({]/)[0].replace(/['"]/g, '').trim() : name, 'dispatch');
          if (/\b(?:fetch|axios\.(?:get|post|put|patch|delete))$/.test(name) && arg && ts.isStringLiteralLike(arg)) { let method = name === 'fetch' ? 'GET' : name.split('.').at(-1)!.toUpperCase(); const options = n.arguments[1]; if (name === 'fetch' && options && ts.isObjectLiteralExpression(options)) { const p = options.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/['"]/g, '') === 'method') as ts.PropertyAssignment | undefined; if (p) method = ts.isStringLiteralLike(p.initializer) ? p.initializer.text.toUpperCase() : 'DYNAMIC'; } add('contract', `${method} ${arg.text}`, line, 'Literal HTTP client call; configured bindings determine service identity.', `${method} ${normalize(arg.text)}`, 'client', hash(`${method}:${arg.text}`)); }
        }
        if (ts.isCaseClause(n)) add('state', n.expression.getText(source).replace(/['"]/g, ''), line, 'Explicit switch case; not proof the branch executes.', n.expression.getText(source).replace(/['"]/g, ''), 'handler');
        ts.forEachChild(n, visit);
      }; visit(source);
    }
    let routePrefix = '', composable = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], number = i + 1;
      if (!isDoc && /^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      for (const m of line.matchAll(/\b(?:[A-Z]{2,8}-){1,3}\d{3,6}\b/g)) add('error', m[0], number, 'Literal error-code occurrence; inspect source for throw/map/handling semantics.', m[0]);
      for (const m of line.matchAll(/\bSCN[-_][\w-]+/gi)) add('scenario', m[0], number, 'Explicit scenario identifier occurrence.', m[0].toLowerCase());
      if (isDoc) {
        for (const m of line.matchAll(/\[[^\]]*\]\(([^)#]+)(?:#[^)]*)?\)|`([^`\s]+\.(?:kt|java|tsx?|md))`/g)) add('document', m[1] ?? m[2], number, 'Explicit local document/source reference; paths are resolved only inside included files.', m[1] ?? m[2], 'reference');
        continue;
      }
      const route = line.match(/@(GET|POST|PUT|PATCH|DELETE|HEAD|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|GetExchange|PostExchange|PutExchange|PatchExchange|DeleteExchange)\s*\(\s*(?:(?:value|path|url)\s*=\s*)?"([^"\n]+)"/);
      const prefix = line.match(/@(?:RequestMapping|HttpExchange)\s*\(\s*(?:(?:value|path|url)\s*=\s*)?"([^"\n]+)"/);
      if (prefix && !route) routePrefix = prefix[1];
      if (route) { const method = route[1].replace(/Mapping|Exchange/g, '').toUpperCase(), endpoint = normalize(`${routePrefix}/${route[2]}`.replace(/\/+/g, '/')); add('contract', `${method} ${endpoint}`, number, 'Annotation mapping; class prefixes are syntactic, dynamic expressions are not evaluated.', `${method} ${endpoint}`, /Mapping$/.test(route[1]) ? 'server' : 'client', hash(lines.slice(i, Math.min(lines.length, i + 8)).join('\n').split('{')[0].replace(/\s+/g, ' '))); }
      if (/\.(?:kt|kts)$/.test(file.path)) {
        const action = line.match(/\b(sendAction|sendEffect|emitEffect|onIntent|navigateTo|completeFeature|popBackStack|onScreenReturn)\s*\(\s*([\w.]+)/);
        if (action) add(/navigate|completeFeature|popBackStack|onScreenReturn/.test(action[1]) ? 'navigation' : 'state', action[2], number, `Explicit ${action[1]} argument; check matching handlers.`, action[2], 'dispatch');
        const handler = line.match(/^\s*(?:is\s+)?([A-Z][\w]*(?:\.[A-Z][\w]*)+)\s*(?:,|->)/);
        if (handler) add('state', handler[1], number, 'Kotlin branch label; condition-dependent handler.', handler[1], 'handler');
        if (line.includes('@Composable')) composable = true;
        const fn = line.match(/\bfun\s+([A-Z]\w*)\s*\(/); if (fn && composable) { add('component', fn[1], number, '@Composable function declaration.', fn[1], 'declaration'); composable = false; }
        if (!/\b(?:fun|class|interface)\s/.test(line)) for (const m of line.matchAll(/\b(Bon\w+|\w+Screen|\w+Page)\s*\(/g)) add('component', m[1], number, 'Named UI call candidate; verify declaration.', m[1], 'consumer');
      }
      const async = line.match(/@(Scheduled|Async)\b|\b(retryWhen|retry|launch|async|collectLatest|collect|callback|onScreenReturn|resume|recover\w*)\s*\(/i);
      if (async) add('async', async[1] ?? async[2], number, 'Async/recovery construct. Runtime scheduling/order is not proven.');
      const tx = line.match(/@(Transactional|Lock|Version)\b|\b(claimForConfirm|claim|idempotency\w*|revers\w*|saveAndFlush|forUpdate|refresh)\s*\(/i);
      if (tx) add('transaction', tx[1] ?? tx[2], number, 'Transaction/claim/locking evidence; review shared writes and ordering.');
      const gate = line.match(/\$\{([\w.-]+)(?::[^}]*)?\}|\b([\w]*(?:whitelist|allowlist|enabled|featureFlag|minimumVersion|pilot)[\w]*)\b/i);
      if (gate) add('gate', gate[1] ?? gate[2], number, 'Configuration/check occurrence. Values withheld; effective runtime value is unknown.', (gate[1] ?? gate[2]).toLowerCase());
      const table = line.match(/@Table\s*\(\s*name\s*=\s*"([\w.]+)"|\b(?:ALTER|CREATE)\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/i);
      if (table) add(/\.sql$/.test(file.path) ? 'migration' : 'table', table[1] ?? table[2], number, 'Explicit table/schema declaration; migration execution is unknown.', (table[1] ?? table[2]).toLowerCase());
      if (/\.(?:java|kt)$/.test(file.path) && /(?:Dto|DTO|Request|Response|State|Entity)\b/.test(basename)) {
        const field = line.match(/\b(?:val|var)\s+(\w+)\s*:\s*([\w<>?.]+)|\b(?:private|public|protected)\s+(?!class\b|static\b)([\w<>?.]+)\s+(\w+)\s*[;=]/);
        if (field) { const name = field[1] ?? field[4], type = field[2] ?? field[3]; add('schema', `${basename}.${name}`, number, `Declared type: ${type}; defaults omitted.`, `${basename}.${name}`, 'field', hash(type)); }
      }
    }
    if (count > 1500) { limited.push({ file: file.file, side: file.side }); notes.push(`File ${file.file} (${file.side}): evidence capped at 1500 facts.`); }
  }
  if (facts.length >= 500000) notes.push('Global evidence cap reached: 500000 facts. Results are partial.');
  return { version: 1, limited, facts, features: [...features].map(([id, f]): Feature => ({ id, label: f.label, files: [...f.files], declared: f.declared })).sort((a, b) => a.label.localeCompare(b.label)), history: { commits: [], refs: [], notes: ['Git history was not requested.'] }, notes };
}
