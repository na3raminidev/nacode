import { collectInsights } from '../insights/extract.js';
import { collectHistory } from './history.js';
import { analyze } from '../relations/analyze.js';
import type { AnalysisFile } from '../relations/model.js';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { open, readFile, mkdir, mkdtemp, unlink, rmdir, rename, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ContentRef, Manifest } from '../model.js';
import { GitObjects } from './git.js';
import { verifyDisk, type Collection, type Source } from './collect.js';

export function safeJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
export function decodeContent(bytes: Buffer): { text?: string; kind: ContentRef['kind']; note?: string } {
  if (bytes.includes(0) && !(bytes[0] === 255 && bytes[1] === 254) && !(bytes[0] === 254 && bytes[1] === 255)) return { kind: 'binary', note: 'Binary content is not embedded' };
  try {
    const encoding = bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8';
    return { kind: 'text', text: new TextDecoder(encoding, { fatal: true }).decode(bytes), note: encoding !== 'utf-8' ? `Decoded from ${encoding}` : undefined };
  } catch { return { kind: 'unsupported', note: 'Unsupported text encoding; expected UTF-8 or BOM-marked UTF-16' }; }
}
export async function exportHTML(collection: Collection, out: string, mode: Manifest['mode'], force = false, assetRoot?: string): Promise<Manifest> {
  const destination = path.resolve(out);
  if (!force) {
    try { await access(destination); throw new Error('Output already exists. Choose another path or pass --force.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  const assets = assetRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');
  const [shell, css, viewer, worker, notices, cityWorker, graphWorker] = await Promise.all(['shell.html', 'viewer.css', 'viewer.js', 'worker.js', 'notices.txt', 'city-worker.js', 'graph-worker.js'].map(p => readFile(path.join(assets, p), 'utf8')));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'graphicode-'));
  const blocksPath = path.join(temporary, 'blocks'); const blocks = await open(blocksPath, 'w');
  const dedup = new Map<string, string>(); let blockCount = 0;
  const analysisFiles: AnalysisFile[] = [];
  const readers = new Map<string, GitObjects>();

  const objectReader = (root: string) => { let reader = readers.get(root); if (!reader) { reader = new GitObjects(root); readers.set(root, reader); } return reader; };
  const manifest: Manifest = { version: 2, mode, name: collection.name ?? path.basename(collection.root), repositories: collection.repositories, context: collection.context, created: new Date().toISOString(), comparison: collection.comparison, files: [], exclusions: collection.exclusions, totalBytes: 0 };
  let partial: string | undefined;
  try {
    async function content(source?: Source, context?: Omit<AnalysisFile, 'text'>): Promise<ContentRef | undefined> {
      if (!source) return undefined;
      if (source.kind) { if (context && collection.relationships !== 'off') analysisFiles.push({ ...context, text: '', skipReason: source.note ?? source.kind }); return { kind: source.kind, bytes: source.size, note: source.note }; }
      const bytes = source.oid ? await objectReader(source.root ?? collection.root).read(source.oid) : await verifyDisk(source.root ?? collection.root, source);
      const decoded = decodeContent(bytes);
      manifest.totalBytes += bytes.length;
      if (decoded.text === undefined) { if (context && collection.relationships !== 'off') analysisFiles.push({ ...context, text: '', skipReason: decoded.note ?? decoded.kind }); return { kind: decoded.kind, bytes: bytes.length, note: decoded.note }; }
      const text = decoded.text;
      if (context && collection.relationships !== 'off') {
        const code = /\.(?:[cm]?[jt]sx?|kt|kts|java|md|ya?ml|sql|xml|json)$/.test(context.path);
        const contract = collection.analysis?.contracts?.some(c => c.repo === context.repo && c.path === context.path);
        const oversized = Buffer.byteLength(text) > 2 * 1024 * 1024;
        analysisFiles.push({ ...context, text: (code || contract) && !oversized ? text : '', skipReason: oversized ? 'Source exceeds the 2 MiB analysis limit.' : undefined });
      }
      const digest = createHash('sha256').update(text).digest('hex'); let block = dedup.get(digest);
      if (!block) {
        block = `b${blockCount++}`; dedup.set(digest, block);
        await blocks.write(`<script type="application/octet-stream" id="${block}">${gzipSync(text).toString('base64')}</script>\n`);
      }
      let lines = 1; for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 || (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) !== 10)) lines++;
      const notes = [decoded.note, text.includes('\r\n') ? 'CRLF' : text.includes('\r') ? 'CR' : 'LF', text.length && !/[\r\n]$/.test(text) ? 'No final newline' : ''].filter(Boolean).join(' / ');
      return { block, kind: 'text', bytes: bytes.length, lines, note: notes };
    }
    for (const candidate of collection.files) {
      const context = { file: manifest.files.length, repo: candidate.repo ?? 'root', path: candidate.localPath ?? candidate.path, identityPath: candidate.oldPath ?? candidate.path };
      const before = await content(candidate.before, { ...context, side: 'before' }); const after = await content(candidate.after, { ...context, side: 'after' });
      manifest.files.push({ id: manifest.files.length, path: candidate.path, repo: candidate.repo, oldPath: candidate.oldPath, status: candidate.status, before, after,
        additions: candidate.status === 'added' && !candidate.additions && after?.kind === 'text' ? Math.max(0, (after.lines ?? 1) - (after.note?.includes('No final newline') ? 0 : 1)) : candidate.additions,
        deletions: candidate.deletions });
    }
    if (collection.relationships !== 'off') {
      const graph = await analyze(analysisFiles, collection.analysis ?? { repositories: collection.repositories ?? [{ id: 'root' }] }, assets, path.join(path.dirname(destination), '.cache', 'graphicode'));
      const insights = collectInsights(analysisFiles, graph, collection.analysis);
      insights.history = collectHistory(collection);
      const graphBlocks: string[] = [];
      const writeGraph = async (value: unknown) => { const id = `g${graphBlocks.length}`; graphBlocks.push(id); await blocks.write(`<script type="application/octet-stream" id="${id}">${gzipSync(JSON.stringify(value)).toString('base64')}</script>\n`); };
      await writeGraph({ version: 1, coverage: graph.coverage });
      for (let i = 0; i < graph.symbols.length; i += 25000) await writeGraph({ symbols: graph.symbols.slice(i, i + 25000) });
      for (let i = 0; i < graph.edges.length; i += 25000) await writeGraph({ edges: graph.edges.slice(i, i + 25000).map(e => [e.from, e.to, e.kind, e.confidence, e.versions, e.file, e.line, e.beforeLine ?? null, e.reason, e.condition ?? null]) });
      await writeGraph({ insights: { ...insights, facts: [] } });
      for (let i = 0; i < insights.facts.length; i += 10000) await writeGraph({ facts: insights.facts.slice(i, i + 10000) });
      manifest.relationships = { blocks: graphBlocks, symbols: graph.symbols.length, edges: graph.edges.length };
      analysisFiles.length = 0;
    }    await blocks.close();
    await mkdir(path.dirname(destination), { recursive: true });
    partial = `${destination}.${process.pid}.${Date.now()}.partial`;
    const output = await open(partial, 'wx');
    try {
      const runtime = viewer.replace(/<\/script/gi, '<\\/script');
      const hash = createHash('sha256').update(runtime).digest('base64');
      const csp = `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; font-src data:; img-src data:; worker-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'`;
      await output.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>graphiCode | Code explorer</title><style>${css}</style></head><body>${shell}`);
      for await (const chunk of createReadStream(blocksPath)) await output.write(chunk as Buffer);
      await output.write(`<script id="manifest" type="application/json">${safeJSON(manifest)}</script><script id="worker-source" type="application/octet-stream">${Buffer.from(worker).toString('base64')}</script><script id="city-worker-source" type="application/octet-stream">${Buffer.from(cityWorker).toString('base64')}</script><script id="graph-worker-source" type="application/octet-stream">${Buffer.from(graphWorker).toString('base64')}</script><script id="third-party-notices" type="application/json">${safeJSON(notices)}</script><script>${runtime}</script></body></html>`);
    } finally { await output.close(); }
    // Refuse accidental overwrite even if a file appeared while export was running.
    if (!force) { try { await access(destination); throw new Error('Output appeared during export; refusing overwrite'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
    await rename(partial, destination); partial = undefined;
    return manifest;
  } finally {
    for (const reader of readers.values()) reader.close(); await blocks.close().catch(() => {});
    await unlink(blocksPath).catch(() => {}); await rmdir(temporary).catch(() => {});
    if (partial) await unlink(partial).catch(() => {});
  }
}
