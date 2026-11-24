import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCity, intersects } from '../src/viewer/city/layout.js';
import { fitCamera, zoomCamera, childCamera, parentCamera, rebase, screenRect } from '../src/viewer/city/camera.js';
import { visibleFeatures, hitFeature } from '../src/viewer/city/renderer.js';
import type { FileEntry } from '../src/model.js';
const files = (paths: string[]): FileEntry[] => paths.map((path, id) => ({ id, path, status: 'snapshot', additions: 0, deletions: 0, after: { kind: 'text', bytes: id * 120 } }));
test('city is deterministic, every file reachable, parcels contained and disjoint', () => {
  const input = files(Array.from({ length: 2000 }, (_, i) => `src/group-${i % 7}/file-${i}.ts`).concat(['empty', 'unicode/\u03bb.kt', `${'deep/'.repeat(200)}end.py`]));
  const city = createCity(input, 'test'); assert.deepEqual(city, createCity([...input].reverse(), 'test'));
  const reachable = new Set<number>(), pending = [0];
  while (pending.length) { const node = city.nodes[pending.pop()!]; assert(!reachable.has(node.id)); reachable.add(node.id); pending.push(...node.children); }
  assert.equal(reachable.size, city.nodes.length); assert.equal(city.nodes.filter(n => n.file !== undefined).length, input.length);
  assert.equal(city.nodes[0].count, input.length); assert(city.nodes.some(n => n.kind === 'block'));
  for (const node of city.nodes) {
    for (const id of node.children) {
      const child = city.nodes[id], r = child.rect; assert.equal(child.parent, node.id);
      assert(r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.x + r.w <= node.width + .001 && r.y + r.h <= node.height + .001);
    }
    for (let i = 0; i < node.children.length; i++) for (let j = i + 1; j < node.children.length; j++) assert(!intersects(city.nodes[node.children[i]].rect, city.nodes[node.children[j]].rect));
  }
});
test('camera zoom anchors cursor and local transforms are reversible', () => {
  const city = createCity(files(['a/b/c.ts', 'a/b/d.ts', 'x/file.kt']), 'test'); const viewport = { w: 1200, h: 800 };
  const camera = fitCamera(city.nodes[0], viewport), point = { x: 212, y: 373 };
  const zoom = zoomCamera(camera, viewport, point, 2);
  assert(Math.abs(camera.x + (point.x - 600) / camera.scale - zoom.x - (point.x - 600) / zoom.scale) < 1e-8);
  const back = parentCamera(childCamera(camera, city.nodes[1]), city);
  for (const key of ['x', 'y', 'scale'] as const) assert(Math.abs(back[key] - camera[key]) < 1e-8);
  const rebased = rebase(camera, city, viewport); assert(Number.isFinite(rebased.scale));
});
test('large city stays within shape budget and hit selection chooses deepest feature', () => {
  const city = createCity(files(Array.from({ length: 20000 }, (_, i) => `src/file-${i}.ts`)), 'large'); const vp = { w: 1440, h: 900 };
  for (const scale of [.5, 2, 10, 100]) { const features = visibleFeatures(city, { frame: 0, x: 800, y: 550, scale }, vp, 2000); assert(features.length <= 2000); }
  const features = [{ id: 0, rect: { x: 0, y: 0, w: 100, h: 100 }, detail: true }, { id: 1, rect: { x: 10, y: 10, w: 20, h: 20 }, detail: false }];
  assert.equal(hitFeature(features, 15, 15), 1); assert.equal(hitFeature(features, 200, 200), undefined);
});
test('empty city and diff status do not alter layout geometry', () => {
  assert.equal(createCity([], 'empty').nodes.length, 1);
  const input = files(['a/b.ts', 'a/c.kt']); const before = createCity(input, 'test');
  const after = createCity(input.map(f => ({ ...f, status: 'deleted', additions: 0, deletions: 99 })), 'test');
  assert.deepEqual(before.nodes.map(n => n.rect), after.nodes.map(n => n.rect));
});
test('branching deep paths stay finite and rebasing preserves screen geometry', () => {
  const input = files(Array.from({ length: 120 }, (_, i) => `${'level/'.repeat(i + 1)}file.ts`));
  const city = createCity(input, 'deep'); const vp = { w: 1000, h: 700 };
  for (const node of city.nodes.filter(n => n.children.length)) {
    const cam = fitCamera(node, vp), rebased = rebase(cam, city, vp);
    assert([rebased.x, rebased.y, rebased.scale].every(Number.isFinite));
    assert(visibleFeatures(city, rebased, vp).length <= 2000);
    if (node.parent >= 0) { const parent = parentCamera(cam, city); const rect = screenRect(node.rect, parent, vp); const local = screenRect({ x: 0, y: 0, w: node.width, h: node.height }, cam, vp); assert(Math.abs(rect.x - local.x) < 1e-6); assert(Math.abs(rect.h - local.h) < 1e-6); }
  }
});
