import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupRoutes, hitRoute, roundedRoute, routeArrows, RouteOverlay, type MapRelation, type RouteHit } from '../src/viewer/city/routes.js';

const edge = (id: number, fromFile: number, toFile: number, more: Partial<MapRelation> = {}): MapRelation =>
  ({ id, fromFile, toFile, versions: 3, confidence: 'resolved', kind: 'call', ...more });

test('zoom bundles keep every real ID, counts, direction and diff style', () => {
  const { groups, hidden } = groupRoutes([
    edge(1, 101, 201), edge(2, 104, 205, { count: 7 }), edge(3, 201, 101), edge(4, 101, 201, { versions: 1 }),
    edge(5, 101, 201, { route: 0 }), edge(6, 101, -1), edge(7, 101, 201, { confidence: 'probable' }),
  ], file => file >= 0 ? Math.floor(file / 100) : undefined);
  assert.deepEqual(groups.map(g => [g.ids, g.count]), [[[1, 2], 8], [[3], 1], [[4], 1], [[5], 1], [[7], 1]]);
  assert.equal(hidden, 1);
});

test('badges beat lines; exact beats padded badge; selected strokes win ties', () => {
  const { groups } = groupRoutes([edge(1, 0, 1), edge(2, 0, 1, { versions: 1 })], x => x);
  const points = roundedRoute([{ x: 10, y: 80 }, { x: 45, y: 80 }, { x: 45, y: 110 }]);
  const paths: RouteHit[] = groups.map(g => ({ ...g, points }));
  assert.deepEqual(hitRoute(paths, 22, 85)?.ids, [2]);
  assert.equal(hitRoute(paths, 20, 95), undefined);
  assert.deepEqual(hitRoute(paths, 20, 95, 16)?.ids, [2]);
  paths[0].badge = { x: 14, y: 75, w: 24, h: 20 };
  paths[1].badge = { x: 42, y: 75, w: 24, h: 20 };
  assert.deepEqual(hitRoute(paths, 37, 87)?.ids, [1]);
  assert.deepEqual(hitRoute(paths, 13, 91)?.ids, [1]);
  assert.ok(points.some(p => p.x < 45 && p.y > 80), 'rounded geometry matches hit polyline');
});

test('arrow direction stays visible when an endpoint is clipped or the last leg is short', () => {
  const view = { w: 100, h: 100 };
  const clipped = routeArrows([{ x: 130, y: 50 }, { x: -30, y: 50 }], view);
  assert.equal(clipped.length, 1);
  assert.equal(clipped[0].angle, Math.PI);
  assert.ok(clipped[0].tip.x > 12 && clipped[0].tip.x < 88);
  const short = routeArrows(roundedRoute([{ x: 20, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 54 }]), view);
  assert.equal(short.length, 1);
  assert.equal(short[0].angle, 0);
  assert.deepEqual(routeArrows([{ x: 150, y: 50 }, { x: 200, y: 50 }], view), []);
});

test('map projection stays capped at 200 links without dropping members from a drawn bundle', () => {
  const overlay = new RouteOverlay({ nodes: [], root: 0 });
  overlay.set(Array.from({ length: 300 }, (_, i) => edge(i, i, 400)), false);
  const { groups } = groupRoutes(overlay.relations, file => file === 400 ? 2 : 1);
  assert.deepEqual(groups[0].ids, Array.from({ length: 200 }, (_, i) => i));
  assert.equal(groups[0].count, 200);
});
