import { presentableDiff } from '@codemirror/merge';
import { LARGE_FILE, PAGE_LINES, type FileEntry } from '../model.js';
const scope = self as unknown as { postMessage: (data: unknown) => void; onmessage: ((event: MessageEvent) => void) | null };
const cache = new Map<string, string>(); let cacheBytes = 0;
const pending = new Map<string, { resolve: (value: string) => void; reject: (error: Error) => void }>();
const inflight = new Map<string, Promise<string>>();
let searchGeneration = 0;
function remember(block: string, text: string) {
  if (text.length * 2 > 32 * 1024 * 1024) return;
  cache.set(block, text); cacheBytes += text.length * 2;
  while (cacheBytes > 32 * 1024 * 1024) {
    const key = cache.keys().next().value!; cacheBytes -= cache.get(key)!.length * 2; cache.delete(key);
  }
}
async function text(block?: string): Promise<string> {
  if (!block) return '';
  if (cache.has(block)) { const hit = cache.get(block)!; cache.delete(block); cache.set(block, hit); return hit; }
  if (inflight.has(block)) return inflight.get(block)!;
  const task = (async () => {
    const encoded = await new Promise<string>((resolve, reject) => { pending.set(block, { resolve, reject }); scope.postMessage({ type: 'need', block }); });
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const decoded = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const normalized = decoded.replace(/\r\n?/g, '\n'); remember(block, normalized); return normalized;
  })();
  inflight.set(block, task);
  try { return await task; } finally { inflight.delete(block); }
}
function pageOf(source: string, page: number) {
  let start = 0, line = 0; const startLine = page * PAGE_LINES;
  while (line < startLine) { const next = source.indexOf('\n', start); if (next < 0) return ''; start = next + 1; line++; }
  let end = start;
  for (let i = 0; i < PAGE_LINES; i++) { const next = source.indexOf('\n', end); if (next < 0) return source.slice(start); end = next + 1; }
  return source.slice(start, end - 1);
}
async function search(id: number, files: FileEntry[], query: string, matchCase: boolean) {
  const generation = ++searchGeneration; const needle = matchCase ? query : query.toLowerCase();
  let count = 0, skipped = 0; let batch: unknown[] = [];
  for (let index = 0; index < files.length; index++) {
    if (generation !== searchGeneration) return;
    const file = files[index]; const ref = file.after?.block ? file.after : file.before;
    if (!ref?.block) { skipped++; continue; }
    const source = await text(ref.block);
    if (generation !== searchGeneration) return;
    const haystack = matchCase ? source : source.toLowerCase();
    let offset = 0, lineStart = 0, line = 1;
    while (needle && (offset = haystack.indexOf(needle, offset)) >= 0) {
      // Keep offsets in the original string; case folding can change string length.
      if (!matchCase && haystack.length !== source.length) break;
      for (;;) { const next = source.indexOf('\n', lineStart); if (next < 0 || next >= offset) break; lineStart = next + 1; line++; }
      let end = source.indexOf('\n', offset); if (end < 0) end = source.length;
      batch.push({ file: file.id, line, side: file.after?.block ? 'after' : 'before', excerpt: source.slice(lineStart, Math.min(end, lineStart + 180)) });
      count++; offset = Math.max(end + 1, offset + needle.length);
      if (count >= 5000) break;
      if (count % 128 === 0) { await new Promise(r => setTimeout(r, 0)); if (generation !== searchGeneration) return; }
    }
    if (!matchCase && haystack.length !== source.length) {
      let n = 0;
      for (const lineText of source.split('\n')) {
        n++; if (lineText.toLowerCase().includes(needle)) { batch.push({ file: file.id, line: n, side: file.after?.block ? 'after' : 'before', excerpt: lineText.slice(0, 180) }); count++; }
        if (count >= 5000) break;
      }
    }
    if (batch.length || index % 20 === 0) { scope.postMessage({ type: 'results', id, results: batch, scanned: index + 1, total: files.length, count }); batch = []; }
    if (count >= 5000) break;
    if (index % 10 === 0) await new Promise(r => setTimeout(r, 0));
  }
  if (generation === searchGeneration) scope.postMessage({ type: 'searchDone', id, count, skipped, truncated: count >= 5000 });
}
scope.onmessage = event => {
  const message = event.data;
  if (message.type === 'block') {
    const request = pending.get(message.block); pending.delete(message.block);
    if (message.error) request?.reject(new Error(message.error)); else request?.resolve(message.data);
    return;
  }
  if (message.type === 'cancel') { searchGeneration++; return; }
  void (async () => {
    if (message.type === 'search') { await search(message.id, message.files, message.query, message.matchCase); return; }
    if (message.type === 'open') {
      const file: FileEntry = message.file;
      const large = Math.max(file.before?.bytes ?? 0, file.after?.bytes ?? 0) > LARGE_FILE;
      if (large) {
        const side = message.side ?? (file.after?.block ? 'after' : 'before');
        const value = await text(file[side as 'before' | 'after']?.block);
        scope.postMessage({ type: 'reply', id: message.id, result: { large: true, side, page: message.page ?? 0, text: pageOf(value, message.page ?? 0), totalLines: value.split('\n').length } });
      } else {
        const [before, after] = await Promise.all([text(file.before?.block), text(file.after?.block)]);
        const changes = file.status !== 'snapshot' ? presentableDiff(before, after, { scanLimit: 2000, timeout: 150 }) : [];
        scope.postMessage({ type: 'reply', id: message.id, result: { large: false, before, after, changes } });
      }
    }
  })().catch(error => scope.postMessage({ type: 'error', id: message.id, message: error.message }));
};
