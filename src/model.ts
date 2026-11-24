import type { AnalysisConfig, RepositoryInfo } from './relations/model.js';
export type Status = 'snapshot' | 'modified' | 'added' | 'deleted' | 'renamed' | 'typechanged';
export type ContentKind = 'text' | 'binary' | 'symlink' | 'submodule' | 'unsupported' | 'unavailable';
export interface ContentRef { block?: string; kind: ContentKind; bytes: number; lines?: number; note?: string }
export interface FileEntry {
  id: number; repo?: string; path: string; oldPath?: string; status: Status; before?: ContentRef; after?: ContentRef;
  additions: number; deletions: number;
}
export interface Manifest {
  version: 1 | 2; name: string; mode: 'snapshot' | 'diff'; created: string; comparison?: string;
  repositories?: RepositoryInfo[]; context?: boolean; relationships?: { blocks: string[]; symbols: number; edges: number; config?: AnalysisConfig };
  files: FileEntry[]; exclusions: Record<string, number>; totalBytes: number;
}
export const LARGE_FILE = 2 * 1024 * 1024;
export const PAGE_LINES = 2000;
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

