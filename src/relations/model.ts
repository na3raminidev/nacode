export type Side = 'before' | 'after';
export type Confidence = 'resolved' | 'probable' | 'unresolved';
export type RelationKind = 'call' | 'event' | 'http' | 'read' | 'write' | 'async' | 'state' | 'import';
export interface GraphSymbol {
  id: number; key: string; file: number; repo: string; name: string;
  kind: 'function' | 'class' | 'endpoint' | 'table' | 'external' | 'state';
  line: number; beforeLine?: number; endLine: number; versions: number;
}
export interface Relation {
  from: number; to: number; kind: RelationKind; confidence: Confidence; versions: number;
  file: number; line: number; beforeLine?: number; reason: string; condition?: string;
}
export interface Coverage { file: number; side: Side; language: string; status: 'parsed' | 'partial' | 'unsupported' | 'skipped'; notes: string[] }
export interface RelationGraph { version: 1; symbols: GraphSymbol[]; edges: Relation[]; coverage: Coverage[] }
export interface RepositoryInfo { id: string; service?: string; comparison?: string }
export interface ServiceBinding { from: string; client?: string; service: string; baseUrl?: string }
export interface ContractSpec { repo: string; path: string; service: string }
export interface AnalysisConfig { repositories?: RepositoryInfo[]; bindings?: ServiceBinding[]; contracts?: ContractSpec[] }
export interface AnalysisFile { file: number; repo: string; path: string; identityPath: string; text: string; side: Side; skipReason?: string }
export interface CallSite { name: string; receiver: string; line: number; start: number; argc: number; condition?: string; http?: { method: string; path: string }; eventTarget?: string; kind?: RelationKind }
export interface Declaration {
  local: string; name: string; owner: string; kind: 'class' | 'function' | 'state'; start: number; end: number;
  line: number; endLine: number; arity: number; types: Record<string, string>; bases: string[];
  annotations: string; calls: CallSite[]; eventParent?: string; eventKind?: RelationKind;
}
export interface ParsedFile { language: string; declarations: Declaration[]; packageName: string; imports: string[]; notes: string[] }
export interface GraphQuery { mode: 'out' | 'in' | 'path' | 'journey' | 'overview'; start?: number; target?: number; side: Side; probable?: boolean; depth?: number; maxNodes?: number; maxEdges?: number; deadlineMs?: number }
export interface GraphResult { edges: number[]; paths: number[][]; truncated: boolean; visited: number; examined: number; reason?: string }
export const sideMask = (side: Side) => side === 'before' ? 1 : 2;

