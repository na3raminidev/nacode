import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
const safeConfigByRoot = new Map<string, string[]>();
function safeConfig(root: string): string[] {
  const cached = safeConfigByRoot.get(root);
  if (cached) return cached;
  const settings = ['-c', 'core.fsmonitor=false'];
  try {
    const keys = execFileSync('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], { cwd: root, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    for (const key of keys.split('\0').filter(Boolean)) settings.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
  }
  safeConfigByRoot.set(root, settings);
  return settings;
}
export function git(root: string, args: string[]): Buffer {
  return execFileSync('git', ['--no-pager', '-c', 'core.quotePath=false', ...safeConfig(root), ...args], {
    cwd: root, maxBuffer: 512 * 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
export function resolveRef(root: string, ref: string): string {
  return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim();
}
// A persistent process avoids launching Git once per file.
export class GitObjects {
  private process: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private wake?: () => void;
  private error?: Error;
  constructor(root: string) {
    this.process = spawn('git', ['cat-file', '--batch'], { cwd: root, windowsHide: true });
    this.process.stdout.on('data', (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.wake?.(); });
    this.process.stderr.resume();
    this.process.stdin.on('error', e => { this.error = e; this.wake?.(); });
    this.process.on('error', e => { this.error = e; this.wake?.(); });
    this.process.on('close', () => { this.error ??= new Error('Git object reader closed'); this.wake?.(); });
  }
  private async until(test: () => boolean) {
    while (!test()) {
      if (this.error) throw this.error;
      await new Promise<void>(resolve => { this.wake = resolve; }); this.wake = undefined;
    }
  }
  async read(oid: string): Promise<Buffer> {
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error('Invalid Git object identifier');
    this.process.stdin.write(`${oid}\n`);
    await this.until(() => this.buffer.includes(10));
    const end = this.buffer.indexOf(10); const header = this.buffer.subarray(0, end).toString();
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Missing Git object: ${oid}`);
    this.buffer = this.buffer.subarray(end + 1);
    await this.until(() => this.buffer.length >= size + 1);
    const result = Buffer.from(this.buffer.subarray(0, size)); this.buffer = this.buffer.subarray(size + 1);
    return result;
  }
  close() { this.process.stdin.end(); }
}

