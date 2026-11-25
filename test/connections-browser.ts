import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { browser } from './browser-helper.js';

const output = (name: string) => pathToFileURL(path.resolve('output', name + '.html')).href;
const capture = async (page: Page) => {
  // Read actual Canvas paint coordinates, then use real pointer events.
  await page.addInitScript(() => {
    const surface = CanvasRenderingContext2D.prototype;
    const clear = surface.clearRect, fill = surface.fillText;
    const badges: { label: string; x: number; y: number }[] = [];
    (window as any).routeBadges = badges;
    surface.clearRect = function (...args) { if (this.canvas.id === 'city-canvas') badges.length = 0; return clear.apply(this, args); };
    surface.fillText = function (label, x, y, maxWidth?) {
      if (this.canvas.id === 'city-canvas' && /^(?:R\d+|[+-]\d*|\d+)$/.test(label) && this.textBaseline === 'middle') badges.push({ label, x, y });
      return maxWidth === undefined ? fill.call(this, label, x, y) : fill.call(this, label, x, y, maxWidth);
    };
  });
};
const badge = async (page: Page, label: string) => {
  const handle = await page.waitForFunction(value => {
    const canvas = document.querySelector('#city-canvas')!; const r = canvas.getBoundingClientRect();
    for (const p of (window as any).routeBadges ?? []) {
      const x = r.x + p.x, y = r.y + p.y;
      if (p.label === value && document.elementFromPoint(x, y) === canvas) return { x, y };
    }
  }, label, { timeout: 5000 });
  const result = await handle.jsonValue(); await handle.dispose(); return result as { x: number; y: number };
};
const query = async (page: Page) => {
  await page.click('#journeys-open'); await page.waitForSelector('#journey-panel[data-ready=true]');
  await page.fill('#journey-search', 'inspectLinks'); await page.locator('.journey-symbol').filter({ hasText: 'inspectLinks' }).click();
  await page.locator('.journey-edge').filter({ hasText: 'loadSecond' }).waitFor();
};

const b = await browser();
try {
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const requests: string[] = [], errors: string[] = [];
  page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message)); await capture(page);
  await page.goto(output('journeys')); await query(page); await page.click('#journey-close');
  const canvas = page.locator('#city-canvas'), card = page.locator('#connection-card');
  let point = await badge(page, '3');
  const home = await canvas.getAttribute('data-camera');
  const fit = async () => {
    await page.click('#city-fit');
    await page.waitForFunction(value => document.querySelector<HTMLCanvasElement>('#city-canvas')?.dataset.camera === value, home);
    return badge(page, '3');
  };
  await page.mouse.move(point.x, point.y);
  await page.locator('#city-tooltip').getByText('3 grouped connections').waitFor();
  assert.match((await canvas.getAttribute('class')) ?? '', /connection-hover/);
  await page.screenshot({ path: 'test-results/connections-light.png' });
  await page.mouse.dblclick(point.x, point.y);
  await page.waitForFunction(() => Number(document.querySelector<HTMLCanvasElement>('#city-canvas')!.dataset.scale) > 1);
  assert.ok(await card.isHidden());
  point = await fit();
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 64, point.y + 34, { steps: 5 }); await page.mouse.up();
  await page.waitForFunction(value => document.querySelector<HTMLCanvasElement>('#city-canvas')?.dataset.camera !== value, home);
  assert.ok(await card.isHidden());
  point = await fit(); await page.mouse.click(point.x, point.y);
  await card.getByRole('heading', { name: '3 grouped connections' }).waitFor();
  assert.equal(await card.locator('.connection-member').count(), 3);
  await card.getByRole('button', { name: /inspectLinks.*loadSecond/ }).click();
  assert.match((await card.textContent()) ?? '', /page\.ts:5 \(After\)/);
  assert.ok(await page.locator('#journey-panel').isHidden());
  const camera = await canvas.getAttribute('data-camera'); await page.keyboard.press('Escape');
  assert.equal(await canvas.getAttribute('data-camera'), camera); assert.ok(await card.isHidden());
  await page.click('#theme');
  await page.locator('#connection-list-open').press('Enter');
  await card.getByRole('button', { name: /inspectLinks.*loadFirst/ }).press('Enter');
  await card.getByText(/visual guide only/).waitFor();
  await badge(page, '3'); // The inspector should not obscure the selected path.
  await page.screenshot({ path: 'test-results/connections-dark.png' });
  await card.getByRole('button', { name: 'Close connection details' }).click();
  assert.equal(await page.locator('#connection-list-open').evaluate(el => el === document.activeElement), true);

  await page.goto(output('journeys-diff')); await query(page);
  await page.selectOption('#journey-version', 'compare');
  await page.locator('.journey-edge').filter({ hasText: /REMOVED.*legacyValue/ }).waitFor();
  await page.locator('.journey-edge').filter({ hasText: 'loadFirst' }).click();
  assert.match((await card.textContent()) ?? '', /page\.ts:7 \(Before\).*page\.ts:5 \(After\)/);
  await card.getByRole('button', { name: 'Open before evidence' }).click(); await page.waitForSelector('.cm-editor');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('line'), '7');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('side'), 'before');
  await card.getByRole('button', { name: 'Open after evidence' }).click();
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('line'), '5');
  assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('side'), 'after');

  await page.goto(output('insights-diff')); await page.click('#insights-open');
  await page.click('#insight-map-links'); await card.locator('.connection-member').first().click();
  await card.getByText(/No exact source line/).waitFor(); assert.ok(await page.locator('#insight-panel').isVisible());
  assert.equal(await card.getByRole('button', { name: 'Open source evidence' }).count(), 0);
  assert.ok(await card.getByRole('button', { name: 'Open source file' }).isVisible());
  await page.keyboard.press('Escape'); assert.ok(await card.isHidden()); assert.ok(await page.locator('#insight-panel').isVisible());
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);

  const touch = await b.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  await capture(touch); await touch.goto(output('journeys')); await query(touch); await touch.click('#journey-close');
  point = await badge(touch, '3'); await touch.touchscreen.tap(point.x, point.y);
  await touch.locator('#connection-card').getByRole('heading', { name: '3 grouped connections' }).waitFor();
  await touch.locator('.connection-member').first().tap();
  await touch.screenshot({ path: 'test-results/connections-touch.png' });
  await touch.locator('#connection-close').tap();
  const cdp = await touch.context().newCDPSession(touch);
  const scale = await touch.locator('#city-canvas').getAttribute('data-scale');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, x: 130, y: 275 }, { id: 1, x: 230, y: 275 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: 100, y: 275 }, { id: 1, x: 260, y: 275 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.waitForFunction(previous => Number(document.querySelector<HTMLCanvasElement>('#city-canvas')!.dataset.scale) > Number(previous), scale);
  assert.ok(await touch.locator('#connection-card').isHidden());
  console.log('Map connections: click, hover, drag, double-click, keyboard, tap and pinch; versioned and file-only evidence passed.');
} finally { await b.close(); }
