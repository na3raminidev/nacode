import { parentPort } from 'node:worker_threads';
import { extractFile } from './extract.js';
parentPort!.on('message', async ({ id, path, text }) => {
  try { parentPort!.postMessage({ id, result: await extractFile(path, text) }); }
  catch (error) { parentPort!.postMessage({ id, error: (error as Error).message }); }
});
