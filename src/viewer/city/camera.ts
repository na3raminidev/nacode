import type { CityLayout, CityNode, Rect } from './layout.js';
import { contains } from './layout.js';
export interface Camera { frame: number; x: number; y: number; scale: number }
export interface Viewport { w: number; h: number }
export function screenRect(rect: Rect, camera: Camera, viewport: Viewport): Rect {
  return { x: (rect.x - camera.x) * camera.scale + viewport.w / 2, y: (rect.y - camera.y) * camera.scale + viewport.h / 2, w: rect.w * camera.scale, h: rect.h * camera.scale };
}
export function fitCamera(node: CityNode, viewport: Viewport): Camera {
  return { frame: node.id, x: node.width / 2, y: node.height / 2, scale: Math.max(.001, Math.min(viewport.w / (node.width + 200), viewport.h / (node.height + 200))) };
}
export function zoomCamera(camera: Camera, viewport: Viewport, point: { x: number; y: number }, factor: number): Camera {
  const scale = Math.max(1e-8, Math.min(128, camera.scale * factor));
  return { ...camera, scale, x: camera.x + (point.x - viewport.w / 2) * (1 / camera.scale - 1 / scale), y: camera.y + (point.y - viewport.h / 2) * (1 / camera.scale - 1 / scale) };
}
export function parentCamera(camera: Camera, layout: CityLayout): Camera {
  const node = layout.nodes[camera.frame]; if (node.parent < 0) return camera;
  const factor = node.rect.w / node.width;
  return { frame: node.parent, x: node.rect.x + camera.x * factor, y: node.rect.y + camera.y * factor, scale: camera.scale / factor };
}
export function childCamera(camera: Camera, node: CityNode): Camera {
  const factor = node.rect.w / node.width;
  return { frame: node.id, x: (camera.x - node.rect.x) / factor, y: (camera.y - node.rect.y) / factor, scale: camera.scale * factor };
}
// Rebase without changing any pixel positions. This keeps coordinates precise at any depth.
export function rebase(camera: Camera, layout: CityLayout, viewport: Viewport): Camera {
  let result = camera;
  for (let step = 0; step < layout.nodes.length; step++) {
    const node = layout.nodes[result.frame];
    const bounds = screenRect({ x: 0, y: 0, w: node.width, h: node.height }, result, viewport);
    if (node.parent >= 0 && (bounds.x > 0 || bounds.y > 0 || bounds.x + bounds.w < viewport.w || bounds.y + bounds.h < viewport.h)) { result = parentCamera(result, layout); continue; }
    break;
  }
  for (let step = 0; step < layout.nodes.length; step++) {
    const node = layout.nodes[result.frame]; let target: CityNode | undefined;
    for (const id of node.children) {
      const child = layout.nodes[id]; if (child.kind === 'file') continue;
      const bounds = screenRect(child.rect, result, viewport);
      if (contains(bounds, -32, -32) && contains(bounds, viewport.w + 32, viewport.h + 32)) { target = child; break; }
    }
    if (!target) break; result = childCamera(result, target);
  }
  if (result.frame === layout.root) {
    const min = fitCamera(layout.nodes[layout.root], viewport).scale * .45;
    result.scale = Math.max(min, result.scale);
  }
  return result;
}
