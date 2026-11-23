const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodePng } = require('../../../tools/presence-shape');
const { ui, boot, waitFor, sleep, START } = require('../../helpers/game-page');

const pixels = decodePng(fs.readFileSync(path.join(__dirname, '../../fixtures/captcha/presence-875.png')));
const preload = `
  const img = document.getElementById('presence_image');
  img.src = '/presence';
  Object.defineProperties(img, {
    naturalWidth: { value: 320 }, naturalHeight: { value: 160 }, complete: { value: true }
  });
  img.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 320 });
  HTMLCanvasElement.prototype.getContext = () => ({
    drawImage() {}, getImageData() { return ${JSON.stringify({ ...pixels, data: Array.from(pixels.data) })}; }
  });
  HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
`;
const alerts = page => page.messages.filter(m => m.type === 'ALERT');
const show = page => page.w.document.getElementById('presence').classList.remove('invisible');

ui('presence matches real pixels, scales the click once, and resumes after closing', async () => {
  const page = await boot({ scale: 20, preload });
  try {
    await page.ask(START);
    const clicks = [];
    page.w.document.getElementById('presence_image').addEventListener('click', e => clicks.push([e.clientX, e.clientY]));
    show(page);
    assert.ok(await waitFor(() => clicks.length === 1));
    assert.deepEqual(clicks[0], [308, 132]);
    const sent = page.sent.length;
    page.w.document.getElementById('presence').classList.add('other');
    await sleep(100);
    assert.equal(clicks.length, 1);
    assert.equal(page.sent.length, sent);
    page.w.document.getElementById('presence').classList.add('invisible');
    assert.ok(await waitFor(() => page.sent.length > sent));
    assert.equal(alerts(page).length, 0);
  } finally { page.close(); }
});

ui('an unaccepted click times out to the existing stop and alert without retrying', async () => {
  const page = await boot({ scale: 20, preload });
  try {
    let clicks = 0;
    page.w.document.getElementById('presence_image').addEventListener('click', () => clicks++);
    await page.ask(START);
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1, 3000));
    assert.equal(clicks, 1);
    assert.equal(await page.running(), false);
    page.w.document.getElementById('presence').classList.add('invisible');
    const sent = page.sent.length;
    await sleep(100);
    assert.equal(page.sent.length, sent);
  } finally { page.close(); }
});

ui('pixel read failure falls back to the existing alert', async () => {
  const page = await boot({ scale: 20, preload: preload + `
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() { throw new Error('tainted'); } });
  ` });
  try {
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1));
    assert.equal(await page.running(), false);
  } finally { page.close(); }
});

ui('an image with no matching shapes falls back without clicking', async () => {
  const page = await boot({ scale: 20, preload: preload + `
    HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {}, getImageData() {
      return { width: 320, height: 160, data: new Uint8ClampedArray(320 * 160 * 4).fill(240) };
    } });
  ` });
  try {
    let clicks = 0;
    page.w.document.getElementById('presence_image').addEventListener('click', () => clicks++);
    show(page);
    assert.ok(await waitFor(() => alerts(page).length === 1));
    assert.equal(clicks, 0);
  } finally { page.close(); }
});

ui('waits for an image URL, and an orphaned attempt never clicks or alerts', async () => {
  const page = await boot({ scale: 20, preload });
  try {
    const img = page.w.document.getElementById('presence_image');
    img.removeAttribute('src');
    let clicks = 0;
    img.addEventListener('click', () => clicks++);
    show(page);
    await sleep(50);
    assert.equal(alerts(page).length, 0);
    img.src = '/presence';
    assert.ok(await waitFor(() => clicks === 1));
    page.w.chrome.runtime.id = undefined;
    await sleep(600);
    assert.equal(clicks, 1);
    assert.equal(alerts(page).length, 0);
  } finally { page.close(); }
});
