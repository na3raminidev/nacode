import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot, comparison, filterReason, type Options } from '../src/generator/collect.js';
import { exportHTML, safeJSON, decodeContent } from '../src/generator/export.js';
import type { Manifest } from '../src/model.js';
const defaults = (root: string): Options => ({ include: [], exclude: [], ignore: true, out: path.join(root, 'viewer.html') });
async function folder() { return mkdtemp(path.join(os.tmpdir(), 'graphicode-test-')); }
async function put(root: string, name: string, value: string | Buffer) { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); }
function git(root: string, args: string[], data?: string) { return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, input: data, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function fixtureCommit(root: string, parent?: string) {
  git(root, ['add', '-A']); const tree = git(root, ['write-tree']);
  const commit = git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Test fixture\n');
  git(root, ['update-ref', 'HEAD', commit]); return commit;
}
function embedded(html: string) { return JSON.parse(html.match(/<script id="manifest" type="application\/json">([\s\S]*?)<\/script>/)![1]) as Manifest; }
function text(html: string, block: string) { return gunzipSync(Buffer.from(html.match(new RegExp(`id="${block}">([^<]*)<`))![1], 'base64')).toString(); }

test('filters preserve examples and protect secrets and internals', () => {
  const opts = defaults('.');
  assert.equal(filterReason('src/index.ts', opts), undefined);
  assert.equal(filterReason('.env.example', opts), undefined);
  assert.equal(filterReason('android/release.jks', opts), 'sensitive filenames');
  assert.equal(filterReason('.git/config', { ...opts, includeSensitive: true }), 'repository internals');
  assert.equal(filterReason('src/secret.key', { ...opts, includeSensitive: true }), undefined);
  assert.equal(filterReason('packages/a/index.ts', { ...opts, include: ['packages/**'] }), undefined);
});
test('snapshot handles nested ignores, Unicode, empty and binary files, safe embedded data', async () => {
  const root = await folder(); const attack = '</script><img src=x onerror="globalThis.PWNED=1">';
  await put(root, '.gitignore', '*.log\n'); await put(root, 'debug.log', 'skip');
  await put(root, 'src/.gitignore', '!keep.log\n'); await put(root, 'src/keep.log', 'retained');
  await put(root, 'src/deep/\u03b1.ts', `const html = ${JSON.stringify(attack)};\r\n// no final newline`);
  await put(root, 'CR.txt', 'a\rb\r');
  await put(root, 'empty.txt', ''); await put(root, 'binary.dat', Buffer.from([0, 1, 2]));
  await put(root, '.env', 'TOP_SECRET'); await put(root, 'node_modules/a.js', 'excluded');
  const options = defaults(root); const result = await snapshot(root, options);
  assert(!result.files.some(f => f.path === '.env' || f.path === 'debug.log'));
  assert(result.files.some(f => f.path === 'src/keep.log'));
  await exportHTML(result, options.out, 'snapshot', false, path.resolve('dist/assets'));
  const html = await readFile(options.out, 'utf8'); const data = embedded(html);
  assert.equal(data.files.find(f => f.path === 'binary.dat')!.after!.kind, 'binary');
  assert.equal(data.files.find(f => f.path === 'CR.txt')!.after!.lines, 3);
  assert.equal(data.files.find(f => f.path === 'CR.txt')!.after!.note, 'CR');
  const source = data.files.find(f => f.path.endsWith('\u03b1.ts'))!.after!;
  assert(text(html, source.block!).includes(JSON.stringify(attack))); assert(source.note!.includes('No final newline')); assert(source.note!.includes('CRLF'));
  assert.equal(text(html, data.files.find(f => f.path === 'empty.txt')!.after!.block!), '');
  assert(!html.includes('TOP_SECRET')); assert(!html.includes(attack));
  assert(html.includes('connect-src \'none\''));
  await assert.rejects(() => exportHTML(result, options.out, 'snapshot', false, path.resolve('dist/assets')), /already exists/);
});
test('UTF-16 with BOM and unsupported encoding are explicit', () => {
  assert.equal(decodeContent(Buffer.concat([Buffer.from([255, 254]), Buffer.from('hello', 'utf16le')])).text, 'hello');
  assert.equal(decodeContent(Buffer.from([0xff, 0xfe, 0x00])).kind, 'unsupported');
  assert.equal(decodeContent(Buffer.from([0xc3, 0x28])).kind, 'unsupported');
  assert(!safeJSON({ value: '</script>' }).includes('<'));
});
test('Git comparisons retain both versions, renames, deletes, staged and unstaged changes', async () => {
  const root = await folder(); git(root, ['init', '-q']);
  await put(root, 'src/rename.txt', 'same\n'.repeat(20)); await put(root, 'remove.txt', 'removed\n'); await put(root, 'change.ts', 'const value = 1;\n');
  const base = fixtureCommit(root);
  git(root, ['mv', 'src/rename.txt', 'src/renamed.txt']); git(root, ['rm', 'remove.txt']);
  await put(root, 'change.ts', 'const value = 2;\n'); await put(root, 'new file.txt', 'new\n');
  const head = fixtureCommit(root, base);
  const opts = { ...defaults(root), base, head };
  const diff = await comparison(root, opts);
  assert.equal(diff.files.find(f => f.path === 'src/renamed.txt')!.status, 'renamed');
  assert.equal(diff.files.find(f => f.path === 'remove.txt')!.status, 'deleted');
  assert.equal(diff.files.find(f => f.path === 'new file.txt')!.status, 'added');
  await exportHTML(diff, opts.out, 'diff', false, path.resolve('dist/assets'));
  const html = await readFile(opts.out, 'utf8'); const manifest = embedded(html); const changed = manifest.files.find(f => f.path === 'change.ts')!;
  assert.equal(text(html, changed.before!.block!), 'const value = 1;\n'); assert.equal(text(html, changed.after!.block!), 'const value = 2;\n');
  await put(root, 'change.ts', 'const value = 3;\n'); git(root, ['add', 'change.ts']); await put(root, 'change.ts', 'const value = 4;\n'); await put(root, 'untracked.txt', 'untracked\n');
  const working = await comparison(root, { ...defaults(root), workingTree: true, includeUntracked: true });
  assert(working.files.some(f => f.path === 'untracked.txt')); assert(!working.files.some(f => f.path === 'viewer.html'));
  const workOut = path.join(root, 'working.html'); await exportHTML(working, workOut, 'diff', false, path.resolve('dist/assets'));
  const workHtml = await readFile(workOut, 'utf8'); const work = embedded(workHtml).files.find(f => f.path === 'change.ts')!;
  assert.equal(text(workHtml, work.after!.block!), 'const value = 4;\n');
});
test('external symlinks are metadata, never traversed', async t => {
  const root = await folder(); const outside = await folder(); await put(outside, 'private.txt', 'outside');
  try { await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { t.skip('Host cannot create symlinks'); return; }
  const result = await snapshot(root, defaults(root));
  assert.equal(result.files.find(f => f.path === 'linked')!.after!.kind, 'symlink');
  assert(!result.files.some(f => f.path.includes('private')));
});
test('empty snapshot exports and CLI dry run does not write output', async () => {
  const root = await folder(); const opts = defaults(root); const result = await snapshot(root, opts);
  assert.equal(result.files.length, 0);
  const output = execFileSync(process.execPath, ['dist/cli.js', 'snapshot', root, '--dry-run'], { encoding: 'utf8' }); assert(output.includes('0 files'));
});


test('Git paths with tabs and non-ASCII names survive NUL-delimited parsing', async () => {
  const root = await folder(); git(root, ['init', '-q']);
  const commit = (content: string, parent?: string) => {
    const blob = git(root, ['hash-object', '-w', '--stdin'], content);
    const tree = git(root, ['mktree', '-z'], `100644 blob ${blob}\ttab\tname.txt\0` + `100644 blob ${blob}\t\u03b4.txt\0`);
    return git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', tree, ...(parent ? ['-p', parent] : [])], 'Paths fixture\n');
  };
  const base = commit('old\n'); const head = commit('new\n', base);
  const result = await comparison(root, { ...defaults(root), base, head });
  assert.deepEqual(new Set(result.files.map(f => f.path)), new Set(['tab\tname.txt', '\u03b4.txt']));
  assert(result.files.every(f => f.additions === 1 && f.deletions === 1));
});

test('working-tree comparison does not execute external Git helpers', async () => {
  const root = await folder(); git(root, ['init', '-q']); await put(root, '.gitattributes', '*.txt filter=untrusted\n'); await put(root, 'file.txt', 'before\n'); fixtureCommit(root);
  const marker = path.join(root, 'helper-ran');
  git(root, ['config', 'filter.untrusted.clean', 'echo unsafe > helper-ran']);
  git(root, ['config', 'filter.untrusted.required', 'true']);
  git(root, ['config', 'core.fsmonitor', 'echo unsafe > helper-ran']);
  git(root, ['config', 'diff.external', 'echo unsafe > helper-ran']);
  await put(root, 'file.txt', 'after\n');
  const diff = await comparison(root, { ...defaults(root), workingTree: true });
  assert(diff.files.some(file => file.path === 'file.txt'));
  await assert.rejects(() => readFile(marker), { code: 'ENOENT' });
});

