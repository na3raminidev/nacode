import type { FileEntry, Status } from '../../model.js';
export interface Rect { x: number; y: number; w: number; h: number }
export type CityKind = 'city' | 'district' | 'folder' | 'block' | 'file';
export interface CityNode {
  id: number; parent: number; path: string; name: string; aliases: string[]; kind: CityKind;
  streets?: { x1: number; y1: number; x2: number; y2: number }[]; children: number[]; file?: number; bytes: number; count: number; changes: number;
  status?: Status; weight: number; rect: Rect; width: number; height: number; color: number;
}
export interface CityLayout { nodes: CityNode[]; root: number }
interface Raw { path: string; name: string; children: Map<string, Raw>; file?: FileEntry }
const compare = (a: Raw, b: Raw) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
export function hashPath(path: string): number {
  let hash = 2166136261;
  for (let i = 0; i < path.length; i++) hash = Math.imul(hash ^ path.charCodeAt(i), 16777619);
  return hash >>> 0;
}
export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}
export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
// Coordinates belong to the parent, not the entire city. Deep paths never underflow.
export function createCity(files: FileEntry[], name: string): CityLayout {
  const raw: Raw = { path: '', name, children: new Map() };
  for (const file of files) {
    let parent = raw; let path = '';
    const parts = file.path.split('/');
    for (let i = 0; i < parts.length; i++) {
      path += (i ? '/' : '') + parts[i];
      let next = parent.children.get(parts[i]);
      if (!next) { next = { path, name: parts[i], children: new Map() }; parent.children.set(parts[i], next); }
      parent = next;
    }
    parent.file = file;
  }
  const nodes: CityNode[] = [];
  const add = (item: Raw, parent: number, depth: number) => {
    const aliases = [item.path]; let final = item;
    if (depth > 1) while (!final.file && final.children.size === 1 && ![...final.children.values()][0].file) {
      final = [...final.children.values()][0]; aliases.push(final.path);
    }
    const file = final.file;
    const node: CityNode = {
      id: nodes.length, parent, path: final.path, name: aliases.length > 1 ? aliases.slice(1).map((p, i) => p.slice(aliases[i].length + 1)).reduce((a, b) => `${a}/${b}`, item.name) : final.name,
      aliases, kind: depth === 0 ? 'city' : file ? 'file' : depth === 1 ? 'district' : 'folder', children: [], file: file?.id,
      bytes: file ? (file.after?.bytes ?? file.before?.bytes ?? 0) : 0, count: file ? 1 : 0,
      changes: file ? file.additions + file.deletions : 0, status: file?.status,
      weight: file ? Math.min(4, 1 + Math.log2((file.after?.bytes ?? file.before?.bytes ?? 0) + 1) * .15) : 0,
      rect: { x: 0, y: 0, w: 1600, h: 1100 }, width: 1600, height: 1100,
      color: depth === 1 ? hashPath(item.path) % 5 : parent >= 0 ? nodes[parent].color : 0,
    };
    nodes.push(node); if (parent >= 0) nodes[parent].children.push(node.id);
    return { node, raw: final, depth };
  };
  const queue = [add(raw, -1, 0)];
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]; let children = [...item.raw.children.values()].sort(compare);
    if (item.depth === 0) {
      const rootFiles = children.filter(c => c.file); children = children.filter(c => !c.file);
      if (rootFiles.length) children.push({ path: '\0root-files', name: 'Root files', children: new Map(rootFiles.map(c => [c.name, c])) });
    }
    for (const child of children) queue.push(add(child, item.node.id, item.depth + 1));
  }
  // Aggregate actual folders before introducing explicitly labeled visual blocks.
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i]; if (node.parent < 0) continue;
    const parent = nodes[node.parent]; parent.bytes += node.bytes; parent.count += node.count; parent.changes += node.changes; parent.weight += node.weight;
  }
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.children.length <= 48) continue;
    const old = node.children; node.children = [];
    const size = Math.max(32, Math.ceil(old.length / 32));
    for (let start = 0; start < old.length; start += size) {
      const children = old.slice(start, start + size); const number = Math.floor(start / size) + 1;
      const block: CityNode = { ...node, id: nodes.length, parent: node.id, path: `\0block:${node.path}:${number}`, aliases: [], name: `Block ${String(number).padStart(2, '0')}`, kind: 'block', children, bytes: 0, count: 0, changes: 0, weight: 0 };
      for (const id of children) { const child = nodes[id]; child.parent = block.id; block.bytes += child.bytes; block.count += child.count; block.changes += child.changes; block.weight += child.weight; }
      nodes.push(block); node.children.push(block.id);
    }
  }
  const pending = [0];
  while (pending.length) {
    const parent = nodes[pending.pop()!];
    if (!parent.children.length) continue;
    const pad = parent.kind === 'city' ? 38 : 28; const top = parent.kind === 'city' ? 38 : 65;
    parent.streets = [{ x1: pad / 2, y1: top / 2, x2: parent.width - pad / 2, y2: top / 2 }, { x1: pad / 2, y1: parent.height - pad / 2, x2: parent.width - pad / 2, y2: parent.height - pad / 2 }, { x1: pad / 2, y1: top / 2, x2: pad / 2, y2: parent.height - pad / 2 }, { x1: parent.width - pad / 2, y1: top / 2, x2: parent.width - pad / 2, y2: parent.height - pad / 2 }];
    const prefix = [0]; for (const id of parent.children) prefix.push(prefix.at(-1)! + nodes[id].weight);
    const regions = [{ from: 0, to: parent.children.length, x: pad, y: top, w: parent.width - pad * 2, h: parent.height - top - pad }];
    while (regions.length) {
      const rect = regions.pop()!;
      if (rect.to - rect.from === 1) {
        const child = nodes[parent.children[rect.from]];
        const inset = child.kind === 'file' ? Math.min(rect.w, rect.h) * .12 : Math.min(10, Math.min(rect.w, rect.h) * .04);
        child.rect = { x: rect.x + inset, y: rect.y + inset, w: rect.w - inset * 2, h: rect.h - inset * 2 };
        const aspect = child.rect.w / child.rect.h;
        child.width = 1000 * Math.sqrt(aspect); child.height = 1000 / Math.sqrt(aspect);
        // Reserve enough local room for headers even in unusually narrow parcels.
        if (Math.min(child.width, child.height) < 1000) { const gain = 1000 / Math.min(child.width, child.height); child.width *= gain; child.height *= gain; }
        pending.push(child.id); continue;
      }
      const total = prefix[rect.to] - prefix[rect.from]; let split = rect.from + 1;
      let low = split, high = rect.to - 1;
      while (low <= high) { const mid = (low + high) >>> 1; if (prefix[mid] - prefix[rect.from] < total / 2) { split = mid; low = mid + 1; } else { split = mid; high = mid - 1; } }
      split = Math.max(rect.from + 1, Math.min(rect.to - 1, split));
      // Bound extreme folder ratios so long spines cannot become needle-thin parcels.
      const ratio = Math.max(.15, Math.min(.85, (prefix[split] - prefix[rect.from]) / total));
      const vertical = rect.w >= rect.h; const length = vertical ? rect.w : rect.h;
      const gap = Math.min(parent.kind === 'city' ? 30 : 18, length * .06);
      const a = (length - gap) * ratio; const b = length - gap - a;
      if (vertical) parent.streets.push({ x1: rect.x + a + gap / 2, y1: Math.max(top / 2, rect.y - 36), x2: rect.x + a + gap / 2, y2: Math.min(parent.height - pad / 2, rect.y + rect.h + 36) });
      else parent.streets.push({ x1: Math.max(pad / 2, rect.x - 36), y1: rect.y + a + gap / 2, x2: Math.min(parent.width - pad / 2, rect.x + rect.w + 36), y2: rect.y + a + gap / 2 });
      if (vertical) regions.push({ ...rect, to: split, w: a }, { ...rect, from: split, x: rect.x + a + gap, w: b });
      else regions.push({ ...rect, to: split, h: a }, { ...rect, from: split, y: rect.y + a + gap, h: b });
    }
  }
  return { nodes, root: 0 };
}


