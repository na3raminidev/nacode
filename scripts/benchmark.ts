import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { snapshot } from '../src/generator/collect.js';
import { exportHTML } from '../src/generator/export.js';
import { browser } from '../test/browser-helper.js';
await mkdir('test-results', { recursive: true });
const instance = await browser(); const results: Record<string, unknown>[] = [];
try {
  for (const [name, count, bytes] of [['small', 50, 1024], ['medium', 2000, 2048], ['large', 20000, Math.ceil(100 * 1024 * 1024 / 20000)]] as const) {
    const root = path.resolve(`test-results/benchmark-${name}`); await mkdir(root, { recursive: true });
    for (let i = 0; i < count; i++) {
      const dir = path.join(root, `module-${Math.floor(i / 100).toString().padStart(3, '0')}`); if (i % 100 === 0) await mkdir(dir, { recursive: true });
      const prefix = `// file ${i}\nexport const id = ${i};\n// `;
      const random = randomBytes(bytes).toString('base64').slice(0, bytes - prefix.length - 1);
      await writeFile(path.join(dir, `file-${i.toString().padStart(5, '0')}.ts`), prefix + random + '\n');
    }
    const out = path.resolve(`test-results/benchmark-${name}.html`); const started = performance.now();
    const data = await snapshot(root, { include: [], exclude: [], ignore: true, out });
    await exportHTML(data, out, 'snapshot', true, path.resolve('dist/assets')); const generationMs = performance.now() - started;
    const context = await instance.newContext({ offline: true, viewport: { width: 1440, height: 950 } });
    const page = await context.newPage(); const session = await context.newCDPSession(page); await session.send('Performance.enable');
    const load = performance.now(); await page.goto(pathToFileURL(out).href); await page.locator('#city-canvas[data-ready="true"][data-camera]').waitFor(); const startupMs = performance.now() - load;
    await page.click('#quick-open'); await page.fill('#palette-input', 'file-00000.ts'); await page.press('#palette-input', 'Enter'); await page.locator('.cm-content').waitFor();
    await page.click('#quick-open'); await page.fill('#palette-input', 'file-00001.ts'); await page.press('#palette-input', 'Enter'); await page.waitForFunction(() => document.querySelector('.cm-content')?.textContent?.includes('id = 1;'));
    const cached: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = i % 2; const label = `file-${id.toString().padStart(5, '0')}.ts`; const time = performance.now();
      await page.getByRole('tab', { name: label, exact: false }).evaluate((element: HTMLElement) => element.click());
      await page.waitForFunction(id => document.querySelector('.cm-content')?.textContent?.includes(`id = ${id};`), id, { polling: 'raf' }); cached.push(performance.now() - time);
    }
    await page.click('#top-search'); await page.fill('#search-input', 'export const id = 19999;'); const searchStart = performance.now(); await page.press('#search-input', 'Enter');
    await page.waitForFunction(() => document.getElementById('search-status')!.textContent!.includes('matching lines'), undefined, { timeout: 180000 }); const searchMs = performance.now() - searchStart;
    await page.click('#reader-close'); await page.click('#top-map'); await page.click('#city-fit'); await page.waitForTimeout(450);
    await page.evaluate(() => {
      const samples: number[] = []; (window as any).__cityFrames = samples; (window as any).__maxCityShapes = 0;
      document.getElementById('city-canvas')!.addEventListener('graphicode:city-frame', event => { const detail = (event as CustomEvent).detail; samples.push(detail.duration); (window as any).__maxCityShapes = Math.max((window as any).__maxCityShapes, detail.shapes); });
    });
    const cadence = await page.evaluate<{ frameIntervalP95Ms: number; samples: number }>(`new Promise(resolve => {
      const canvas = document.getElementById('city-canvas'); const box = canvas.getBoundingClientRect();
      const intervals = []; let previous = 0, frame = 0;
      const tick = (now) => {
        if (previous) intervals.push(now - previous); previous = now;
        if (frame < 80) canvas.dispatchEvent(new WheelEvent('wheel', { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, deltaY: frame < 40 ? -35 : 35, cancelable: true }));
        else canvas.dispatchEvent(new KeyboardEvent('keydown', { key: frame % 2 ? 'ArrowLeft' : 'ArrowRight', cancelable: true }));
        if (++frame < 120) requestAnimationFrame(tick);
        else { intervals.sort((a, b) => a - b); resolve({ frameIntervalP95Ms: intervals[Math.floor(intervals.length * .95)], samples: intervals.length }); }
      };
      requestAnimationFrame(tick);
    })`);    const frameStats = await page.evaluate(() => {
      const values: number[] = (window as any).__cityFrames; values.sort((a, b) => a - b);
      return { samples: values.length, renderP95Ms: values[Math.floor(values.length * .95)], maxShapes: (window as any).__maxCityShapes };
    });    const metrics = await session.send('Performance.getMetrics');
    const heapBytes = metrics.metrics.find(m => m.name === 'JSHeapUsedSize')?.value;
    const result = { cityFrames: { ...frameStats, ...cadence }, name, count, sourceBytes: count * bytes, htmlBytes: (await stat(out)).size, generationMs: Math.round(generationMs), startupMs: Math.round(startupMs), cachedSwitchMedianMs: Math.round(cached.sort((a, b) => a - b)[2]), fullSearchMs: Math.round(searchMs), mainThreadHeapBytes: heapBytes, generatorRssPeakBytes: process.resourceUsage().maxRSS * 1024 };
    results.push(result); console.log(JSON.stringify(result)); await context.close();
  }
  await writeFile('test-results/benchmark.json', JSON.stringify({ measuredAt: new Date().toISOString(), platform: `${os.platform()} ${os.release()}`, cpu: os.cpus()[0].model, ramBytes: os.totalmem(), browser: instance.version(), node: process.version, notes: 'Main-thread heap excludes worker/native/renderer memory. Generator peak is cumulative across fixtures. Search is a full no-hit or final-file scan. Startup includes navigation, layout worker, and first city frame. Render p95 measures synchronous drawing/navigation; frame-interval p95 measures RAF cadence during 120 frames of scripted zoom/pan. Neither measures input latency or GPU completion.', results }, null, 2));
} finally { await instance.close(); }




