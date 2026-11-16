// Renders the promo video (store-assets/promo/video.html) frame by frame with headless Chrome over the
// DevTools protocol and encodes it with ffmpeg → store-assets/promo/video-silent.mp4 (1920×1080, 30 fps,
// H.264, no audio); scripts/voiceover.js then adds the voiceover → store-assets/promo-video-30s.mp4. The page calls the extension's real chart code and popup CSS, so it is served from a
// throwaway local http server. Needs Node ≥ 22 (global WebSocket), ffmpeg on PATH, and macOS fonts
// (Avenir Next, DIN Alternate) like the promo tiles.
//
//   node scripts/render-video.js             full render
//   node scripts/render-video.js 1.5 8 14    stills at those seconds, for review (printed paths)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { findChrome } = require('./chrome');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'store-assets', 'promo', 'video-silent.mp4');
const W = 1920, H = 1080, FPS = 30, SECONDS = 30;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serve() {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launchChrome(profile) {
  const proc = spawn(findChrome(), [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', `--window-size=${W},${H}`,
    '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await new Promise((r) => setTimeout(r, 100));
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return { proc, wsUrl: targets.find((x) => x.type === 'page').webSocketDebuggerUrl };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const cb = pending.get(msg.id);
    if (!cb) return;
    pending.delete(msg.id);
    msg.error ? cb.reject(new Error(msg.error.message)) : cb.resolve(msg.result);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// seek, then wait for the next paint so the screenshot shows that moment
const frameAt = (t) => `seek(${t.toFixed(4)}); new Promise((r) => requestAnimationFrame(() => r(true)))`;

async function main() {
  const stills = process.argv.slice(2).map(Number);
  const server = await serve();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-video-'));
  const { proc, wsUrl } = await launchChrome(profile);
  const cdp = await connect(wsUrl);
  try {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/store-assets/promo/video.html` });
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      ready = await cdp.evaluate('window.ready ? window.ready : false').catch(() => false);
      if (!ready) await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error('video.html never became ready');

    if (stills.length) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-stills-'));
      for (const t of stills) {
        await cdp.evaluate(frameAt(t));
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const file = path.join(dir, `t${t.toFixed(2)}.png`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
        console.log(file);
      }
      return;
    }

    const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
    const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
    const frames = FPS * SECONDS;
    for (let i = 0; i < frames; i++) {
      await cdp.evaluate(frameAt(i / FPS));
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      if (!ffmpeg.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ffmpeg.stdin.once('drain', r));
      if (i % FPS === 0) process.stdout.write(`\r${i / FPS}s / ${SECONDS}s`);
    }
    ffmpeg.stdin.end();
    await done;
    console.log(`\r${path.relative(ROOT, OUT)} (${W}×${H}, ${FPS} fps, ${SECONDS} s)`);
  } finally {
    cdp.close();
    // Chrome keeps writing to its profile until it has exited: wait for that before deleting it.
    if (proc.exitCode === null) await new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); });
    server.close();
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
