import { createCity } from './layout.js';
self.onmessage = event => {
  try { self.postMessage({ type: 'city', layout: createCity(event.data.files, event.data.name) }); }
  catch (error) { self.postMessage({ type: 'error', message: (error as Error).message }); }
};
