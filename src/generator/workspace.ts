import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { snapshot, comparison, type Collection, type Options } from './collect.js';
import type { AnalysisConfig } from '../relations/model.js';
interface RepoConfig { id: string; root: string; service?: string; include?: string[]; exclude?: string[]; base?: string; head?: string; workingTree?: boolean }
export interface WorkspaceConfig extends AnalysisConfig { version: 1; name?: string; repositories: RepoConfig[] }
export async function workspace(configPath: string, opts: Options): Promise<Collection> {
  const configFile = await realpath(configPath), root = path.dirname(configFile);
  const config = JSON.parse(await readFile(configFile, 'utf8')) as WorkspaceConfig;
  if (config.version !== 1 || !Array.isArray(config.repositories) || !config.repositories.length) throw new Error('Workspace requires version: 1 and a nonempty repositories array.');
  for (const values of [config.bindings, config.contracts]) if (values !== undefined && !Array.isArray(values)) throw new Error('Bindings and contracts must be arrays.');
  const ids = new Set<string>(), services = new Set<string>();
  for (const repo of config.repositories) {
    if (!/^[A-Za-z][\w.-]*$/.test(repo.id) || ids.has(repo.id) || typeof repo.root !== 'string') throw new Error('Repository IDs must be unique safe identifiers; each requires a root path.');
    ids.add(repo.id); if (repo.service) { if (typeof repo.service !== 'string') throw new Error('Invalid service ID'); services.add(repo.service); }
    if (repo.workingTree ? repo.base || repo.head : !!repo.base !== !!repo.head) throw new Error(`Invalid comparison for ${repo.id}`);
    for (const patterns of [repo.include, repo.exclude]) if (patterns && (!Array.isArray(patterns) || patterns.some(p => typeof p !== 'string'))) throw new Error('Filters must be arrays of strings.');
  }
  for (const b of config.bindings ?? []) if (!ids.has(b.from) || !services.has(b.service) || b.client !== undefined && typeof b.client !== 'string' || b.baseUrl !== undefined && (!/^https?:\/\//.test(b.baseUrl) || new URL(b.baseUrl).username || new URL(b.baseUrl).password)) throw new Error('Invalid binding; use known repository/service IDs and a credential-free HTTP baseUrl.');
  for (const b of config.bindings ?? []) for (const prefix of [b.stripPrefix, b.pathPrefix]) if (prefix !== undefined && (typeof prefix !== 'string' || !prefix.startsWith('/') || /[?#\s]/.test(prefix) || prefix.includes('..'))) throw new Error('Binding path prefixes must be explicit absolute URL paths.');
  for (const c of config.contracts ?? []) if (!ids.has(c.repo) || !services.has(c.service) || typeof c.path !== 'string' || c.path.split(/[\\/]/).includes('..') || path.isAbsolute(c.path)) throw new Error('Contract paths must be relative to a known repository and service.');
  if (config.features !== undefined && (!Array.isArray(config.features) || config.features.length > 200 || config.features.some(f => !f || typeof f.id !== 'string' || !/^[\w.-]+$/.test(f.id) || f.label !== undefined && typeof f.label !== 'string' || !Array.isArray(f.include) || !f.include.length || f.include.length > 50 || f.include.some(p => typeof p !== 'string' || p.length > 500)) || new Set(config.features.map(f => f.id)).size !== config.features.length)) throw new Error('Features require unique safe IDs and bounded include-glob arrays.');
  const diff = config.repositories.some(r => r.workingTree || r.base);
  const output: Collection = { root, name: config.name ?? path.basename(root), files: [], exclusions: {}, repositories: [], relationships: opts.relationships, context: diff && opts.relationships !== 'off', historyBase: {}, analysis: { features: config.features, repositories: [], bindings: config.bindings ?? [], contracts: config.contracts ?? [] } };
  for (const repo of config.repositories) {
    const options = { ...opts, include: opts.include.length ? opts.include : repo.include ?? [], exclude: [...opts.exclude, ...(repo.exclude ?? [])], base: repo.base, head: repo.head, workingTree: repo.workingTree };
    const collection = repo.workingTree || repo.base ? await comparison(path.resolve(root, repo.root), options) : await snapshot(path.resolve(root, repo.root), options);
    output.historyBase![repo.id] = repo.head ?? 'HEAD';
    const info = { id: repo.id, service: repo.service, comparison: collection.comparison ?? (diff ? 'Fixed snapshot context on both sides' : undefined) };
    output.repositories!.push(info); output.analysis!.repositories!.push(info);
    for (const file of collection.files) {
      const before = file.before ?? (diff && !collection.comparison ? file.after : undefined);
      output.files.push({ ...file, repo: repo.id, localPath: file.path, path: `${repo.id}/${file.path}`, oldPath: file.oldPath ? `${repo.id}/${file.oldPath}` : undefined, before: before ? { ...before, root: collection.root } : undefined, after: file.after ? { ...file.after, root: collection.root } : undefined });
    }
    for (const [reason, count] of Object.entries(collection.exclusions)) output.exclusions[`${repo.id}: ${reason}`] = count;
  }
  if (diff) output.comparison = 'Workspace comparison: independent repository revisions';
  for (const spec of config.contracts ?? []) if (!output.files.some(f => f.repo === spec.repo && f.localPath === spec.path)) throw new Error(`Contract is excluded or unavailable: ${spec.repo}/${spec.path}. Adjust filters explicitly; excluded contracts are never read.`);
  output.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return output;
}
