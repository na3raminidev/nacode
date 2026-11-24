import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
export async function browser() {
  const executable = process.env.GRAPHICODE_BROWSER ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
  return chromium.launch({ headless: true, ...(executable ? { executablePath: executable } : {}) });
}
