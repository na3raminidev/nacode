import type { Confidence, Side } from '../relations/model.js';
export type Lens = 'feature' | 'state' | 'contracts' | 'impact' | 'branches' | 'recovery' | 'gates' | 'history' | 'scenarios' | 'components';
export type FactKind = 'state' | 'error' | 'navigation' | 'contract' | 'schema' | 'async' | 'transaction' | 'gate' | 'migration' | 'table' | 'scenario' | 'test' | 'document' | 'component';
export interface Fact { id: number; file: number; line: number; side: Side; symbol?: number; kind: FactKind; label: string; key: string; detail: string; confidence: Confidence; role?: string; fingerprint?: string }
export interface Feature { id: string; label: string; files: number[]; declared: boolean }
export interface HistoryOptions { limit: number; refs: string[] }
export interface HistoryCommit { repo: string; hash: string; date: string; subject: string; files: number[]; refs: string[]; revert?: string; patch?: string; broad: boolean }
export interface HistoryRef { repo: string; name: string; sha: string; commits: number; truncated: boolean }
export interface HistoryData { commits: HistoryCommit[]; refs: HistoryRef[]; notes: string[] }
export interface InsightData { version: 1; limited?: { file: number; side: Side }[]; features: Feature[]; facts: Fact[]; history: HistoryData; notes: string[] }
export interface LensQuery { lens: Lens; feature?: string; text?: string; file?: number; side: Side | 'compare'; probable?: boolean; offset?: number }
export interface LensRow { title: string; detail: string; file?: number; line?: number; side?: Side; confidence?: Confidence; status?: string; symbol?: number; files?: number[]; score?: number }
export interface LensConnection { fromFile: number; toFile: number; kind: string; confidence: Confidence; versions: number }
export interface LensResult { rows: LensRow[]; total: number; files: number[]; connections: LensConnection[]; note: string; partial: boolean }
export const LENSES: { id: Lens; title: string; hint: string }[] = [
  { id: 'feature', title: '01 / Feature journeys', hint: 'Explore one capability across clients and services.' },
  { id: 'state', title: '02 / State & errors', hint: 'Find actions, error codes, navigation and their source evidence.' },
  { id: 'contracts', title: '03 / API contracts', hint: 'Inspect endpoints, DTO fields and before/after changes.' },
  { id: 'impact', title: '04 / Change impact', hint: 'Follow incoming dependencies from changed files or a selected file.' },
  { id: 'branches', title: '05 / Branch matrix', hint: 'Compare scoped commits in explicitly exported Git refs. Not deployment status.' },
  { id: 'recovery', title: '06 / Recovery & transactions', hint: 'Locate callbacks, schedulers, retries, locks and shared writes.' },
  { id: 'gates', title: '07 / Feature gates', hint: 'Inspect declarations and checks, not effective production values.' },
  { id: 'history', title: '08 / History & hotspots', hint: 'Scoped commit frequency and co-change are not code dependencies.' },
  { id: 'scenarios', title: '09 / Scenarios & tests', hint: 'Connect source, Flow documents and tests. Test presence is not a passing run.' },
  { id: 'components', title: '10 / UI consumers', hint: 'See component declarations, use sites and affected screens.' },
];
