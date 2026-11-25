import type { Manifest } from '../model.js';
import type { City } from './city/city.js';
import type { Connection } from './city/connection-card.js';
import type { Side } from '../relations/model.js';
import { LENSES, type Feature, type Lens, type LensResult, type LensRow } from '../insights/model.js';
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const element = (tag: string, value: string, cls = '') => { const e = document.createElement(tag); e.textContent = value; e.className = cls; return e; };
export class Insights {
  private ready = false; private id = 0; private offset = 0; private file?: number; private timer?: ReturnType<typeof setTimeout>;
  private result?: LensResult; private lens: Lens = 'feature'; private selected?: LensRow;
  private requestedSide: Connection['side'] = 'after'; private resultSide: Connection['side'] = 'after';
  constructor(private manifest: Manifest, private city: City | undefined, private open: (id: number, line: number, side: Side) => void, private send: (value: unknown) => void) {
    const compact = matchMedia('(max-width:760px)');
    const resize = () => { $<HTMLDetailsElement>('insight-filters').open = !compact.matches; }; resize(); compact.addEventListener('change', resize);
    const modes = $<HTMLSelectElement>('insight-lens'); for (const lens of LENSES) { const option = document.createElement('option'); option.value = lens.id; option.textContent = lens.title; modes.append(option); }
    $('insights-open').onclick = () => { this.toggle(true); if (this.result) this.render(this.result); }; $('insight-close').onclick = () => this.toggle(false);
    $('insight-map-links').onclick = () => this.city?.browseConnections();
    modes.onchange = () => { this.lens = modes.value as Lens; this.offset = 0; this.run(); };
    for (const id of ['insight-feature', 'insight-side', 'insight-probable', 'insight-file-only']) $(id).onchange = () => { this.offset = 0; this.run(); };
    $<HTMLInputElement>('insight-search').oninput = () => { clearTimeout(this.timer); this.timer = setTimeout(() => { this.offset = 0; this.run(); }, 180); };
    $('insight-prev').onclick = () => { this.offset = Math.max(0, this.offset - 100); this.run(); };
    $('insight-next').onclick = () => { this.offset += 100; this.run(); };
    $('insight-cancel').onclick = () => { this.id++; this.send({ type: 'cancel' }); $('insight-status').textContent = 'Cancelled. Previous results retained.'; };
    $('insight-clear').onclick = () => { this.id++; this.send({ type: 'cancel' }); this.result = undefined; this.selected = undefined; $('insight-results').replaceChildren(); $('insight-detail').hidden = true; $('insight-map-links').hidden = true; void city?.setRelations([]).catch(() => {}); void city?.emphasizeFiles().catch(() => {}); $('insight-status').textContent = 'Map focus cleared.'; };
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('insight-panel').hidden) { this.toggle(false); $('insights-open').focus(); } });
    if (manifest.mode !== 'diff') for (const option of $<HTMLSelectElement>('insight-side').options) if (option.value !== 'after') option.disabled = true;
  }
  selectFile(id: number) { this.file = id; $('insight-file-label').textContent = `Only selected file${this.manifest.files[id] ? ': ' + this.manifest.files[id].path.split('/').at(-1) : ''}`; if (!$('insight-panel').hidden && $<HTMLInputElement>('insight-file-only').checked) { this.offset = 0; this.run(); } }
  private toggle(open: boolean) { $('insight-panel').hidden = !open; $('insights-open').setAttribute('aria-expanded', String(open)); if (open) { $('journey-panel').hidden = true; $('journeys-open').setAttribute('aria-expanded', 'false'); if (!this.result) this.run(); } }
  receive(message: any): boolean {
    if (message.type === 'insights-ready') {
      this.ready = true; $('insight-panel').dataset.ready = 'true';
      const select = $<HTMLSelectElement>('insight-feature'); for (const f of (message.features as Feature[]).slice(0, 1000)) { const option = document.createElement('option'); option.value = f.id; option.textContent = `${f.label} / ${f.files.length} files${f.declared ? '' : ' (inferred)'}`; select.append(option); }
      $('insight-status').textContent = `${message.facts.toLocaleString()} evidence records / ${message.features.length} capabilities${message.features.length > 1000 ? ' (first 1000 in selector; search all files below)' : ''}.`;
      if (!$('insight-panel').hidden) this.run(); return true;
    }
    if (message.type === 'insight-result') { if (message.id === this.id) { this.resultSide = this.requestedSide; if ($('insight-panel').hidden) this.result = message.result; else this.render(message.result); } return true; }
    if (message.type === 'insight-error') { if (message.id === this.id) $('insight-status').textContent = message.message; return true; }
    return false;
  }
  private run() {
    $('insight-panel').scrollTop = 0;
    $('insight-hint').textContent = LENSES.find(l => l.id === this.lens)!.hint;
    if (!this.ready) { $('insight-status').textContent = 'Insights are unavailable or still loading. Regenerate older exports with relationships enabled.'; return; }
    if ($<HTMLInputElement>('insight-file-only').checked && this.file === undefined) { $('insight-status').textContent = 'Select a file on the map first, or clear the selected-file filter.'; return; }
    this.send({ type: 'cancel' }); const id = ++this.id; this.requestedSide = $<HTMLSelectElement>('insight-side').value as Connection['side'];
    this.send({ type: 'insight-query', id, query: { lens: this.lens, feature: $<HTMLSelectElement>('insight-feature').value || undefined, text: $<HTMLInputElement>('insight-search').value, file: $<HTMLInputElement>('insight-file-only').checked ? this.file : undefined, side: this.requestedSide, probable: $<HTMLInputElement>('insight-probable').checked, offset: this.offset } });
    $('insight-status').textContent = 'Inspecting bounded evidence in the graph worker...';
  }
  private render(result: LensResult) {
    $('insight-filters').querySelector('summary')!.textContent = $<HTMLSelectElement>('insight-feature').value || $<HTMLInputElement>('insight-file-only').checked || $<HTMLInputElement>('insight-search').value ? 'Scope & filters (active)' : 'Scope & filters';
    this.result = result; $('insight-detail').hidden = true; const list = $('insight-results'); list.replaceChildren();
    $('insight-status').textContent = `${this.offset + (result.rows.length ? 1 : 0)}-${this.offset + result.rows.length} / ${result.total}${result.partial ? '+' : ''} records.${result.partial ? ' Partial result; limits reached.' : ''}`;
    $('insight-notes').textContent = result.note;
    $<HTMLButtonElement>('insight-prev').disabled = this.offset === 0; $<HTMLButtonElement>('insight-next').disabled = this.offset + result.rows.length >= result.total;
    for (const row of result.rows) {
      const button = element('button', '', 'insight-card'); button.append(element('small', [row.status, row.side, row.confidence].filter(Boolean).join(' / ') || 'SOURCE EVIDENCE'), element('strong', row.title), element('span', row.detail));
      if (row.file !== undefined) button.append(element('small', `${this.manifest.files[row.file]?.path ?? ''}:${row.line ?? 1}`));
      button.onclick = () => this.detail(row); list.append(button);
    }
    if (!result.rows.length) list.append(element('p', 'No matching evidence in this exported scope. Try another capability or clear the file/text filter.', 'muted'));
    const links = new Map<string, Connection>();
    for (const edge of result.connections) {
      const key = `${edge.fromFile}:${edge.toFile}:${edge.kind}:${edge.confidence}`;
      const link = links.get(key);
      if (link) link.versions |= edge.versions;
      else links.set(key, { ...edge, id: -100000 - links.size, side: this.resultSide, source: this.manifest.files[edge.fromFile]?.path ?? 'External source', target: this.manifest.files[edge.toFile]?.path ?? 'External destination' });
    }
    void this.city?.setRelations([...links.values()], this.resultSide === 'compare').catch(() => {});
    $('insight-map-links').hidden = !this.city || !result.connections.length;
    void this.city?.emphasizeFiles(result.files.length ? result.files : undefined).catch(() => {});
    $('insight-map-note').textContent = `${links.size} map links (max 200). Page focus. Dashed: uncertain or removed.`;
  }
  private detail(row: LensRow) {
    this.selected = row; const detail = $('insight-detail'); detail.hidden = false; detail.replaceChildren(element('strong', row.title), element('p', row.detail));
    if (row.file !== undefined) {
      const historical = ['commit', 'revert', 'hotspot', 'co-change', 'observed commit'].includes(row.status ?? '');
      if (historical) detail.append(element('p', 'Opens the exported file version, not the historical commit contents.'));
      const open = element('button', historical ? 'Open exported file' : row.line === undefined ? 'Open source file' : 'Open source evidence', 'journey-path'); open.onclick = () => { this.open(row.file!, row.line ?? 1, row.side ?? (this.manifest.files[row.file!].after ? 'after' : 'before')); if (matchMedia('(max-width:760px)').matches) this.toggle(false); }; detail.append(open);
      const focus = element('button', 'Focus this file', 'journey-path'); focus.onclick = () => { void this.city?.selectFile(row.file!, true).catch(() => {}); }; detail.append(focus);
    }
    if (row.symbol !== undefined) { const trace = element('button', 'Trace symbol journey', 'journey-path'); trace.onclick = () => { this.toggle(false); this.send({ type: 'symbol', id: row.symbol, side: row.side }); }; detail.append(trace); }
    if (row.files?.length) { const focus = element('button', `Focus ${row.files.length} files`, 'journey-path'); focus.onclick = () => { void this.city?.emphasizeFiles(row.files).catch(() => {}); this.city?.fit(); }; detail.append(focus); }
    detail.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth' });
  }
}
