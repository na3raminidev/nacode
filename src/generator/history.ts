import { createHash } from 'node:crypto';
import type { Collection } from './collect.js';
import { git, resolveRef } from './git.js';
import type { HistoryData, HistoryCommit } from '../insights/model.js';
import { redact } from '../insights/extract.js';
export function collectHistory(collection: Collection): HistoryData {
  const result: HistoryData = { commits: [], refs: [], notes: [] }, options = collection.history;
  if (!options) { result.notes.push('History disabled. Export with --history and optional --history-refs main,feature.'); return result; }
  const roots = new Map<string, { root: string; paths: Map<string, number>; ref: string }>();
  for (const [id, f] of collection.files.entries()) {
    const repo = f.repo ?? 'root'; if (!roots.has(repo)) roots.set(repo, { root: f.after?.root ?? f.before?.root ?? collection.root, paths: new Map(), ref: collection.historyBase?.[repo] ?? 'HEAD' });
    roots.get(repo)!.paths.set(f.localPath ?? f.path, id);
    if (f.oldPath) roots.get(repo)!.paths.set(f.repo && f.oldPath.startsWith(f.repo + '/') ? f.oldPath.slice(f.repo.length + 1) : f.oldPath, id);
  }
  const commits = new Map<string, HistoryCommit>(); let fingerprints = 0;
  const read = (root: string, args: string[]) => git(root, args, { maxBuffer: 32 * 1024 * 1024, timeout: 15000 }).toString('utf8');
  for (const [repo, { root, paths: localPaths, ref: base }] of roots) {
    let prefix = ''; try { prefix = read(root, ['rev-parse', '--show-prefix']).replace(/[\r\n]+$/, ''); } catch {}
    const paths = new Map([...localPaths].map(([p, id]) => [prefix + p, id]));
    for (const ref of [...new Set([base, ...options.refs])].slice(0, 8)) {
      try {
        let refFingerprints = 0; const sha = resolveRef(root, ref), shallow = read(root, ['rev-parse', '--is-shallow-repository']).trim() === 'true';
        if (shallow) result.notes.push(`${repo}: shallow history; ancestry outside this checkout is unknown.`);
        const chunks = read(root, ['log', sha, '--no-merges', `--max-count=${options.limit + 1}`, '--no-renames', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--format=%x1e%H%x00%cI%x00%s%x00%b%x00', '--']).split('\x1e').slice(1);
        result.refs.push({ repo, name: ref, sha, commits: Math.min(chunks.length, options.limit), truncated: chunks.length > options.limit });
        for (const chunk of chunks.slice(0, options.limit)) {
          const [hash, date, subject, body, ...rawPaths] = chunk.split('\0'); if (!/^[a-f0-9]{40,64}$/.test(hash)) continue;
          let firstPath = true;
          const names = rawPaths.filter(Boolean).map(p => { if (!firstPath) return p; firstPath = false; return p.replace(/^\n/, ''); }).filter(Boolean), files = [...new Set(names.map(p => paths.get(p)).filter((id): id is number => id !== undefined))];
          if (!files.length) continue;
          const key = `${repo}:${hash}`, old = commits.get(key); if (old) { old.refs.push(ref); continue; }
          const commit: HistoryCommit = { repo, hash, date, subject: redact(subject), files, refs: [ref], broad: names.length > 50, revert: body.match(/This reverts commit ([a-f0-9]{40,64})/)?.[1] };
          // Fingerprint only small, wholly included patches. No excluded content enters the export.
          if (fingerprints < 100 && refFingerprints < 16 && names.length <= 30 && names.every(n => paths.has(n))) {
            fingerprints++; refFingerprints++;
            try {
              const diff = read(root, ['show', hash, '--format=', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=0', '--']);
              if (diff.length < 1024 * 1024) {
                const normalized = diff.split('\n').filter(l => !/^(index |@@|\\ No newline)/.test(l)).map(l => l.replace(/\s+/g, ' ').trim()).join('\n');
                commit.patch = createHash('sha256').update(normalized).digest('hex');
              }
            } catch { /* Patch equivalence is optional; ancestry evidence remains available. */ }
          }
          commits.set(key, commit);
        }
      } catch { result.notes.push(`${repo}/${ref}: history unavailable, invalid ref, timeout or output budget exceeded; not a claim of absence.`); }
    }
  }
  result.commits = [...commits.values()].sort((a, b) => b.date.localeCompare(a.date) || a.hash.localeCompare(b.hash));
  result.notes.push('Local pinned refs only; no fetch, checkout or deployment inspection. Counts are bounded non-merge commit touches, not bug counts.');
  result.notes.push('Patch equivalence is a normalized-diff candidate for at most 100 small included commits; squash equivalence is unknown.');
  return result;
}

