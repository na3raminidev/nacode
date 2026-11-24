import { Journey } from './journey.js';
import { City } from './city/city.js';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, LanguageDescription, foldGutter, bracketMatching } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { search, searchKeymap, openSearchPanel } from '@codemirror/search';
import { Change, MergeView, unifiedMergeView, goToNextChunk, goToPreviousChunk } from '@codemirror/merge';
import { formatBytes, LARGE_FILE, PAGE_LINES, type FileEntry, type Manifest } from '../model.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const manifest: Manifest = JSON.parse($('manifest').textContent!);
if (manifest.version !== 1 && manifest.version !== 2) throw new Error('Unsupported export version');
const files = manifest.files;
const fileByPath = new Map(files.map(file => [file.path, file]));
const input = (id: string) => $<HTMLInputElement>(id);
const button = (id: string) => $<HTMLButtonElement>(id);
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element;
}
function show(id: string, visible: boolean) { $(id).hidden = !visible; }
let toastTimer: ReturnType<typeof setTimeout>;
function toast(message: string) { $('toast').textContent = message; show('toast', true); clearTimeout(toastTimer); toastTimer = setTimeout(() => show('toast', false), 4500); }
let theme = 'light';
try { theme = localStorage.getItem('graphicode-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch {}
document.documentElement.dataset.theme = theme;
const workerURL = URL.createObjectURL(new Blob([Uint8Array.from(atob($('worker-source').textContent!), c => c.charCodeAt(0))], { type: 'text/javascript' }));
const worker = new Worker(workerURL); URL.revokeObjectURL(workerURL);
let requestId = 0;
const requests = new Map<number, { resolve: (result: OpenResult) => void; reject: (error: Error) => void }>();
type OpenResult = { large: boolean; before: string; after: string; changes: { fromA: number; toA: number; fromB: number; toB: number }[]; text: string; page: number; totalLines: number; side: 'before' | 'after' };
function request(file: FileEntry, page = 0, side?: string): Promise<OpenResult> {
  const id = ++requestId;
  return new Promise((resolve, reject) => { requests.set(id, { resolve, reject }); worker.postMessage({ type: 'open', id, file, page, side }); });
}
let searchId = 0, searchResults: { file: number; line: number; side: string; excerpt: string }[] = [];
worker.onmessage = event => {
  const message = event.data;
  if (message.type === 'need') {
    const block = $(message.block);
    worker.postMessage({ type: 'block', block: message.block, data: block?.textContent ?? '', error: block ? undefined : 'Missing embedded content' });
  } else if (message.type === 'reply') { requests.get(message.id)?.resolve(message.result); requests.delete(message.id); }
  else if (message.type === 'error') {
    requests.get(message.id)?.reject(new Error(message.message)); requests.delete(message.id);
    if (message.id === searchId) $('search-status').textContent = `Search failed: ${message.message}`;
  } else if (message.id === searchId && message.type === 'results') {
    searchResults.push(...message.results); renderSearch();
    $('search-status').textContent = `${message.count} matches / ${message.scanned} of ${message.total} files scanned`;
  } else if (message.id === searchId && message.type === 'searchDone') {
    $('search-status').textContent = `${message.count}${message.truncated ? '+ (limit reached; narrow your query)' : ''} matching lines${message.skipped ? ` / ${message.skipped} non-text files skipped` : ''}`;
  }
};
worker.onerror = event => { toast(`Background worker unavailable: ${event.message}`); for (const pending of requests.values()) pending.reject(new Error('Worker unavailable')); requests.clear(); };
$('project-name').textContent = manifest.name; $('tree-root').textContent = manifest.name;
$('mode-badge').textContent = manifest.mode === 'diff' ? 'DIFF REVIEW' : 'CODE EXPLORER';
$('file-count').textContent = files.length.toLocaleString();
$('status-left').textContent = manifest.comparison ?? `${files.length.toLocaleString()} files / ${formatBytes(manifest.totalBytes)}`;
document.title = `${manifest.name} | graphiCode`;
interface TreeNode { name: string; path: string; children: TreeNode[]; directories: Map<string, TreeNode>; file?: FileEntry; bytes: number; changes: number; count: number }
const root: TreeNode = { name: manifest.name, path: '', children: [], directories: new Map(), bytes: 0, changes: 0, count: 0 };
const directories = new Map<string, TreeNode>([['', root]]);
for (const file of files) {
  const parts = file.path.split('/'); let parent = root; const bytes = file.after?.bytes ?? file.before?.bytes ?? 0;
  const changed = file.additions + file.deletions;
  parent.bytes += bytes; parent.changes += changed; parent.count++;
  for (let i = 0; i < parts.length - 1; i++) {
    let child = parent.directories.get(parts[i]);
    if (!child) { child = { name: parts[i], path: parts.slice(0, i + 1).join('/'), children: [], directories: new Map(), bytes: 0, changes: 0, count: 0 }; parent.directories.set(parts[i], child); parent.children.push(child); directories.set(child.path, child); }
    child.bytes += bytes; child.changes += changed; child.count++; parent = child;
  }
  parent.children.push({ name: parts.at(-1)!, path: file.path, children: [], directories: new Map(), file, bytes, changes: changed, count: 1 });
}
for (const directory of directories.values()) directory.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
const expanded = new Set<string>(['']);
for (const child of root.children) if (!child.file && root.children.length < 20) expanded.add(child.path);
let treeRows: { item: TreeNode; depth: number }[] = []; let treeFocus = 0;
const ROW = 30;
function rebuildTree() {
  const filter = input('file-filter').value.toLowerCase(); treeRows = [];
  if (filter) {
    for (const file of files) if (file.path.toLowerCase().includes(filter)) treeRows.push({ item: { name: file.path, path: file.path, file, children: [], directories: new Map(), bytes: 0, changes: 0, count: 1 }, depth: 0 });
  } else {
    const pending = [...root.children].reverse().map(item => ({ item, depth: 0 }));
    while (pending.length) { const row = pending.pop()!; treeRows.push(row); if (!row.item.file && expanded.has(row.item.path)) for (let i = row.item.children.length - 1; i >= 0; i--) pending.push({ item: row.item.children[i], depth: row.depth + 1 }); }
  }
  treeFocus = Math.max(0, Math.min(treeFocus, treeRows.length - 1));
  $('tree-spacer').style.height = `${treeRows.length * ROW}px`; renderTree();
}
let current: FileEntry | undefined;
function renderTree() {
  const tree = $('tree'); const start = Math.max(0, Math.floor(tree.scrollTop / ROW) - 6);
  const end = Math.min(treeRows.length, start + Math.ceil(tree.clientHeight / ROW) + 14);
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i++) {
    const { item, depth } = treeRows[i]; const row = node('button', `tree-row${current?.path === item.path ? ' selected' : ''}${i === treeFocus ? ' keyboard-focus' : ''}`);
    row.id = `tree-item-${i}`; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(current?.path === item.path)); row.tabIndex = -1;
    if (!item.file) row.setAttribute('aria-expanded', String(expanded.has(item.path)));
    row.style.top = `${i * ROW}px`; row.style.paddingLeft = `${14 + Math.min(depth, 16) * 14}px`; row.title = item.path;
    row.append(node('span', `file-icon ${item.file ? extensionClass(item.path) : 'folder-icon'}`, item.file ? extensionGlyph(item.path) : expanded.has(item.path) ? '\u2304' : '\u203a'), node('span', 'tree-name', item.name));
    if (item.file && item.file.status !== 'snapshot') row.append(node('span', `file-status ${item.file.status}`, statusLetter(item.file.status)));
    else if (!item.file) row.append(node('span', 'folder-count', String(item.count)));
    row.onclick = () => { treeFocus = i; if (item.file) void openFile(item.file); else { if (!expanded.delete(item.path)) expanded.add(item.path); rebuildTree(); } };
    fragment.append(row);
  }
  $('tree-rows').replaceChildren(fragment); tree.setAttribute('aria-activedescendant', `tree-item-${treeFocus}`);
}
function statusLetter(status: string) { return ({ modified: 'M', added: 'A', deleted: 'D', renamed: 'R', typechanged: 'T' } as Record<string, string>)[status] ?? ''; }
function extensionClass(name: string) { const ext = name.split('.').pop()?.toLowerCase(); return ['ts', 'tsx', 'js', 'jsx'].includes(ext!) ? 'web' : ['kt', 'kts', 'java'].includes(ext!) ? 'android' : ['json', 'yaml', 'yml', 'toml'].includes(ext!) ? 'config' : 'generic'; }
function extensionGlyph(name: string) { const ext = name.split('.').pop()?.toLowerCase(); return ({ ts: 'TS', tsx: 'TS', js: 'JS', jsx: 'JS', kt: 'Kt', kts: 'Kt', java: 'Jv', py: 'Py', rs: 'Rs', go: 'Go', json: '{}', md: 'M', css: '#', html: '<>' } as Record<string, string>)[ext!] ?? '\u00b7'; }
$('tree').onscroll = renderTree; new ResizeObserver(renderTree).observe($('tree'));
input('file-filter').oninput = () => { $('tree').scrollTop = 0; rebuildTree(); };
$('tree').onkeydown = event => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const selected = treeRows[treeFocus]; if (!selected) return;
  if (event.key === 'ArrowDown') treeFocus = Math.min(treeRows.length - 1, treeFocus + 1);
  if (event.key === 'ArrowUp') treeFocus = Math.max(0, treeFocus - 1);
  if (event.key === 'Home') treeFocus = 0;
  if (event.key === 'End') treeFocus = treeRows.length - 1;
  if (event.key === 'ArrowRight' && !selected.item.file) expanded.add(selected.item.path);
  if (event.key === 'ArrowLeft') { if (!expanded.delete(selected.item.path)) { const parent = selected.item.path.split('/').slice(0, -1).join('/'); const index = treeRows.findIndex(row => row.item.path === parent); if (index >= 0) treeFocus = index; } }
  if (event.key === 'Enter') { if (selected.item.file) void openFile(selected.item.file); else if (!expanded.delete(selected.item.path)) expanded.add(selected.item.path); }
  rebuildTree(); const top = treeFocus * ROW; const tree = $('tree');
  if (top < tree.scrollTop) tree.scrollTop = top;
  if (top + ROW > tree.scrollTop + tree.clientHeight) tree.scrollTop = top + ROW - tree.clientHeight;
  renderTree();
};
let city: City | undefined; let journey: Journey | undefined;
let inspectorOpen = false, readerExpanded = false;
let activeView: 'files' | 'search' | 'map' = 'map';
function syncWorkspace() {
  show('reader', inspectorOpen); show('code-panel', inspectorOpen && !!current);
  show('map-view', !readerExpanded); $('main').classList.toggle('reader-expanded', readerExpanded);
  $('main').classList.toggle('inspector-open', inspectorOpen);
  $('reader-expand').textContent = readerExpanded ? 'Return to city' : 'Expand reader';
  requestAnimationFrame(() => city?.resize());
}
function navigate(view: typeof activeView) {
  activeView = view;
  for (const name of ['files', 'search', 'map'] as const) {
    show(`${name}-panel`, name === view);
    for (const prefix of ['nav', 'top']) { $(`${prefix}-${name}`).classList.toggle('active', name === view); $(`${prefix}-${name}`).setAttribute('aria-pressed', String(name === view)); }
  }
  $('app').classList.add('navigation-open');
  if (view === 'map') { readerExpanded = false; syncWorkspace(); }
  if (view === 'search') input('search-input').focus();
  requestAnimationFrame(renderTree);
}
function closeInspector() {
  inspectorOpen = false; readerExpanded = false; city?.clearSelection(); syncWorkspace();
  const params = new URLSearchParams(location.hash.slice(1)); for (const key of ['file', 'line', 'side']) params.delete(key);
  history.replaceState(null, '', `#${params}`); $('city-canvas').focus({ preventScroll: true });
}
for (const name of ['files', 'search', 'map'] as const) {
  $(`nav-${name}`).onclick = () => navigate(name);
  $(`top-${name}`).onclick = () => { navigate(name); if (name === 'map') $('app').classList.remove('navigation-open'); };
}
$('menu').onclick = () => $('app').classList.toggle('navigation-open');
$('reader-close').onclick = closeInspector;
$('reader-expand').onclick = () => { readerExpanded = !readerExpanded; syncWorkspace(); };
document.querySelector<HTMLAnchorElement>('.brand')!.onclick = event => { event.preventDefault(); closeInspector(); city?.fit(); };
let tabs: number[] = []; let editor: EditorView | undefined; let merge: MergeView | undefined;
let epoch = 0, renderEpoch = 0; let currentData: OpenResult | undefined;
let layout: 'unified' | 'split' = 'unified'; let largePage = 0, largeSide: 'before' | 'after' = 'after';
function destroyEditor() { merge?.destroy(); if (!merge) editor?.destroy(); merge = undefined; editor = undefined; $('editor').replaceChildren(); }
function renderTabs() {
  $('tabs').replaceChildren();
  for (const id of tabs) {
    const file = files[id]; const wrapper = node('div', `tab${current?.id === id ? ' active' : ''}`);
    const choose = node('button', 'tab-label'); choose.setAttribute('role', 'tab'); choose.setAttribute('aria-selected', String(current?.id === id)); choose.title = file.path;
    choose.append(node('span', `file-icon ${extensionClass(file.path)}`, extensionGlyph(file.path)), node('span', '', file.path.split('/').at(-1)));
    choose.onclick = () => void openFile(file);
    const close = node('button', 'tab-close', '\u00d7'); close.setAttribute('aria-label', `Close ${file.path}`);
    close.onclick = () => {
      const index = tabs.indexOf(id); tabs = tabs.filter(value => value !== id);
      if (current?.id === id) {
        if (tabs.length) void openFile(files[tabs[Math.min(index, tabs.length - 1)]]);
        else { epoch++; renderEpoch++; current = undefined; currentData = undefined; destroyEditor(); closeInspector(); renderTree(); }
      }
      renderTabs();
    };
    wrapper.append(choose, close); $('tabs').append(wrapper);
  }
}
async function openFile(file: FileEntry, line = 1, side?: 'before' | 'after', setHash = true, fly = true) {
  journey?.selectFile(file.id); const token = ++epoch; renderEpoch++; current = file; currentData = undefined;
  if (side === 'before' && manifest.mode === 'diff' && !matchMedia('(max-width: 760px)').matches) {
    layout = 'split'; $('unified').classList.remove('active'); $('split').classList.add('active');
  }
  if (!tabs.includes(file.id)) { tabs.push(file.id); if (tabs.length > 12) tabs.shift(); }
  let parent = file.path.split('/').slice(0, -1);
  while (parent.length) { expanded.add(parent.join('/')); parent.pop(); }
  inspectorOpen = true; syncWorkspace(); if (matchMedia('(max-width: 760px)').matches) $('app').classList.remove('navigation-open'); void city?.selectFile(file.id, fly).catch(() => {}); renderTabs(); rebuildTree();
  const index = treeRows.findIndex(row => row.item.file?.id === file.id);
  if (index >= 0) { treeFocus = index; $('tree').scrollTop = Math.max(0, index * ROW - $('tree').clientHeight / 2); renderTree(); }
  $('breadcrumbs').replaceChildren();
  const parts = file.path.split('/');
  for (let i = 0; i < parts.length; i++) { if (i) $('breadcrumbs').append(node('span', 'crumb-separator', '/')); $('breadcrumbs').append(node('span', i === parts.length - 1 ? 'crumb-current' : '', parts[i])); }
  show('diff-toolbar', manifest.mode === 'diff'); show('pane-labels', false); show('large-controls', false); show('file-notice', false);
  $('change-summary').textContent = `${file.status.toUpperCase()}  +${file.additions}  -${file.deletions}`;
  $('status-right').textContent = `${formatBytes(file.after?.bytes ?? file.before?.bytes ?? 0)} / READ ONLY`;
  destroyEditor(); $('editor').append(node('div', 'loading', 'Opening source...'));
  const large = Math.max(file.before?.bytes ?? 0, file.after?.bytes ?? 0) > LARGE_FILE;
  const sideRef = file[side ?? (file.after?.block ? 'after' : 'before')];
  line = Math.min(Math.max(1, line), sideRef?.lines ?? 1);
  largePage = large ? Math.max(0, Math.floor((line - 1) / PAGE_LINES)) : 0;
  largeSide = side ?? (file.after?.block ? 'after' : 'before');
  if (setHash) { const params = new URLSearchParams(location.hash.slice(1)); params.set('file', file.path); params.set('line', String(line)); params.set('side', largeSide); history.replaceState(null, '', `#${params}`); }
  try {
    const data = await request(file, largePage, largeSide); if (token !== epoch) return;
    currentData = data; await renderEditor(line, side);
  } catch (error) { if (token !== epoch) return; $('editor').replaceChildren(node('div', 'empty-state', `Unable to open source: ${(error as Error).message}`)); }
}
const editorTheme = () => EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--code-bg)', color: 'var(--ink)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: '"Geist Mono", monospace', fontSize: '13px', lineHeight: '1.8' },
  '.cm-content': { padding: '14px 0' }, '.cm-line': { padding: '0 22px' },
  '.cm-gutters': { backgroundColor: 'var(--code-bg)', color: 'var(--soft)', borderRight: '1px solid var(--rule)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px', minWidth: '42px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--hover)' },
  '&.cm-focused': { outline: 'none' }, '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' }, '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '.cm-textfield': { backgroundColor: 'var(--code-bg)', color: 'var(--ink)', border: '1px solid var(--rule)' },
}, { dark: theme === 'dark' });
async function extensions(file: FileEntry, large: boolean): Promise<Extension[]> {
  const extensions: Extension[] = [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({ 'aria-label': `${file.path} source code`, tabindex: '0' }), lineNumbers({ formatNumber: value => String(value + (large ? largePage * PAGE_LINES : 0)) }), highlightActiveLine(), highlightActiveLineGutter(), drawSelection(), search(), keymap.of([...searchKeymap, ...defaultKeymap]), editorTheme()];
  if (!large) {
    extensions.push(foldGutter(), bracketMatching(), syntaxHighlighting(HighlightStyle.define([
      { tag: tags.keyword, color: 'var(--syntax-keyword)' },
      { tag: [tags.string, tags.regexp], color: 'var(--syntax-string)' },
      { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
      { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
      { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syntax-type)' },
      { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--syntax-function)' },
      { tag: [tags.meta, tags.annotation], color: 'var(--syntax-type)' },
      { tag: [tags.tagName, tags.attributeName], color: 'var(--syntax-keyword)' },
      { tag: tags.heading, fontWeight: '600', color: 'var(--syntax-keyword)' },
      { tag: tags.link, textDecoration: 'underline', color: 'var(--syntax-function)' },
    ])));
    const language = LanguageDescription.matchFilename(languages, file.path);
    if (language) { try { extensions.push(await language.load()); } catch { toast('Highlighting unavailable; showing plain text.'); } }
  }
  return extensions;
}
async function renderEditor(line = 1, side?: 'before' | 'after') {
  if (!current || !currentData) return;
  const file = current, data = currentData, token = ++renderEpoch;
  const ext = await extensions(file, data.large); if (token !== renderEpoch) return;
  destroyEditor();
  const ref = file.after ?? file.before;
  let notice = [file.oldPath ? `Renamed from ${file.oldPath}` : '', ref?.note ?? ''].filter(Boolean).join(' / ');
  show('large-controls', data.large);
  if (data.large) {
    notice = `Large file: paged plain text, no inline diff. Find searches this page; Search scans the full current version. ${notice}`;
    $<HTMLSelectElement>('large-side').value = data.side;
    $<HTMLSelectElement>('large-side').options[0].disabled = !file.after?.block;
    $<HTMLSelectElement>('large-side').options[1].disabled = !file.before?.block;
    $('page-label').textContent = `Lines ${data.page * PAGE_LINES + 1}-${Math.min((data.page + 1) * PAGE_LINES, data.totalLines)} of ${data.totalLines}`;
    button('prev-page').disabled = data.page === 0; button('next-page').disabled = (data.page + 1) * PAGE_LINES >= data.totalLines;
    show('diff-toolbar', false); show('pane-labels', false);
    editor = new EditorView({ doc: data.text, extensions: ext, parent: $('editor') });
  } else if (!file.before?.block && !file.after?.block) {
    $('editor').append(node('div', 'empty-state', `${ref?.kind ?? 'Unavailable'} content\n${ref?.note ?? 'No readable source in this entry.'}`));
    show('diff-toolbar', false); show('pane-labels', false);
  } else if (manifest.mode === 'diff' && side === 'before' && matchMedia('(max-width: 760px)').matches) {
    show('pane-labels', false);
    notice = `Before version for this line reference. Select Unified to return to the diff. ${notice}`;
    editor = new EditorView({ doc: data.before, extensions: ext, parent: $('editor') });
  } else if (manifest.mode === 'diff') {
    const changes = data.changes.map(c => new Change(c.fromA, c.toA, c.fromB, c.toB));
    const diffConfig = { override: () => changes };
    const collapseUnchanged = input('context-toggle').checked ? undefined : { margin: 4, minSize: 8 };
    const useSplit = layout === 'split' && !matchMedia('(max-width: 760px)').matches;
    show('pane-labels', useSplit);
    if (useSplit) {
      merge = new MergeView({ a: { doc: data.before, extensions: ext }, b: { doc: data.after, extensions: ext }, parent: $('editor'), diffConfig, collapseUnchanged, gutter: true });
      editor = side === 'before' ? merge.a : merge.b;
      let syncing = false;
      for (const [from, to] of [[merge.a, merge.b], [merge.b, merge.a]]) from.scrollDOM.addEventListener('scroll', () => {
        if (syncing) return; syncing = true; to.scrollDOM.scrollTop = from.scrollDOM.scrollTop; to.scrollDOM.scrollLeft = from.scrollDOM.scrollLeft; requestAnimationFrame(() => { syncing = false; });
      });
    } else {
      editor = new EditorView({ doc: data.after, extensions: [...ext, unifiedMergeView({ original: data.before, diffConfig, collapseUnchanged, mergeControls: false, gutter: true })], parent: $('editor') });
      if (!changes.length) notice = `No text changes (rename, metadata, or line-ending-only change). ${notice}`;
    }
    if ((file.before && file.before.kind !== 'text') || (file.after && file.after.kind !== 'text')) notice = `One version is non-text. ${file.before?.note ?? ''} / ${file.after?.note ?? ''}`;
  } else { show('pane-labels', false); editor = new EditorView({ doc: data.after, extensions: ext, parent: $('editor') }); }
  $('file-notice').textContent = notice; show('file-notice', !!notice);
  if (editor) {
    const target = Math.min(editor.state.doc.lines, Math.max(1, line - (data.large ? data.page * PAGE_LINES : 0)));
    const position = editor.state.doc.line(target).from;
    editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
  }
}
for (const mode of ['unified', 'split'] as const) $(mode).onclick = () => { layout = mode; $('unified').classList.toggle('active', mode === 'unified'); $('split').classList.toggle('active', mode === 'split'); void renderEditor(); };
input('context-toggle').onchange = () => void renderEditor();
$('find-in-file').onclick = () => { if (editor) openSearchPanel(editor); };
$('next-change').onclick = () => { if (editor && !goToNextChunk(editor)) toast('No next change in this file.'); };
$('prev-change').onclick = () => { if (editor && !goToPreviousChunk(editor)) toast('No previous change in this file.'); };
function jump() { if (!current) return; input('line-input').value = ''; $<HTMLDialogElement>('line-dialog').showModal(); input('line-input').focus(); }
$('jump-line').onclick = jump;
$('line-cancel').onclick = () => $<HTMLDialogElement>('line-dialog').close();
$('line-form').onsubmit = event => { event.preventDefault(); const line = Math.max(1, Number(input('line-input').value)); $<HTMLDialogElement>('line-dialog').close(); if (current) void openFile(current, line, largeSide); };
$('prev-page').onclick = () => { if (current) void openFile(current, Math.max(0, largePage - 1) * PAGE_LINES + 1, largeSide); };
$('next-page').onclick = () => { if (current) void openFile(current, (largePage + 1) * PAGE_LINES + 1, largeSide); };
$('large-side').onchange = () => { if (current) void openFile(current, 1, $<HTMLSelectElement>('large-side').value as 'before' | 'after'); };
$('theme').onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = theme; city?.theme(theme === 'dark'); try { localStorage.setItem('graphicode-theme', theme); } catch {} void renderEditor(); };
matchMedia('(max-width: 760px)').addEventListener('change', () => { if (current) void renderEditor(); });
function renderSearch() {
  const container = $('search-results'); const start = Math.max(0, Math.floor(container.scrollTop / 68) - 4); const end = Math.min(searchResults.length, start + Math.ceil(container.clientHeight / 68) + 10);
  const spacer = node('div'); spacer.style.height = `${searchResults.length * 68}px`;
  const fragment = document.createDocumentFragment(); fragment.append(spacer);
  for (let i = start; i < end; i++) {
    const result = searchResults[i]; const file = files[result.file]; const item = node('button', 'search-result'); item.style.top = `${i * 68}px`;
    item.append(node('strong', '', file.path), node('span', '', `${result.line}: ${result.excerpt}`)); item.title = result.excerpt;
    item.onclick = () => void openFile(file, result.line, result.side as 'before' | 'after'); fragment.append(item);
  }
  container.replaceChildren(fragment);
}
$('search-results').onscroll = renderSearch;
$('search-form').onsubmit = event => {
  event.preventDefault(); const query = input('search-input').value; worker.postMessage({ type: 'cancel' }); searchId = ++requestId; searchResults = []; renderSearch();
  if (!query) { $('search-status').textContent = 'Enter text to search.'; return; }
  $('search-status').textContent = 'Searching source...'; worker.postMessage({ type: 'search', id: searchId, query, files, matchCase: input('match-case').checked });
};
$('cancel-search').onclick = () => { worker.postMessage({ type: 'cancel' }); searchId = ++requestId; $('search-status').textContent = `Cancelled / ${searchResults.length} results retained`; };
let paletteIndex = 0, paletteFiles: FileEntry[] = [];
function fuzzyScore(path: string, query: string) {
  const value = path.toLowerCase(); const q = query.toLowerCase(); if (!q) return 0;
  const direct = value.indexOf(q); if (direct >= 0) return 1000 - direct - value.length / 100;
  let from = 0, score = 0;
  for (const char of q) { const pos = value.indexOf(char, from); if (pos < 0) return -Infinity; score += pos === from ? 10 : 1; from = pos + 1; }
  return score - value.length / 100;
}
function renderPalette() {
  const query = input('palette-input').value;
  paletteFiles = files.map(file => ({ file, score: fuzzyScore(file.path, query) })).filter(item => item.score > -Infinity).sort((a, b) => b.score - a.score).slice(0, 60).map(item => item.file);
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteFiles.length - 1)); $('palette-results').replaceChildren();
  paletteFiles.forEach((file, index) => {
    const item = node('button', `palette-result${index === paletteIndex ? 'selected' : ''}`); item.append(node('span', `file-icon ${extensionClass(file.path)}`, extensionGlyph(file.path)), node('span', '', file.path));
    item.onclick = () => { $<HTMLDialogElement>('palette').close(); void openFile(file); }; $('palette-results').append(item);
  });
  if (!paletteFiles.length) $('palette-results').append(node('p', 'empty-state', 'No matching files'));
}
function openPalette() { paletteIndex = 0; input('palette-input').value = ''; renderPalette(); $<HTMLDialogElement>('palette').showModal(); input('palette-input').focus(); }
$('quick-open').onclick = openPalette;
input('palette-input').oninput = () => { paletteIndex = 0; renderPalette(); };
input('palette-input').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); if (paletteFiles[paletteIndex]) { $<HTMLDialogElement>('palette').close(); void openFile(paletteFiles[paletteIndex]); } }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); paletteIndex = Math.max(0, Math.min(paletteFiles.length - 1, paletteIndex + (event.key === 'ArrowDown' ? 1 : -1))); renderPalette(); $('palette-results').children[paletteIndex]?.scrollIntoView({ block: 'nearest' }); }
};
document.addEventListener('keydown', event => {
  const typing = (event.target as HTMLElement).closest('input,textarea,[contenteditable=true]');
  if ((event.ctrlKey || event.metaKey) && (event.key === 'k' || event.key === 'p')) { event.preventDefault(); if (!$<HTMLDialogElement>('palette').open) openPalette(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'g') { event.preventDefault(); if (!$<HTMLDialogElement>('line-dialog').open) jump(); }
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); navigate('search'); $('app').classList.add('navigation-open'); }
  if (!typing && event.key === '/') { event.preventDefault(); navigate('files'); input('file-filter').focus(); }
  if (event.key === 'Escape') $('app').classList.remove('navigation-open');
});
$('about').onclick = () => {
  const container = $('info-content'); container.replaceChildren();
  for (const text of [`${manifest.name} / ${manifest.mode}`, `Created ${new Date(manifest.created).toLocaleString()}`, manifest.comparison ?? 'Filesystem snapshot', `${files.length} files / ${formatBytes(manifest.totalBytes)} source`, 'Read only. No network requests. All included source is embedded in this HTML.', 'Privacy: filename exclusions are not a secret scanner. Review source before sharing.']) container.append(node('p', '', text));
  container.append(node('h3', '', 'Excluded entries (pruned directories count once)'));
  for (const [reason, count] of Object.entries(manifest.exclusions)) container.append(node('p', 'muted', `${reason}: ${count}`));
  if (!Object.keys(manifest.exclusions).length) container.append(node('p', 'muted', 'None'));
  $('notices').textContent = JSON.parse($('third-party-notices').textContent!); $<HTMLDialogElement>('info-dialog').showModal();
};
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1)); const file = fileByPath.get(params.get('file') ?? '');
  if (params.has('focus')) void city?.restore(params).catch(() => {});
  if (file) void openFile(file, Math.max(1, Number(params.get('line')) || 1), params.get('side') === 'before' ? 'before' : 'after', false, !params.has('focus'));
}
window.addEventListener('hashchange', readHash);
navigate('map'); $('app').classList.remove('navigation-open'); syncWorkspace(); rebuildTree();
try { city = new City(manifest, { openFile: id => { if (files[id]) void openFile(files[id], 1, undefined, true, false); }, error: toast }); void city.ready.catch(() => navigate('files')); } catch (error) { toast((error as Error).message); navigate('files'); }
journey = new Journey(manifest, city, (id, line, side) => { if (files[id]) void openFile(files[id], line, side, true, false); });
readHash();
window.addEventListener('beforeunload', () => { worker.terminate(); city?.destroy(); });







