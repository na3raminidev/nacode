import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { collectHistory } from '../src/generator/history.js';
import type { Collection } from '../src/generator/collect.js';
test('history is opt-in, pinned, scope-safe and bounded across explicit local refs', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'graphicode-history-'));
 const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { encoding:'utf8', windowsHide:true }).trim();
 try {
  git('init', '-b', 'main'); await writeFile(path.join(root, 'included file.ts'), 'export const a = 1;'); git('add', '.'); git('commit', '-m', 'first'); const first = git('rev-parse', 'HEAD');
  git('branch', 'topic'); await writeFile(path.join(root, 'excluded.ts'), 'private value'); git('add', '.'); git('commit', '-m', 'excluded subject');
  await writeFile(path.join(root, 'included file.ts'), 'export const a = 2;'); git('add', '.'); git('commit', '-m', `Revert fixture\n\nThis reverts commit ${first}.`);
  const c: Collection = { root, files:[{path:'included file.ts',status:'snapshot',additions:0,deletions:0,after:{disk:path.join(root,'included file.ts'),size:19}}], exclusions:{} };
  assert.equal(collectHistory(c).commits.length, 0); c.history = {limit:10,refs:['topic','missing']}; c.historyBase = {root:'main'};
  const h = collectHistory(c); assert.equal(h.refs.length, 2); assert.ok(h.refs.every(r => /^[a-f0-9]{40}$/.test(r.sha)));
  assert.equal(h.commits.length, 2); assert.ok(!JSON.stringify(h).includes('excluded subject')); assert.ok(h.commits.some(c => c.revert === first));
  assert.deepEqual(h.commits.find(c => c.hash === first)?.refs, ['main','topic']); assert.ok(h.notes.some(n => n.includes('missing')));
  c.history.limit = 1; assert.equal(collectHistory(c).refs[0].truncated, true);
  assert.equal(git('branch', '--show-current'), 'main');
 } finally { await rm(root, {recursive:true,force:true}); }
});
test('history preserves unusual paths and flags equivalent patches without checking out branches', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'graphicode-history-patches-'));
 const git=(...args:string[])=>execFileSync('git',['-C',root,'-c','core.hooksPath=NUL','-c','commit.gpgsign=false','-c','core.autocrlf=false','-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{encoding:'utf8',windowsHide:true}).trim();
 const name='included space-\u0628.ts';
 try {
  git('init','-b','main');await writeFile(path.join(root,name),'const a=1;');git('add','.');git('commit','-m','initial');const base=git('rev-parse','HEAD');
  await writeFile(path.join(root,name),'const a=2;');git('add','.');git('commit','-m','change');const tree=git('rev-parse','HEAD^{tree}');
  const copy=git('commit-tree',tree,'-p',base,'-m','copied change');git('update-ref','refs/heads/copy',copy);
  const c:Collection={root,files:[{path:name,status:'snapshot',additions:0,deletions:0,after:{disk:path.join(root,name),size:10}}],exclusions:{},history:{limit:10,refs:['copy']},historyBase:{root:'main'}};
  const h=collectHistory(c),changed=h.commits.filter(c=>c.subject==='change'||c.subject==='copied change');
  assert.equal(changed.length,2);assert.ok(changed[0].patch);assert.equal(changed[0].patch,changed[1].patch);assert.ok(changed.every(c=>c.files[0]===0));assert.equal(git('branch','--show-current'),'main');
 } finally {await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});}
});
test('history exported from a repository subdirectory maps repo-relative paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'graphicode-history-scope-'));
 const git=(...args:string[])=>execFileSync('git',['-C',root,'-c','core.hooksPath=NUL','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.test',...args],{encoding:'utf8',windowsHide:true}).trim();
 try {
  const {mkdir}=await import('node:fs/promises');const sub=path.join(root,'sub');await mkdir(sub);await writeFile(path.join(sub,'a.ts'),'const a=1;');
  git('init','-b','main');git('add','.');git('commit','-m','nested file');
  const h=collectHistory({root:sub,files:[{path:'a.ts',status:'snapshot',additions:0,deletions:0,after:{disk:path.join(sub,'a.ts'),size:10}}],exclusions:{},history:{limit:10,refs:[]}});
  assert.equal(h.commits.length,1);assert.deepEqual(h.commits[0].files,[0]);
 }finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});}
});
