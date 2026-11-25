import { writeFile, mkdir } from 'node:fs/promises';
import { InsightIndex } from '../src/insights/query.js';
import { EdgeTable } from '../src/relations/query.js';
import type { Fact, InsightData } from '../src/insights/model.js';
import type { GraphSymbol } from '../src/relations/model.js';
import type { FileEntry } from '../src/model.js';
const fileCount=20000, symbolCount=200000, edgeCount=1000000;
const files:FileEntry[]=Array.from({length:fileCount},(_,id)=>({id,path:`src/feature${id%100}/File${id}.ts`,status:'snapshot',after:{kind:'text',bytes:100},additions:0,deletions:0}));
const symbols:GraphSymbol[]=Array.from({length:symbolCount},(_,id)=>({id,key:String(id),name:`f${id}`,repo:'r',file:id%fileCount,kind:'function',line:1,endLine:10,versions:2}));
const facts:Fact[]=Array.from({length:500000},(_,id)=>({id,file:id%fileCount,line:1,side:'after',kind:'state',label:`Action${id%100}`,key:`Action${id%100}`,detail:'synthetic',confidence:'probable'}));
const edges=new EdgeTable(edgeCount); for(let i=0;i<edgeCount;i++)edges.set(i,{from:i%symbolCount,to:(i+1)%symbolCount,kind:'call',confidence:'resolved',versions:2,file:i%fileCount,line:1,reason:'fixture'});
const data:InsightData={version:1,facts,features:[],notes:[],history:{commits:[],refs:[],notes:[]}};
const start=performance.now(), index=new InsightIndex(data,files,symbols,edges), indexMs=performance.now()-start;
const results=[]; for(const lens of ['feature','state','contracts','impact','components'] as const){const t=performance.now(),r=await index.query({lens,side:'after',file:lens==='impact'?1:undefined});results.push({lens,ms:performance.now()-t,total:r.total,rows:r.rows.length,connections:r.connections.length,partial:r.partial});}
await mkdir('test-results',{recursive:true});const report={fileCount,symbolCount,edgeCount,facts:facts.length,indexMs,rssMiB:process.memoryUsage().rss/1024/1024,results};await writeFile('test-results/insights-benchmark.json',JSON.stringify(report,null,2));console.log(report);
