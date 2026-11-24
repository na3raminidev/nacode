import type { AnalysisConfig, RepositoryInfo } from '../relations/model.js';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { minimatch } from 'minimatch';
import { git, resolveRef } from './git.js';
import type { ContentKind, Status } from '../model.js';

export interface Options {
  relationships?: 'auto' | 'off'; include: string[]; exclude: string[]; includeSensitive?: boolean; includeGenerated?: boolean;
  ignore: boolean; includeUntracked?: boolean; out: string;
  base?: string; head?: string; workingTree?: boolean;
}
export interface Source { root?: string; size: number; kind?: ContentKind; disk?: string; oid?: string; note?: string }
export interface Candidate {
  path: string; localPath?: string; repo?: string; oldPath?: string; status: Status; before?: Source; after?: Source;
  additions: number; deletions: number;
}
export interface Collection { relationships?: 'auto' | 'off'; context?: boolean; analysis?: AnalysisConfig; repositories?: RepositoryInfo[]; name?: string; root: string; files: Candidate[]; exclusions: Record<string, number>; comparison?: string }
const generated = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', '.gradle', '.next', '.cache', '__pycache__', '.venv', 'venv', 'coverage']);
const sensitive = /(^|\/)(\.env(?:\..*)?|id_rsa(?:\..*)?|id_ed25519(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|keystore\.properties|local\.properties)$|\.(pem|key|p12|pfx|jks|keystore)$/i;
export function filterReason(name: string, opts: Options): string | undefined {
  const parts = name.split('/');
  if (parts.includes('.git') || parts.includes('.svn') || parts.includes('.hg')) return 'repository internals';
  if (!opts.includeGenerated && parts.some(p => generated.has(p))) return 'generated / dependencies';
  if (!opts.includeSensitive && sensitive.test(name) && !/\.env\.(example|sample|template)$/.test(name)) return 'sensitive filenames';
  if (opts.exclude.some(pattern => minimatch(name, pattern, { dot: true }))) return 'exclude filters';
  if (opts.include.length && !opts.include.some(pattern => minimatch(name, pattern, { dot: true }))) return 'outside include filters';
}
async function canonicalOutput(out: string): Promise<string> {
  try { return await realpath(path.resolve(out)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return path.resolve(out); }
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function excluded(counts: Record<string, number>, reason: string) { counts[reason] = (counts[reason] ?? 0) + 1; }
async function statSource(root: string, name: string): Promise<Source> {
  const disk = path.resolve(root, name); const relative = path.relative(root, disk);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) throw new Error('Path escapes root');
  let current = root;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    if ((await lstat(current)).isSymbolicLink()) return { size: 0, kind: 'symlink', note: 'Symlink ancestor is not followed' };
  }
  const stat = await lstat(disk);
  if (stat.isSymbolicLink()) return { size: 0, kind: 'symlink', note: 'Symlinks are not followed' };
  if (stat.isDirectory()) return { size: 0, kind: 'submodule', note: 'Nested repository / submodule; export it separately' };
  if (!stat.isFile()) return { size: 0, kind: 'unsupported', note: 'Not a regular file' };
  return { size: stat.size, disk };
}
export async function verifyDisk(root: string, source: Source): Promise<Buffer> {
  const checked = await statSource(root, path.relative(root, source.disk!).split(path.sep).join('/'));
  if (checked.kind || !checked.disk) throw new Error('File type changed during export');
  const canonical = await realpath(checked.disk); const rel = path.relative(root, canonical);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Resolved file escapes root');
  return readFile(checked.disk);
}
export async function snapshot(folder: string, opts: Options): Promise<Collection> {
  opts = { ...opts, out: await canonicalOutput(opts.out) };
  const root = await realpath(folder); const files: Candidate[] = []; const exclusions: Record<string, number> = {};
  type Rule = { base: string; matcher: Ignore };
  const pending: { dir: string; rules: Rule[] }[] = [{ dir: '', rules: [] }];
  while (pending.length) {
    const { dir, rules: inherited } = pending.pop()!; const absolute = path.join(root, dir); const rules = [...inherited];
    if (opts.ignore) {
      try { const ignoreFile = path.join(absolute, '.gitignore'); if ((await lstat(ignoreFile)).isFile()) rules.push({ base: dir, matcher: ignore().add(await readFile(ignoreFile, 'utf8')) }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      const name = dir ? `${dir}/${entry.name}` : entry.name;
      if (samePath(path.resolve(root, name), path.resolve(opts.out))) { excluded(exclusions, 'output file'); continue; }
      const isDir = entry.isDirectory(); const reason = filterReason(name, { ...opts, include: isDir ? [] : opts.include });
      if (reason) { excluded(exclusions, reason); continue; }
      let ignored = false;
      for (const rule of rules) {
        const decision = rule.matcher.test((rule.base ? name.slice(rule.base.length + 1) : name) + (isDir ? '/' : ''));
        if (decision.ignored) ignored = true;
        if (decision.unignored) ignored = false;
      }
      if (ignored) { excluded(exclusions, 'ignore rules'); continue; }
      if (isDir) {
        let nested = false;
        try { await lstat(path.join(root, name, '.git')); nested = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
        if (!nested) { pending.push({ dir: name, rules }); continue; }
      }
      files.push({ path: name, status: 'snapshot', after: await statSource(root, name), additions: 0, deletions: 0 });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path)); return { root, files, exclusions, relationships: opts.relationships };
}
interface TreeFile { size: number; mode: string; oid: string }
function tree(root: string, ref: string): Map<string, TreeFile> {
  const result = new Map<string, TreeFile>();
  for (const row of git(root, ['ls-tree', '-rlz', ref]).toString('utf8').split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t'); const [mode, , oid, size] = row.slice(0, tab).trim().split(/\s+/);
    result.set(row.slice(tab + 1), { mode, oid, size: Number(size) || 0 });
  }
  return result;
}
function treeSource(file?: TreeFile): Source | undefined {
  if (!file) return undefined;
  if (file.mode === '160000') return { size: 0, kind: 'submodule', note: `Git commit ${file.oid}` };
  if (file.mode === '120000') return { size: file.size, kind: 'symlink', note: 'Symlink target not followed' };
  return { size: file.size, oid: file.oid };
}
export async function comparison(folder: string, opts: Options): Promise<Collection> {
  opts = { ...opts, out: await canonicalOutput(opts.out) };
  const root = await realpath(git(folder, ['rev-parse', '--show-toplevel']).toString().trim());
  const base = resolveRef(root, opts.workingTree ? 'HEAD' : opts.base!);
  const head = opts.workingTree ? undefined : resolveRef(root, opts.head!); const refs = head ? [base, head] : [base];
  const beforeTree = tree(root, base); const afterTree = head ? tree(root, head) : undefined;
  const common = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--ignore-submodules=none', '-M', ...refs];
  const names = git(root, [...common, '--name-status', '-z', '--']).toString('utf8').split('\0');
  const statsRaw = git(root, [...common, '--numstat', '-z', '--']).toString('utf8').split('\0');
  const stats = new Map<string, [number, number]>();
  for (let i = 0; i < statsRaw.length && statsRaw[i]; i++) {
    const row = statsRaw[i]; const first = row.indexOf('\t'); const second = row.indexOf('\t', first + 1);
    const adds = Number(row.slice(0, first)) || 0; const dels = Number(row.slice(first + 1, second)) || 0;
    let name = row.slice(second + 1); if (!name) { i++; name = statsRaw[++i]; }
    stats.set(name, [adds, dels]);
  }
  const files: Candidate[] = []; const exclusions: Record<string, number> = {}; const changedPaths = new Set<string>();
  for (let i = 0; i < names.length && names[i];) {
    const code = names[i++]; const old = names[i++]; const name = /^[RC]/.test(code) ? names[i++] : old;
    changedPaths.add(old); changedPaths.add(name);
    const reason = filterReason(name, opts) ?? (name !== old ? filterReason(old, { ...opts, include: [] }) : undefined);
    if (reason) { excluded(exclusions, reason); continue; }
    if (opts.workingTree && samePath(path.resolve(root, name), path.resolve(opts.out))) { excluded(exclusions, 'output file'); continue; }
    const before = treeSource(beforeTree.get(old));
    const after = head ? treeSource(afterTree!.get(name)) : code[0] === 'D' ? undefined : await statSource(root, name);
    const status: Status = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted' : code[0] === 'R' ? 'renamed' : code[0] === 'T' ? 'typechanged' : 'modified';
    const [additions, deletions] = stats.get(name) ?? [0, 0];
    files.push({ path: name, oldPath: name !== old ? old : undefined, status, before, after, additions, deletions });
  }
  if (opts.workingTree && opts.includeUntracked) {
    const names = git(root, ['ls-files', '--others', ...(opts.ignore ? ['--exclude-standard'] : []), '-z']).toString('utf8').split('\0').filter(Boolean);
    for (const name of names) {
      const reason = filterReason(name, opts); if (reason) { excluded(exclusions, reason); continue; }
      if (samePath(path.resolve(root, name), path.resolve(opts.out))) continue;
      files.push({ path: name, status: 'added', after: await statSource(root, name), additions: 0, deletions: 0 });
    }
  }
  if (opts.relationships === 'auto') {
    const covered = new Set(files.flatMap(f => [f.path, ...(f.oldPath ? [f.oldPath] : [])]));
    for (const [name, old] of beforeTree) {
      if (covered.has(name) || changedPaths.has(name)) continue;
      const reason = filterReason(name, opts); if (reason) { excluded(exclusions, reason); continue; }
      if (samePath(path.resolve(root, name), path.resolve(opts.out))) continue;
      const before = treeSource(old), after = afterTree ? treeSource(afterTree.get(name)) : await statSource(root, name);
      files.push({ path: name, status: 'snapshot', before, after, additions: 0, deletions: 0 });
    }
  }  files.sort((a, b) => a.path.localeCompare(b.path));
  return { root, files, exclusions, relationships: opts.relationships, context: opts.relationships === 'auto', comparison: head ? `${opts.base} (${base.slice(0, 7)}) -> ${opts.head} (${head.slice(0, 7)})` : `HEAD (${base.slice(0, 7)}) -> working tree` };
}



