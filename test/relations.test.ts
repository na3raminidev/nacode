import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFile } from '../src/relations/extract.js';
import { assemble } from '../src/relations/analyze.js';
import { GraphIndex, EdgeTable } from '../src/relations/query.js';
import type { GraphSymbol, Relation } from '../src/relations/model.js';
const symbols: GraphSymbol[] = Array.from({length:4}, (_,id) => ({id,key:String(id),file:id,repo:'r',name:String(id),kind:id===3?'table':'function',line:1,endLine:1,versions:3}));
const edge = (from:number,to:number,versions=3): Relation => ({from,to,versions,kind:'call',confidence:'resolved',file:from,line:1,reason:'fixture'});
test('versioned paths never combine before and after', async () => {
 const index = new GraphIndex({symbols,edges:[edge(0,1,1),edge(1,3,2),edge(0,2),edge(2,3)]});
 for (const side of ['before','after'] as const) { const r=await index.query({mode:'path',start:0,target:3,side}); assert.deepEqual(r.paths,[[2,3]]); }
});
test('uncertain connections are inspectable but excluded from journeys', async () => {
 const index = new GraphIndex({symbols,edges:[{...edge(0,3),confidence:'unresolved'}]});
 assert.equal((await index.query({mode:'journey',start:0,side:'after'})).paths.length,0);
 assert.equal((await index.query({mode:'out',start:0,side:'after'})).edges.length,1);
});
test('packed edges retain evidence and cancellation is bounded',async()=>{
 const table=new EdgeTable(1); const e={...edge(0,3),beforeLine:12,condition:'success'}; table.set(0,e); assert.deepEqual(table.get(0),e);
 const r=await new GraphIndex({symbols,edges:[e]}).query({mode:'journey',start:0,side:'after'},()=>true); assert.equal(r.truncated,true);
});
test('TypeScript compiler resolves included cross-file calls',async()=>{
 const inputs=[{file:0,repo:'r',path:'a.ts',identityPath:'a.ts',text:'export function save() { return 1; }',side:'after' as const},{file:1,repo:'r',path:'b.ts',identityPath:'b.ts',text:"import {save} from './a'; export function click() { return save(); }",side:'after' as const}];
 const units=await Promise.all(inputs.map(async input=>({input,parsed:await extractFile(input.path,input.text)}))); const graph=assemble(units,inputs);
 assert.ok(graph.edges.some(e=>e.confidence==='resolved' && graph.symbols[e.from].name==='click' && graph.symbols[e.to].name==='save'));
});
test('Java and Kotlin declarations retain explicit receiver calls',async()=>{
 for(const [path,text] of [['A.java','class A { void run() { save(); } void save() {} }'],['A.kt','class A { fun run() { save() }\n fun save() {} }']]) { const parsed=await extractFile(path,text); assert.ok(parsed.declarations.some(d=>d.name==='run')); assert.ok(parsed.declarations.some(d=>d.calls.some(c=>c.name==='save'))); }
});

test('explicit React handler and Compose callback registration are linked',async()=>{
 const input={file:0,repo:'r',path:'page.tsx',identityPath:'page.tsx',text:'function save() {} export function Page() { return <button onClick={save}/>; }',side:'after' as const};
 const graph=assemble([{input,parsed:await extractFile(input.path,input.text)}],[input]);assert.ok(graph.edges.some(e=>e.kind==='event'&&graph.symbols[e.to].name==='save'));
 const parsed=await extractFile('Screen.kt','class Screen(val api: Api) {\n fun render() { Button(onClick = { api.load() }) }\n}\n'); assert.ok(parsed.declarations.some(d=>d.eventKind==='event'&&d.calls.some(c=>c.name==='load')));
});

test('street routing is orthogonal and avoids a building interior',async()=>{
 const {streetRoute}=await import('../src/viewer/city/routes.js');
 const points=streetRoute([{x1:0,y1:0,x2:100,y2:0},{x1:100,y1:0,x2:100,y2:100},{x1:0,y1:100,x2:100,y2:100},{x1:0,y1:0,x2:0,y2:100}],[{x:20,y:20,w:60,h:60}],[{x:0,y:50}],[{x:100,y:50}]);
 assert.ok(points);for(let i=1;i<points.length;i++)assert.ok(points[i].x===points[i-1].x||points[i].y===points[i-1].y);
});

test('journeys reach ordinary leaf functions in the selected version',async()=>{
 const index=new GraphIndex({symbols,edges:[edge(0,1),edge(1,2,1)]});
 assert.deepEqual((await index.query({mode:'journey',start:0,side:'after'})).paths,[[0]]);
 assert.deepEqual((await index.query({mode:'journey',start:0,side:'before'})).paths,[[0,1]]);
});
