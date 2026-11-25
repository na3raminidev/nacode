import test from 'node:test';
import assert from 'node:assert/strict';
import { collectInsights, redact } from '../src/insights/extract.js';
import { InsightIndex } from '../src/insights/query.js';
import { LENSES, type InsightData } from '../src/insights/model.js';
import { EdgeTable } from '../src/relations/query.js';
import { assemble } from '../src/relations/analyze.js';
import { extractFile } from '../src/relations/extract.js';
import type { AnalysisFile, RelationGraph, Relation } from '../src/relations/model.js';
import type { FileEntry } from '../src/model.js';
const graph: RelationGraph = { version: 1, symbols: [], edges: [], coverage: [] };
const input = (file: number, path: string, text: string, side: 'before' | 'after' = 'after'): AnalysisFile => ({ file, path, identityPath: path, repo: 'r', text, side });
const content = { kind: 'text' as const, bytes: 100 };
const entries = (n: number): FileEntry[] => Array.from({ length: n }, (_, id) => ({ id, path: `src/File${id}.ts`, status: 'snapshot', before: content, after: content, additions: 0, deletions: 0 }));
function index(data: InsightData, files = entries(10), relations: Relation[] = []) {
 const symbols = files.map(f => ({ id: f.id, key: String(f.id), file: f.id, repo: 'r', name: `function${f.id}`, kind: 'function' as const, line: 1, endLine: 100, versions: 3 }));
 const table = new EdgeTable(relations.length); relations.forEach((e, i) => table.set(i, e)); return new InsightIndex(data, files, symbols, table);
}
const edge = (from: number, to: number, versions = 3): Relation => ({ from, to, versions, kind: 'call', confidence: 'resolved', file: from, line: 1, reason: 'fixture' });
const fixtures = [
 input(0, 'features/orders/OrdersPage.tsx', `export function Card() { return <div/>; }\nexport function OrdersPage() { dispatch(Orders.Load); navigate('Checkout'); return <Card/>; }\nswitch (action) { case Orders.Load: break; }\nconst code = "GCS-AP-015";\nfetch('/orders');\ninterface OrderDto { amount?: number; }\nretry(load);\nconst featureFlag = true; // SCN-orders`),
 input(1, 'features/orders/OrdersPage.test.tsx', `// SCN-orders\nexport function testOrders() { return <Card/>; }\nconst scenario = 'SCN-orders'; const error = 'GCS-AP-015';`),
 input(2, 'docs/OrdersFlow.md', '# Orders\nSCN-orders\n[Source](../features/orders/OrdersPage.tsx)'),
 input(3, 'api/OrderDto.kt', 'data class OrderDto(\n val amount: Long?\n)\n@Composable\nfun OrderScreen() { BonButton() }\nfun load() { sendAction(Orders.Load) }\n Orders.Load -> load()\n@Scheduled\nfun recover() { claimForConfirm() }\n@Table(name="orders")\nclass OrderEntity'),
 input(4, 'db/orders.sql', 'ALTER TABLE orders ADD COLUMN enabled BOOLEAN;'),
];
const data = () => collectInsights(fixtures, graph, { features: [{ id: 'orders', label: 'Orders', include: ['**/orders/**', '**/Order*', 'db/orders.sql'] }] });
test('all ten lenses produce honest source evidence and declared capability focus', async () => {
 const d = data(), ix = index(d);
 assert.equal(LENSES.length, 10); assert.ok(d.features.find(f => f.id === 'orders')?.declared);
 for (const lens of ['feature', 'state', 'contracts', 'recovery', 'gates', 'scenarios', 'components'] as const) {
  const r = await ix.query({ lens, side: 'after' }); assert.ok(r.rows.length, lens); assert.ok(r.connections.length <= 200);
 }
 assert.ok(d.facts.some(f => f.kind === 'navigation')); assert.ok(d.facts.some(f => f.kind === 'transaction'));
 assert.ok(d.facts.filter(f => f.kind === 'gate').every(f => !f.detail.includes('true')));
 assert.ok(d.facts.filter(f => f.kind === 'test').every(f => f.detail.includes('No execution')));
 assert.ok((await ix.query({ lens: 'branches', side: 'after' })).note.includes('not requested'));
 assert.ok((await ix.query({ lens: 'history', side: 'after' })).note.includes('not requested'));
});
test('DTO comparison reports changed optionality, added and removed fields', async () => {
 const d = collectInsights([input(0, 'OrderDto.ts', 'interface OrderDto { amount: number; old: string; }', 'before'), input(0, 'OrderDto.ts', 'interface OrderDto { amount?: number; next: boolean; }')], graph);
 const r = await index(d).query({ lens: 'contracts', side: 'compare' });
 assert.equal(r.rows.find(r => r.title === 'OrderDto.amount')?.status, 'changed');
 assert.equal(r.rows.find(r => r.title === 'OrderDto.old')?.status, 'removed');
 assert.equal(r.rows.find(r => r.title === 'OrderDto.next')?.status, 'added');
});
test('impact never joins mixed versions and probable traversal requires opt-in', async () => {
 const ix = index(data(), entries(4), [edge(0, 1, 1), edge(1, 2, 2), { ...edge(3, 2, 2), confidence: 'probable' }]);
 const r = await ix.query({ lens: 'impact', side: 'compare', file: 2 });
 assert.ok(!r.rows.some(r => r.file === 0)); assert.ok(r.rows.some(r => r.file === 1 && r.side === 'after')); assert.ok(!r.rows.some(r => r.file === 3));
 assert.ok((await ix.query({ lens: 'impact', side: 'after', file: 2, probable: true })).rows.some(r => r.file === 3 && r.confidence === 'probable'));
});
test('selected UI/API consumers retain graph evidence; state matches cross files', async () => {
 const ix = index(data(), entries(10), [edge(1, 0)]);
 for (const lens of ['components', 'contracts'] as const) assert.ok((await ix.query({ lens, side: 'after', file: 0 })).rows.some(r => r.file === 1 && r.status === 'graph consumer'));
 assert.ok((await ix.query({ lens: 'state', side: 'after', file: 0 })).rows.some(r => r.file === 1 && r.status === 'matching evidence'));
 const files = entries(10); files[0].path = 'features/orders/OrdersPage.tsx';
 assert.ok((await index(data(), files).query({ lens: 'scenarios', side: 'after' })).connections.some(c => c.fromFile === 2 && c.toFile === 0));
});
test('hotspots, co-change and branch evidence are not runtime/deploy claims', async () => {
 const d = data(); d.history = { notes: ['Local refs only, not deployment.'], refs: [{ repo: 'r', name: 'main', sha: 'a'.repeat(40), commits: 1, truncated: true }], commits: [
  { repo: 'r', hash: 'a'.repeat(40), date: '2026-11-24', subject: 'fix', files: [0, 1], refs: ['main'], broad: false, patch: 'same' },
  { repo: 'r', hash: 'b'.repeat(40), date: '2026-11-23', subject: 'copy', files: [0, 1], refs: ['topic'], broad: false, patch: 'same' },
 ] };
 const ix = index(d), h = await ix.query({ lens: 'history', file: 0, side: 'after' });
 assert.ok(h.rows.some(r => r.status === 'hotspot' && r.score === 2)); assert.ok(h.rows.some(r => r.status === 'co-change'));
 assert.ok((await ix.query({ lens: 'branches', side: 'after' })).rows[0].detail.includes('1 patch-equivalent candidates'));
});
test('evidence redaction includes keys, pagination and cancellation are bounded', async () => {
 const token = 'ghp_' + 'x'.repeat(25), d = collectInsights([input(0, 'api.ts', `fetch('/${token}')`)], graph);
 assert.ok(!JSON.stringify(d.facts).includes(token)); assert.equal(redact('secret=hidden'), 'secret=[redacted]');
 const ix = index(data(), entries(1200)); const r = await ix.query({ lens: 'feature', side: 'after', offset: 100 });
 assert.equal(r.rows.length, 100); assert.equal(r.rows[0].file, 100); assert.equal(r.total, 1200);
 const cancelled = await ix.query({ lens: 'feature', side: 'after' }, () => true); assert.equal(cancelled.partial, true); assert.equal(cancelled.rows.length, 0);
 const capped = collectInsights([input(0, 'Many.ts', Array.from({length: 1600}, (_, i) => `const code${i} = "SCN-${i}";`).join('\n'))], graph);
 assert.equal(capped.facts.length, 1500); assert.ok(capped.notes.length);
});
test('root tsconfig aliases bind JSX component consumers without project execution', async () => {
 const inputs = [input(0, 'src/Card.tsx', 'export function Card() { return <div/>; }'), input(1, 'src/Page.tsx', "import {Card} from '@/Card'; export function Page() { return <Card/>; }"), input(2, 'tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}')];
 const units = await Promise.all(inputs.slice(0, 2).map(async input => ({ input, parsed: await extractFile(input.path, input.text) })));
 const g = assemble(units, inputs); assert.ok(g.edges.some(e => e.confidence === 'resolved' && g.symbols[e.from].name === 'Page' && g.symbols[e.to].name === 'Card'));
});
test('Spring Exchange routes honor explicit gateway prefix rewrites', async () => {
 const inputs = [input(0, 'Client.java', '@HttpExchange("/gateway")\ninterface Client { @GetExchange("/orders") String load(); }'), { ...input(1, 'Controller.java', '@RestController\n@RequestMapping("/v2")\nclass Controller { @GetMapping("/orders") String list() { return "ok"; } }'), repo: 'api' }];
 const units = await Promise.all(inputs.map(async input => ({ input, parsed: await extractFile(input.path, input.text) })));
 const g = assemble(units, inputs, { repositories: [{id:'r'}, {id:'api', service:'orders'}], bindings: [{ from:'r', client:'Client', service:'orders', stripPrefix:'/gateway', pathPrefix:'/v2' }] });
 assert.ok(g.edges.some(e => e.kind === 'http' && e.confidence === 'resolved' && g.symbols[e.to].name === 'Controller.list'));
});
test('contract text filters never turn a changed field into a false addition', async () => {
 const d=collectInsights([input(0,'OrderDto.ts','interface OrderDto { amount: number; }','before'),input(0,'OrderDto.ts','interface OrderDto { amount?: number; }')],graph);
 const r=await index(d).query({lens:'contracts',side:'compare',text:'optional'});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].status,'changed');
});
test('shared writes are review evidence, never a proven concurrency defect', async () => {
 const ix=index(data(),entries(4),[{...edge(0,3),kind:'write'},{...edge(1,3),kind:'write'}]);
 const r=await ix.query({lens:'recovery',side:'after'});
 assert.equal(r.rows.filter(r=>r.status==='review point').length,2);
 assert.ok(r.rows.filter(r=>r.status==='review point').every(r=>r.detail.includes('not proof of a race')));
});
test('interface implementation links remain probable and ambiguity adds no chosen implementation', async () => {
 const files=[input(0,'Store.java','interface Store { void save(); }'),input(1,'StoreImpl.java','class StoreImpl implements Store { public void save() {} }')];
 const units=await Promise.all(files.map(async input=>({input,parsed:await extractFile(input.path,input.text)})));
 const unique=assemble(units,files);assert.ok(unique.edges.some(e=>e.confidence==='probable'&&unique.symbols[e.from].name==='Store.save'&&unique.symbols[e.to].name==='StoreImpl.save'));
 const other=input(2,'Other.java','class Other implements Store { public void save() {} }');files.push(other);units.push({input:other,parsed:await extractFile(other.path,other.text)});
 const ambiguous=assemble(units,files);assert.ok(!ambiguous.edges.some(e=>ambiguous.symbols[e.from].name==='Store.save'&&ambiguous.symbols[e.to].name.endsWith('.save')));
});
test('large diff seeds return a capped first page rather than an empty impact map',async()=>{
 const files=entries(6000);for(const f of files)f.status='modified';
 const r=await index(data(),files).query({lens:'impact',side:'after'});
 assert.equal(r.rows.length,100);assert.equal(r.total,5000);assert.equal(r.partial,true);
});
test('recovery for a selected file includes other writers of the same table',async()=>{
 const r=await index(data(),entries(4),[{...edge(0,3),kind:'write'},{...edge(1,3),kind:'write'}]).query({lens:'recovery',side:'after',file:0});
 assert.ok(r.rows.some(r=>r.file===1&&r.status==='review point'));assert.ok(r.connections.some(c=>c.fromFile===0&&c.toFile===1));
});
test('absolute Retrofit URLs retain explicit host bindings',async()=>{
 const inputs=[input(0,'Api.kt','interface Api {\n @GET("https://orders.example.test/orders")\n fun load(): String\n}'),{...input(1,'Orders.java','@RestController class Orders { @GetMapping("/orders") String list() {return "ok";} }'),repo:'api'}];
 const units=await Promise.all(inputs.map(async input=>({input,parsed:await extractFile(input.path,input.text)})));
 const g=assemble(units,inputs,{repositories:[{id:'r'},{id:'api',service:'orders'}],bindings:[{from:'r',client:'Api',service:'orders',baseUrl:'https://orders.example.test'}]});
 assert.ok(g.edges.some(e=>e.kind==='http'&&e.confidence==='resolved'&&g.symbols[e.to].name==='Orders.list'));
});
test('before evidence uses before symbol spans even when the function shrinks',async()=>{
 const inputs=[input(0,'actions.ts','export function load() {\n\n\n dispatch(Orders.Load);\n}', 'before'),input(0,'actions.ts','export function load() {}')];
 const units=await Promise.all(inputs.map(async input=>({input,parsed:await extractFile(input.path,input.text)})));
 const g=assemble(units,inputs),d=collectInsights(inputs,g),fact=d.facts.find(f=>f.kind==='state'&&f.side==='before');
 assert.ok(fact);assert.notEqual(fact.symbol,undefined);assert.equal(g.symbols[fact.symbol!].name,'load');assert.equal(g.symbols[fact.symbol!].beforeEndLine,5);
});
test('skipped contract sides are unknown rather than false removals',async()=>{
 const d=collectInsights([input(0,'OrderDto.ts','interface OrderDto { amount: number; }','before'),{...input(0,'OrderDto.ts',''),skipReason:'Source exceeds analysis limit.'}],graph);
 const r=await index(d).query({lens:'contracts',side:'compare'});
 assert.equal(r.rows.length,1);assert.equal(r.rows[0].status,'unpaired (coverage limited)');
});
