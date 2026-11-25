import ts from 'typescript';
import Parser from 'web-tree-sitter';
import { createRequire } from 'node:module';
import type { CallSite, Declaration, ParsedFile } from './model.js';
const require = createRequire(import.meta.url);
let initialized: Promise<void> | undefined;
const languages = new Map<string, Parser.Language>();
const cleanType = (value: string) => value.replace(/[?<>].*$/, '').trim().split('.').at(-1) ?? '';
function branch(text: string): string | undefined {
  const value = text.trim().replace(/\s+/g, ' '); return value ? value.slice(0, 180) : undefined;
}
export function extractTS(file: string, text: string): ParsedFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /tsx$/.test(file) ? ts.ScriptKind.TSX : /jsx$/.test(file) ? ts.ScriptKind.JSX : /\.js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  const declarations: Declaration[] = [], imports: string[] = [];
  const line = (n: ts.Node) => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  const make = (n: ts.Node, name: string, owner: string, kind: Declaration['kind'], parameters: readonly ts.ParameterDeclaration[] = []): Declaration => {
    const d: Declaration = { local: `${owner ? owner + '.' : ''}${name}/${parameters.length}@${n.getStart(source)}`, name, owner, kind, start: n.getStart(source), end: n.end, line: line(n), endLine: source.getLineAndCharacterOfPosition(n.end).line + 1, arity: parameters.length, types: {}, bases: [], annotations: '', calls: [] };
    for (const p of parameters) if (p.type) d.types[p.name.getText(source)] = cleanType(p.type.getText(source));
    declarations.push(d); return d;
  };
  const root = make(source, '<module>', '', 'function');
  function visit(n: ts.Node, scope: Declaration, owner: string, condition?: string) {
    if (ts.isImportDeclaration(n)) { imports.push(n.moduleSpecifier.getText(source).slice(1, -1)); return; }
    if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) {
      const name = n.name?.text ?? '<anonymous class>'; const d = make(n, name, owner, 'class');
      d.bases = (n.heritageClauses ?? []).flatMap(c => c.types.map(t => cleanType(t.expression.getText(source))));
      for (const m of n.members) if (ts.isPropertyDeclaration(m) && m.type) d.types[m.name.getText(source)] = cleanType(m.type.getText(source));
      ts.forEachChild(n, c => visit(c, d, name, condition)); return;
    }
    if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodSignature(n)) {
      let name = 'name' in n && n.name ? n.name.getText(source) : ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(source) : ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(source) : `callback@${line(n)}`;
      const attr = ts.isJsxExpression(n.parent) && ts.isJsxAttribute(n.parent.parent) ? n.parent.parent : undefined;
      if (attr) name = `${attr.name.getText(source)}@${line(n)}`;
      const d = make(n, name, owner, 'function', n.parameters);
      if (attr || ts.isCallExpression(n.parent)) { d.eventParent = scope.local; d.eventKind = attr ? 'event' : 'async'; }
      ts.forEachChild(n, c => visit(c, d, owner, condition)); return;
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const target = n.tagName; if (ts.isIdentifier(target) && /^[A-Z]/.test(target.text)) scope.calls.push({ name: target.text, receiver: '', argc: 1, start: target.getStart(source), line: line(n), kind: 'event', condition: 'JSX render use' });
    }
    if (ts.isJsxAttribute(n) && /^on[A-Z]/.test(n.name.getText(source)) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isIdentifier(n.initializer.expression)) {
      const target = n.initializer.expression;
      scope.calls.push({ name: target.text, receiver: '', argc: 0, start: target.getStart(source), line: line(n), kind: 'event', condition: n.name.getText(source) });
    }
    if (ts.isVariableDeclaration(n)) {
      if (n.type) scope.types[n.name.getText(source)] = cleanType(n.type.getText(source));
      else if (n.initializer && ts.isNewExpression(n.initializer)) scope.types[n.name.getText(source)] = cleanType(n.initializer.expression.getText(source));
      if (ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer) && /\buseState$/.test(n.initializer.expression.getText(source))) {
        const setter = n.name.elements[1]; if (setter && ts.isBindingElement(setter)) make(setter, setter.name.getText(source), owner, 'state');
      }
    }
    if (ts.isIfStatement(n)) {
      visit(n.expression, scope, owner, condition); visit(n.thenStatement, scope, owner, branch(n.expression.getText(source)));
      if (n.elseStatement) visit(n.elseStatement, scope, owner, branch(`else: ${n.expression.getText(source)}`)); return;
    }
    if (ts.isCatchClause(n)) { ts.forEachChild(n, c => visit(c, scope, owner, 'catch / error branch')); return; }
    if (ts.isCallExpression(n)) {
      const expr = n.expression; const name = ts.isPropertyAccessExpression(expr) ? expr.name.text : ts.isIdentifier(expr) ? expr.text : '<dynamic call>';
      const receiver = ts.isPropertyAccessExpression(expr) ? expr.expression.getText(source) : '';
      const call: CallSite = { name, receiver, argc: n.arguments.length, line: line(n), start: n.getStart(source), condition };
      const first = n.arguments[0]; const literal = first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) ? first.text : undefined;
      if (name === 'fetch' || /^(get|post|put|delete|patch|head)$/.test(name) && /axios/.test(receiver)) {
        let method = name === 'fetch' ? 'GET' : name.toUpperCase();
        if (name === 'fetch' && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
          const methodProp = n.arguments[1].properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source).replace(/["']/g, '') === 'method');
          if (methodProp && ts.isPropertyAssignment(methodProp)) method = ts.isStringLiteral(methodProp.initializer) ? methodProp.initializer.text.toUpperCase() : 'DYNAMIC';
        }
        call.http = { method, path: literal ?? '<dynamic URL>' };
      }
      scope.calls.push(call);
    }
    ts.forEachChild(n, c => visit(c, scope, owner, condition));
  }
  ts.forEachChild(source, n => visit(n, root, ''));
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return { language: 'typescript', declarations, imports, packageName: '', notes: diagnostics.map(d => `Parse: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`) };
}
export async function extractJVM(file: string, text: string): Promise<ParsedFile> {
  const language = file.endsWith('.java') ? 'java' : 'kotlin';
  initialized ??= Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') }); await initialized;
  let grammar = languages.get(language); if (!grammar) { grammar = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${language}.wasm`)); languages.set(language, grammar); }
  const parser = new Parser(); parser.setLanguage(grammar); parser.setTimeoutMicros(2_000_000);
  let tree: Parser.Tree | undefined;
  try {
    tree = parser.parse(text); const declarations: Declaration[] = [], imports: string[] = [];
    let packageName = '';
    const typesIn = (header: string): Record<string, string> => {
      const types: Record<string, string> = {};
      for (const m of header.matchAll(/\b(?:val|var)?\s*(\w+)\s*:\s*([\w.]+)/g)) types[m[1]] = cleanType(m[2]);
      if (language === 'java') for (const m of header.matchAll(/\b([A-Z][\w.]*)(?:<[^;(){}]*>)?\s+(\w+)\s*(?=[,;)=])/g)) types[m[2]] = cleanType(m[1]);
      return types;
    };
    const nameOf = (n: Parser.SyntaxNode) => n.childForFieldName('name')?.text ?? n.namedChildren.find(c => ['simple_identifier', 'identifier', 'type_identifier'].includes(c.type))?.text ?? '<anonymous>';
    const root: Declaration = { local: '<module>/0@0', name: '<module>', owner: '', kind: 'function', start: 0, end: text.length, line: 1, endLine: tree.rootNode.endPosition.row + 1, arity: 0, types: {}, bases: [], annotations: '', calls: [] }; declarations.push(root);
    const walk = (n: Parser.SyntaxNode, scope: Declaration, owner: string, condition?: string) => {
      if (/^(package_header|package_declaration)$/.test(n.type)) { packageName = n.text.replace(/^package\s+|;$/g, '').trim(); return; }
      if (/^(import_header|import_declaration)$/.test(n.type)) { imports.push(n.text.replace(/^import\s+|;$/g, '').trim()); return; }
      if (/^(class_declaration|interface_declaration|object_declaration|record_declaration|function_declaration|method_declaration|constructor_declaration)$/.test(n.type)) {
        const kind = /function|method|constructor/.test(n.type) ? 'function' : 'class'; const name = nameOf(n);
        const body = n.childForFieldName('body') ?? n.namedChildren.find(c => /^(class_body|function_body|block|enum_class_body)$/.test(c.type));
        const header = text.slice(n.startIndex, body?.startIndex ?? n.endIndex);
        const params = n.namedChildren.find(c => /^(formal_parameters|function_value_parameters|primary_constructor)$/.test(c.type));
        const arity = kind === 'function' ? (params?.namedChildren.filter(c => /parameter/.test(c.type)).length ?? 0) : 0;
        const d: Declaration = { local: `${owner ? owner + '.' : ''}${name}/${arity}@${n.startIndex}`, name, owner, kind, start: n.startIndex, end: n.endIndex, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, arity, types: typesIn(header), bases: [], annotations: header, calls: [] };
        if (kind === 'class') {
          const bases = header.match(/(?:\bextends\s+|\bimplements\s+|\)\s*:\s*|\b(?:class|interface)\s+\w+\s*:\s*)([\s\S]*)/);
          if (bases) d.bases = [...bases[1].matchAll(/\b([A-Z]\w*)/g)].map(m => m[1]);
          if (body) for (const member of body.namedChildren) if (/field_declaration|property_declaration/.test(member.type)) Object.assign(d.types, typesIn(member.text));
        }
        declarations.push(d); for (const child of n.namedChildren) if (child !== params && !/modifiers|annotation/.test(child.type)) walk(child, d, kind === 'class' ? name : owner, condition); return;
      }
      if (/^(lambda_literal|lambda_expression)$/.test(n.type)) {
        const label = n.parent?.text.split(/[={]/)[0].trim() ?? '';
        const d: Declaration = { local: `${scope.local}.callback@${n.startIndex}`, name: `callback@${n.startPosition.row + 1}`, owner, kind: 'function', start: n.startIndex, end: n.endIndex, line: n.startPosition.row + 1, endLine: n.endPosition.row + 1, arity: 0, types: { ...scope.types }, bases: [], annotations: '', calls: [], eventParent: scope.local, eventKind: /on[A-Z]|Listener/.test(label) ? 'event' : 'async' };
        declarations.push(d); for (const child of n.namedChildren) walk(child, d, owner, condition ?? branch(label)); return;
      }
      if (/property_declaration|local_variable_declaration/.test(n.type)) Object.assign(scope.types, typesIn(n.text));
      if (/^(if_expression|if_statement|when_expression|catch_block|catch_clause)$/.test(n.type)) condition = branch(n.text.split(/[\n{]/)[0]);
      if (/^(when_entry|switch_label)$/.test(n.type)) condition = branch(n.text.split('->')[0].split('{')[0]);
      if (/^(call_expression|method_invocation)$/.test(n.type)) {
        let name = n.childForFieldName('name')?.text ?? '', receiver = n.childForFieldName('object')?.text ?? '';
        if (!name) {
          const target = n.namedChildren[0]?.text ?? ''; const match = target.match(/^(?:(.*?)\??\.)?([\w$]+)(?:<[^>]*>)?$/);
          if (match) { receiver = match[1] ?? ''; name = match[2]; } else name = '<dynamic call>';
        }
        const args = n.childForFieldName('arguments') ?? n.descendantsOfType(['value_arguments', 'argument_list'])[0];
        scope.calls.push({ name, receiver, argc: args?.namedChildCount ?? 0, start: n.startIndex, line: n.startPosition.row + 1, condition });
      }
      for (const child of n.namedChildren) walk(child, scope, owner, condition);
    };
    walk(tree.rootNode, root, '');
    return { language, declarations, imports, packageName, notes: tree.rootNode.hasError ? ['Parser reported incomplete syntax; affected calls cannot be treated as resolved.'] : [] };
  } finally { tree?.delete(); parser.delete(); }
}
export async function extractFile(file: string, text: string): Promise<ParsedFile> {
  if (/\.[cm]?[jt]sx?$/.test(file)) return extractTS(file, text);
  if (/\.(kt|kts|java)$/.test(file)) return extractJVM(file, text);
  return { language: file.split('.').at(-1) ?? 'unknown', declarations: [], packageName: '', imports: [], notes: ['No relationship analyzer for this language.'] };
}
