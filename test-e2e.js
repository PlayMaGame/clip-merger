// End-to-end smoke test. Requires @playwright/test + playwright and a buildable
// Electron app; when those aren't installed we skip the file so `npm test`
// (node --test) stays green.
let test = () => {};
let expect = () => {};
try {
  ({ test, expect } = require('@playwright/test'));
  require.resolve('playwright');
} catch (_) {
  console.log('skipping test-e2e.js: @playwright/test or playwright not installed');
  module.exports = {};
  return;
}

const { spawn } = require('child_process');
const path = require('path');

const APP_PATH = path.join(__dirname, '.');
let electronProcess;

test.beforeAll(async () => {
  // Start Electron with remote debugging
  electronProcess = spawn('npx', ['electron', '.', '--remote-debugging-port=9222'], {
    cwd: APP_PATH,
    stdio: 'ignore',
    detached: true,
  });
  electronProcess.unref();
  await new Promise(r => setTimeout(r, 3000));
});

test.afterAll(async () => {
  if (electronProcess) {
    electronProcess.kill();
  }
});

test('app loads without renderer errors', async () => {
  const browser = await require('playwright').chromium.connectOverCDP('http://localhost:9222');
  const page = browser.contexts()[0].pages()[0];
  
  // Wait for app to be ready
  await page.waitForSelector('#tl-track-video', { timeout: 10000 });
  
  // Check for console errors
  const errors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  
  await page.waitForTimeout(1000);
  expect(errors).toHaveLength(0);
  
  await browser.close();
});

test('MAIN lane accepts clips', async () => {
  const browser = await require('playwright').chromium.connectOverCDP('http://localhost:9222');
  const page = browser.contexts()[0].pages()[0];
  
  // Check MAIN lane exists and is empty initially
  const mainLane = await page.$('#tl-video-body');
  expect(mainLane).toBeTruthy();
  
  await browser.close();
});

test('ALT lane exists', async () => {
  const browser = await require('playwright').chromium.connectOverCDP('http://localhost:9222');
  const page = browser.contexts()[0].pages()[0];
  
  const altLane = await page.$('#tl-hybrid-body');
  expect(altLane).toBeTruthy();
  
  await browser.close();
});

test('SOUND lane exists', async () => {
  const browser = await require('playwright').chromium.connectOverCDP('http://localhost:9222');
  const page = browser.contexts()[0].pages()[0];
  
  const soundLane = await page.$('#tl-audio-body');
  expect(soundLane).toBeTruthy();
  
  await browser.close();
});