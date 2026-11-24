import {browser} from './browser-helper.js';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const b=await browser();const page=await b.newPage({viewport:{width:1440,height:1000}});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(pathToFileURL(path.resolve('output/journeys.html')).href);
await page.click('#journeys-open');await page.waitForSelector('#journey-panel[data-ready="true"]');
await page.fill('#journey-search','openOrders');await page.locator('.journey-symbol').filter({hasText:'openOrders'}).click();await page.click('#journey-journey');
await page.waitForFunction(()=>document.querySelector('#journey-results')?.textContent?.includes('Route 1'));
assert.ok((await page.locator('#journey-results').textContent())?.includes('orders'));
await page.locator('.journey-edge').first().click();await page.getByRole('button',{name:'Open source evidence'}).click();await page.waitForSelector('.cm-editor');
await page.screenshot({path:'test-results/journeys-desktop.png'});
await page.setViewportSize({width:390,height:844});await page.screenshot({path:'test-results/journeys-mobile.png'});
await page.goto(pathToFileURL(path.resolve('output/journeys-diff.html')).href);
await page.click('#journeys-open');await page.waitForSelector('#journey-panel[data-ready="true"]');
await page.fill('#journey-search','openOrders');await page.locator('.journey-symbol').filter({hasText:'openOrders'}).click();await page.selectOption('#journey-version','compare');await page.click('#journey-journey');
await page.waitForFunction(()=>document.querySelector('#journey-results')?.textContent?.includes('orders_archive') && document.querySelector('#journey-results')?.textContent?.includes('AFTER / Route 1'));
assert.ok((await page.locator('#journey-results').textContent())?.includes('REMOVED'));await page.screenshot({path:'test-results/journeys-compare-mobile.png'});
assert.deepEqual(errors,[]);console.log('Journey: offline web -> Spring -> table path, evidence, desktop/mobile passed');await b.close();


