import {GraphIndex,EdgeTable} from '../src/relations/query.js';
import type {GraphSymbol} from '../src/relations/model.js';
const stress=process.argv.includes('--stress');const n=stress?1000000:200000,m=stress?5000000:1000000,files=stress?100000:20000;
const started=performance.now();const symbols:GraphSymbol[]=Array.from({length:n},(_,id)=>({id,key:String(id),file:id%files,repo:'synthetic',name:`symbol${id}`,kind:'function',line:1,endLine:1,versions:3}));
const edges=new EdgeTable(m);for(let i=0;i<m;i++)edges.set(i,{from:i%n,to:(i%n+1+Math.floor(i/n))%n,kind:'call',confidence:'resolved',versions:3,file:i%files,line:1,reason:'Synthetic benchmark edge'});
const index=new GraphIndex({symbols,edges});const buildMs=performance.now()-started;const times:number[]=[];for(let i=0;i<10;i++){const start=performance.now();await index.query({mode:'path',start:i,target:i+8,side:'after'});times.push(performance.now()-start);}
console.log(JSON.stringify({synthetic:true,files,symbols:n,edges:m,indexAndFixtureMs:Math.round(buildMs),queryMedianMs:times.sort((a,b)=>a-b)[5],rssMiB:Math.round(process.memoryUsage().rss/1048576),note:'Node index/query only; not HTML startup or browser frame benchmark'},null,2));
