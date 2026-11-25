import type { Manifest } from '../../model.js';
import type { Side } from '../../relations/model.js';
import type { MapRelation } from './routes.js';

export interface Connection extends MapRelation {
  source: string; target: string; side: Side | 'compare';
  reason?: string; condition?: string;
  evidence?: { file: number; line: number; side: Side }[];
  continueFromTarget?: () => void;
}

const $ = (id: string) => document.getElementById(id)!;
function text<K extends keyof HTMLElementTagNameMap>(tag: K, value: string, className = '') {
  const element = document.createElement(tag); element.textContent = value; element.className = className; return element;
}
function button(label: string, action: () => void, className = 'connection-action') {
  const el = text('button', label, className); el.type = 'button'; el.onclick = action; return el;
}

export class ConnectionCard {
  private panel = $('connection-card');
  private body = $('connection-body');
  private trigger = $('connection-list-open');
  private closeButton = $('connection-close');
  private origin?: HTMLElement;
  private edges = new Map<number, Connection>();
  private mapIds: number[] = [];
  constructor(private manifest: Manifest, private options: {
    highlight: (ids: number[], guideId?: number) => void;
    open: (file: number, line: number, side: Side) => void;
    focus: (file: number) => void;
  }) {
    this.trigger.onclick = () => this.panel.hidden ? this.browse() : this.close();
    this.closeButton.onclick = () => this.close();
  }
  browse() { this.list(this.mapIds); }
  set(edges: Connection[], mapIds: number[]) {
    this.mapIds = mapIds;
    this.edges = new Map(edges.map(edge => [edge.id, edge]));
    this.trigger.hidden = !mapIds.length;
    if (mapIds.length) this.trigger.textContent = `Map links (${mapIds.length})`;
    this.close();
  }
  close(restore = true) {
    if (this.panel.hidden) return false;
    const restoreFocus = restore && this.panel.contains(document.activeElement);
    this.panel.hidden = true; this.body.replaceChildren(); this.trigger.setAttribute('aria-expanded', 'false');
    this.options.highlight([]);
    if (restoreFocus) {
      const target = this.origin?.isConnected && !this.origin.closest('[hidden]') ? this.origin : this.trigger.hidden ? $('city-canvas') : this.trigger;
      target.focus({ preventScroll: true });
    }
    this.origin = undefined;
    return true;
  }
  updateMap(visible: boolean, width: number, focusX?: number) {
    if (this.panel.hidden) return;
    const offset = this.panel.classList.contains('away-from-right') ? .58 : .63;
    this.panel.classList.toggle('away-from-right', focusX !== undefined && focusX > width * offset);
    this.setGuide(visible);
  }
  private setGuide(visible: boolean) {
    const note = this.body.querySelector('#connection-guide'); if (!note) return;
    const message = visible ? 'Dotted blue arc: visual guide only, not an execution path.' : 'The direct guide appears when both file endpoints are in view.';
    if (note.textContent !== message) note.textContent = message;
  }
  inspectHit(ids: number[], count: number) {
    if (count > 1 || ids.length > 1) this.list(ids, count);
    else if (ids[0] !== undefined) this.inspect(ids[0]);
  }
  private show(title: string, ids: number[], guideId?: number) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && !this.panel.contains(active)) this.origin = active;
    this.panel.hidden = false; this.trigger.setAttribute('aria-expanded', 'true');
    $('connection-title').textContent = title; this.body.replaceChildren(); this.body.scrollTop = 0;
    this.options.highlight(ids, guideId); this.closeButton.focus({ preventScroll: true });
  }
  private status(edge: Connection) {
    const diff = this.manifest.mode !== 'diff' ? 'Snapshot' : edge.versions === 3 ? 'Unchanged' : edge.evidence || edge.side === 'compare' ? (edge.versions === 1 ? 'Removed' : 'Added') : undefined;
    const side = edge.side === 'compare' ? (edge.versions === 1 ? 'Before' : edge.versions === 2 ? 'After' : 'Before + after') : edge.side === 'before' ? 'Before' : 'After';
    return `${edge.kind} / ${edge.confidence} / ${side}${diff ? ` / ${diff}` : ''}`;
  }
  private list(ids: number[], count?: number) {
    const members = ids.flatMap(id => this.edges.get(id) ?? []); if (!members.length) return;
    this.show(count === undefined ? 'Map connections' : `${count} grouped connections`, count === undefined ? [] : ids);
    if (count === undefined) this.body.append(text('p', 'Projected links, including endpoints outside the current view.', 'connection-note'));
    else if (count > members.length) this.body.append(text('p', `Only ${members.length} ${members.length === 1 ? 'member is' : 'members are'} inspectable. Overview records do not export every link in the count.`, 'connection-note'));
    else this.body.append(text('p', 'These connections share the same map path at this zoom. Choose a member to inspect it.', 'connection-note'));
    for (const edge of members) {
      const row = button('', () => this.inspect(edge.id, () => this.list(ids, count)), 'connection-member');
      row.append(text('strong', `${edge.source} \u2192 ${edge.target}`), text('small', this.status(edge) + (edge.count && edge.count > 1 ? ` / ${edge.count} represented` : ''))); this.body.append(row);
    }
  }
  inspect(id: number, back?: () => void) {
    const edge = this.edges.get(id); if (!edge) return;
    const mapped = this.mapIds.includes(id);
    this.show('Connection details', mapped ? [id] : [], mapped ? id : undefined);
    if (back) this.body.append(button('Back to links', back, 'connection-back'));
    this.body.append(text('p', this.status(edge), 'connection-meta'));
    const endpoints = text('dl', '', 'connection-endpoints');
    for (const [label, name, file] of [['From', edge.source, edge.fromFile], ['To', edge.target, edge.toFile]] as const) {
      const item = text('div', ''); const value = text('dd', name);
      const path = this.manifest.files[file]?.path;
      if (path && path !== name) value.append(text('small', path));
      item.append(text('dt', label), value); endpoints.append(item);
    }
    this.body.append(endpoints);
    if (edge.reason) this.body.append(text('p', edge.reason));
    if (edge.condition) this.body.append(text('p', `Condition: ${edge.condition}`));
    if (edge.count && edge.count > 1) this.body.append(text('p', `Evidence for this representative only, not all ${edge.count} links.`, 'connection-note'));
    if (!edge.evidence?.length) this.body.append(text('p', 'File-level connection. No exact source line is available; this is not an execution trace.', 'connection-note'));
    if (edge.fromFile !== edge.toFile && this.manifest.files[edge.fromFile] && this.manifest.files[edge.toFile] && mapped) {
      const guide = text('p', '', 'connection-note'); guide.id = 'connection-guide'; this.body.append(guide); this.setGuide(false);
    }
    const actions = text('div', '', 'connection-actions');
    const open = (file: number, line: number, side: Side) => {
      if (matchMedia('(max-width:760px)').matches) this.close(false);
      this.options.open(file, line, side);
    };
    for (const evidence of edge.evidence ?? []) {
      const version = evidence.side === 'before' ? 'Before' : 'After';
      const label = edge.evidence!.length > 1 ? `Open ${version.toLowerCase()} evidence` : 'Open source evidence';
      this.body.append(text('p', `${this.manifest.files[evidence.file].path}:${evidence.line} (${version})`, 'connection-location'));
      actions.append(button(label, () => open(evidence.file, evidence.line, evidence.side)));
    }
    if (!edge.evidence?.length) for (const [label, file] of [['Open source file', edge.fromFile], ['Open destination file', edge.toFile]] as const) {
      const info = this.manifest.files[file]; if (!info) continue;
      const side = (edge.side === 'before' || edge.versions === 1) && info.before ? 'before' : info.after ? 'after' : 'before';
      actions.append(button(label, () => open(file, 1, side)));
    }
    if (this.manifest.files[edge.toFile]) actions.append(button('Focus destination on map', () => this.options.focus(edge.toFile)));
    if (edge.continueFromTarget) actions.append(button('Continue from destination', edge.continueFromTarget));
    this.body.append(actions);
  }
}
