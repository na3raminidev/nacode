import { browser } from './browser-helper.js';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { LENSES } from '../src/insights/model.js';
const b = await browser();
try {
 const page = await b.newPage({viewport:{width:1440,height:1000}}), errors:string[]=[], requests:string[]=[];
 page.on('pageerror', e=>errors.push(e.message)); page.on('request',r=>{if (/^https?:/.test(r.url())) requests.push(r.url());});
 await page.goto(pathToFileURL(path.resolve('output/insights-diff.html')).href);
 await page.click('#insights-open'); await page.waitForSelector('#insight-panel[data-ready="true"]');
 for (const lens of LENSES) {
  await page.selectOption('#insight-lens',lens.id);
  await page.waitForFunction(()=>document.querySelector('#insight-status')?.textContent?.includes('records.'));
  assert.ok(await page.locator('.insight-card').count(),lens.id);
 }
 await page.selectOption('#insight-lens','contracts'); await page.selectOption('#insight-side','compare');
 await page.waitForFunction(()=>document.querySelector('#insight-results')?.textContent?.includes('changed'));
 await page.locator('.insight-card').filter({hasText:'OrderDto.amount'}).click();
 await page.locator('#insight-detail').getByRole('button',{name:'Open source evidence'}).click(); await page.waitForSelector('.cm-editor');
 await page.screenshot({path:'test-results/insights-desktop.png'});
 await page.click('#quick-open'); await page.fill('#palette-input','OrderCard'); await page.press('#palette-input','Enter');
 await page.selectOption('#insight-lens','components'); await page.check('#insight-file-only');
 await page.waitForFunction(()=>document.querySelector('#insight-results')?.textContent?.includes('graph consumer'));
 await page.locator('.insight-card').filter({hasText:'graph consumer'}).filter({hasText:'after'}).first().click();
 await page.locator('#insight-detail').getByRole('button',{name:'Trace symbol journey'}).click();
 await page.waitForFunction(()=>document.querySelector('#journey-results')?.textContent?.includes('OrderCard'));
 assert.equal(await page.locator('#journey-version').inputValue(),'after');
 await page.click('#insights-open'); await page.uncheck('#insight-file-only');
 await page.click('#journeys-open'); assert.ok(await page.locator('#insight-panel').isHidden());
 await page.click('#insights-open'); assert.ok(await page.locator('#journey-panel').isHidden());
 await page.selectOption('#insight-lens','feature'); await page.selectOption('#insight-feature','orders');
 await page.waitForFunction(()=>document.querySelector('#insight-status')?.textContent?.includes('records.'));
 await page.screenshot({path:'test-results/insights-map.png'});
 await page.setViewportSize({width:390,height:844}); await page.selectOption('#insight-lens','history');
 await page.waitForFunction(()=>document.querySelector('#insight-results')?.textContent?.includes('hotspot'));
 assert.ok(await page.locator('#insight-close').isVisible()); await page.screenshot({path:'test-results/insights-mobile.png'});
 await page.keyboard.press('Escape'); assert.ok(await page.locator('#insight-panel').isHidden());
 await page.goto(pathToFileURL(path.resolve('output/insights.html')).href); await page.click('#insights-open');
 await page.waitForSelector('#insight-panel[data-ready="true"]'); assert.equal(await page.locator('#insight-side option[value="before"]').isDisabled(),true);
 assert.deepEqual(errors,[]); assert.deepEqual(requests,[]);
 console.log('Ten lenses: offline cards, contract diff, source jump, map focus, panel switching and mobile passed.');
} finally { await b.close(); }
