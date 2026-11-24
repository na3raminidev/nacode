import { workspace } from './generator/workspace.js';
import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import path from 'node:path';
import { comparison, snapshot, type Options } from './generator/collect.js';
import { exportHTML } from './generator/export.js';
import { formatBytes } from './model.js';
const program = new Command().name('graphicode').description('Generate one offline HTML code explorer. Node.js 22+; Git required only for diffs.').version('0.1.0');
function common(command: Command) {
  return command.option('-o, --out <file>', 'output HTML file', 'output/codebase.html')
    .option('--include <glob>', 'include matching paths (repeatable)', (v: string, all: string[]) => [...all, v], [])
    .option('--exclude <glob>', 'exclude matching paths (repeatable)', (v: string, all: string[]) => [...all, v], [])
    .option('--include-sensitive', 'include sensitive filenames (source may contain secrets)')
    .option('--include-generated', 'include generated and dependency directories')
    .option('--no-ignore', 'do not apply .gitignore rules to snapshots or untracked files')
    .option('--dry-run', 'show scope and exclusions without writing HTML')
    .option('--allow-large', 'allow more than 20,000 files or 100 MiB of source')
    .option('--relationships <mode>', 'relationship analysis: auto or off', 'auto')
    .option('--force', 'replace an existing output HTML');
}
async function run(mode: 'snapshot' | 'diff' | 'workspace', folder: string, opts: Options & { dryRun?: boolean; allowLarge?: boolean; force?: boolean }) {
  if (!['auto', 'off'].includes(opts.relationships ?? 'auto')) throw new Error('--relationships must be auto or off');
  if (mode === 'diff') {
    if (opts.workingTree ? opts.base || opts.head : !opts.base || !opts.head) throw new Error('Use either --working-tree or both --base <ref> --head <ref>.');
    if (opts.includeUntracked && !opts.workingTree) throw new Error('--include-untracked requires --working-tree.');
  }
  const data = mode === 'workspace' ? await workspace(folder, opts) : mode === 'snapshot' ? await snapshot(folder, opts) : await comparison(folder, opts);
  const outputMode = mode === 'workspace' ? data.comparison ? 'diff' : 'snapshot' : mode;
  const bytes = data.files.reduce((sum, f) => sum + (f.before?.size ?? 0) + (f.after?.size ?? 0), 0);
  console.log(`${data.files.length.toLocaleString()} files | ${formatBytes(bytes)} source${data.comparison ? ` | ${data.comparison}` : ''}`);
  for (const [reason, count] of Object.entries(data.exclusions)) console.log(`Excluded: ${count} entries - ${reason}`);
  console.log('Privacy: source is embedded. Filename filters are not a secret scanner; review before sharing.');
  if (opts.dryRun) return;
  if ((data.files.length > 20_000 || bytes > 100 * 1024 * 1024) && !opts.allowLarge) {
    console.warn('Large export: scope with --include "src/**", export a diff, or use --allow-large.');
    if (!stdin.isTTY) throw new Error('Large export requires --allow-large in non-interactive mode.');
    const prompt = createInterface({ input: stdin, output: stdout });
    try { if ((await prompt.question('Continue with the full export? [y/N] ')).toLowerCase() !== 'y') return; }
    finally { prompt.close(); }
  }
  const started = performance.now();
  await exportHTML(data, opts.out, outputMode, opts.force);
  console.log(`Created ${path.resolve(opts.out)} in ${((performance.now() - started) / 1000).toFixed(2)}s`);
}
common(program.command('snapshot').argument('<folder>', 'local codebase folder')).action((folder, opts) => run('snapshot', folder, opts));
common(program.command('diff').argument('<repo>', 'local Git repository'))
  .option('--base <ref>', 'before commit or branch').option('--head <ref>', 'after commit or branch')
  .option('--working-tree', 'compare HEAD to current tracked working files')
  .option('--include-untracked', 'include untracked working files')
  .action((folder, opts) => run('diff', folder, opts));
common(program.command('workspace').argument('<config>', 'local JSON workspace configuration')).action((config, opts) => run('workspace', config, opts));
program.parseAsync().catch(error => { console.error(`Error: ${error.message}`); process.exitCode = 1; });

