/**
 * Redroid Control Server
 * ----------------------
 * Single-file Node.js server that controls the Android (Redroid) container over ADB:
 * taps, swipes, typing, keys, find-and-tap by text/id, screenshots, app launch/stop,
 * and OTP entry from SMS forwarded by a real phone (webhook).
 *
 * Run on the same VPS as Redroid:  pm2 start server.js --name redroid-control
 */

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

// ============================ CONFIG ============================
const PORT = 3900;
const HOST = '0.0.0.0';
const API_KEY = '76344d7de4bda46b0bea0cf8717088e352e0c1c534474abb'; // openssl rand -hex 24
const ADB = 'adb';
const DEVICE = '127.0.0.1:5555';
const DEFAULT_PACKAGE = '';            // your app's package, e.g. 'com.baybex.gadgetx'
const SCREEN_W = 720;
const SCREEN_H = 1280;
const OTP_REGEX = /\b(\d{4,8})\b/;     // how the OTP is pulled out of an SMS

// Paste through ADB Keyboard (supports Bangla, emoji, any text). Installed into Android automatically.
const USE_ADB_KEYBOARD = true;
const ADB_KEYBOARD_URL = 'https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk';

// Clipboard helper app (android-build/clip-setter). This ROM blocks `cmd clipboard`, so
// the server launches this tiny app to put the OTP on the phone's clipboard, then pastes.
const CLIP_APP = 'com.baybex.clipsetter';
const CLIP_ACTIVITY = CLIP_APP + '/.ClipActivity';

// The number your app's OTP SMS comes from (used to pick the right SMS)
const OTP_SENDER = '01750006696';

// Your app's registration screen. Adjust the selectors to match your app.
// Find the real id / text of each field with:  GET /api/ui
// A selector can be { id: 'etName' } or { text: 'Full name' } or { contains: true, text: 'name' }.
// Registration taps fixed screen coordinates (x,y) captured from GET /api/ui on THIS
// device. If you move to a screen of a different size, recapture and update these.
// NEW flow:
//   mobile field -> type digits -> Next
//   PIN page     -> tap each PIN digit on the on-screen keypad -> Next (requests OTP)
//   OTP page     -> tap each OTP digit on the keypad -> DONE
// All coordinates are device pixels (from GET /api/ui). CHANGE the ones marked.
const REGISTER = {
  // Pages shifted up when the name step was removed:
  mobileXY:     [582, 721],    // mobile field   = old NAME field position
  nextMobileXY: [540, 1102],   // Next (mobile)  = old NAME Next position
  pinXY:        [540, 934],    // PIN field      = old MOBILE field position
  nextPinXY:    [571, 1365],   // Next (pin)     = measured on the real phone
  otpXY:        [247, 1145],   // OTP paste spot — tap here, then paste the copied SMS
  otpNextXY:    [782, 1713],   // Final Submit on the OTP page   (measured on the real phone)
  pageWaitMs:   1800,          // pause after each page change
};

// On-screen numeric keypad. Exact measured center of each digit key (from /tapsfinder,
// tapped on the real phone). Used for both the PIN and the OTP entry.
const KEYPAD = {
  keys: {
    '0': [553, 2286],
    '1': [207, 1732],
    '2': [505, 1781],
    '3': [906, 1746],
    '4': [193, 1933],
    '5': [534, 1949],
    '6': [890, 1939],
    '7': [184, 2116],
    '8': [542, 2099],
    '9': [918, 2094],
  },
  // Fallback 3x4 grid, used only for a key not present in `keys` (e.g. DONE/DEL).
  layout: [['1','2','3'], ['4','5','6'], ['7','8','9'], ['DEL','0','DONE']],
  oneXY:  [207, 1732],
  doneXY: [553, 2286],
  keyDelayMs: 250,       // pause between key taps
};

// Default 4-digit PIN (used when the app/dashboard doesn't send one).
const PIN = '1234';

// Auto-type every incoming SMS OTP (when no "wait-otp" step is waiting for it)
const AUTO_TYPE_SMS_OTP = false;
const OTP_FIELD = null;                // e.g. { id: 'otpInput' } or { text: 'Enter OTP' }; null = currently focused field
const OTP_AUTO_SUBMIT = null;          // e.g. 'ENTER' or { text: 'Verify' }; null = don't submit
// ================================================================

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Timestamped logging so the pm2 log shows everything that happens.
function log(...a) {
  try { console.log(new Date().toISOString().slice(11, 23), ...a); } catch (e) {}
}

// ---------------------------- ADB core ----------------------------
function execAdb(args, { binary = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      ADB,
      args,
      { encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const msg =
            (stderr && stderr.toString().trim()) ||
            (!binary && stdout && stdout.trim()) ||
            err.message;
          return reject(new Error(msg));
        }
        resolve(stdout);
      }
    );
  });
}

let reconnecting = null;
function reconnect() {
  if (!reconnecting) {
    reconnecting = (async () => {
      await execAdb(['disconnect', DEVICE]).catch(() => {});
      await execAdb(['connect', DEVICE]).catch(() => {});
      for (let i = 0; i < 20; i++) {
        const out = await execAdb(['devices']).catch(() => '');
        if (out.split('\n').some((l) => l.startsWith(DEVICE) && /\tdevice\s*$/.test(l))) return;
        await sleep(500);
      }
      throw new Error(`Android device ${DEVICE} is not online (is the redroid container running?)`);
    })().finally(() => {
      reconnecting = null;
    });
  }
  return reconnecting;
}

const CONN_ERR = /not found|offline|no devices|closed|cannot connect|failed to connect|unauthorized/i;

async function adb(args, opts) {
  if (reconnecting) await reconnecting.catch(() => {});
  try {
    return await execAdb(['-s', DEVICE, ...args], opts);
  } catch (e) {
    if (!CONN_ERR.test(e.message)) throw e;
    await reconnect();
    return execAdb(['-s', DEVICE, ...args], opts);
  }
}
// Log every device command except the noisy polling ones (screenshot, ui dump, status).
const NOISY = /screencap|uiautomator|dumpsys window|getprop sys\.boot|settings get secure|pm list packages/;
function shell(cmd, opts) {
  if (!NOISY.test(cmd)) log('adb >', cmd.length > 140 ? cmd.slice(0, 140) + '…' : cmd);
  return adb(['shell', cmd], opts);
}
const screenshot = () => adb(['exec-out', 'screencap -p'], { binary: true });

// ---------------------------- live touch capture (tap the REAL phone) ----------------------------
// Reads the phone's touchscreen with `getevent`, so whenever you physically tap the device
// the (x,y) in screen pixels is captured and served to /tapsfinder. No screenshot needed.
const touch = {
  dev: '',            // /dev/input/eventX of the touchscreen
  maxX: 0, maxY: 0,   // raw digitizer range
  dispW: 0, dispH: 0, // display size in px (what `input tap` uses)
  taps: [],           // { id, x, y, rawX, rawY, t }
  seq: 0,
  proc: null,
  running: false,
  error: '',
  startedAt: 0,
};

function parseWmSize(out) {
  // Prefer "Override size:" then "Physical size:"
  const over = /Override size:\s*(\d+)x(\d+)/.exec(out);
  const phys = /Physical size:\s*(\d+)x(\d+)/.exec(out);
  const m = over || phys;
  return m ? { w: +m[1], h: +m[2] } : null;
}

// Find the touchscreen input device and its raw coordinate range.
async function detectTouch() {
  const lp = await adb(['shell', 'getevent', '-lp']);
  const blocks = lp.split(/add device \d+:\s*/).slice(1);
  let best = null;
  for (const b of blocks) {
    const path = (b.match(/^(\/dev\/input\/event\d+)/) || [])[1];
    if (!path) continue;
    const mtx = /ABS_MT_POSITION_X[^\n]*max\s+(\d+)/.exec(b);
    const mty = /ABS_MT_POSITION_Y[^\n]*max\s+(\d+)/.exec(b);
    const ax = /ABS_X[^\n]*max\s+(\d+)/.exec(b);
    const ay = /ABS_Y[^\n]*max\s+(\d+)/.exec(b);
    if (mtx && mty) { best = { path, maxX: +mtx[1], maxY: +mty[1], mt: true }; break; }
    if (!best && ax && ay) best = { path, maxX: +ax[1], maxY: +ay[1], mt: false };
  }
  if (!best) throw new Error('No touchscreen input device found in `getevent -lp`');

  let disp = null;
  try { disp = parseWmSize(await shell('wm size')); } catch (_) {}
  touch.dev = best.path;
  touch.maxX = best.maxX;
  touch.maxY = best.maxY;
  touch.dispW = disp ? disp.w : (best.maxX + 1);
  touch.dispH = disp ? disp.h : (best.maxY + 1);
  log(`[touch] device=${touch.dev} raw=${touch.maxX}x${touch.maxY} display=${touch.dispW}x${touch.dispH}`);
}

function scaleTap(rawX, rawY) {
  const x = Math.round(rawX * touch.dispW / (touch.maxX || touch.dispW));
  const y = Math.round(rawY * touch.dispH / (touch.maxY || touch.dispH));
  return {
    x: Math.max(0, Math.min(touch.dispW, x)),
    y: Math.max(0, Math.min(touch.dispH, y)),
  };
}

function pushTap(rawX, rawY) {
  const s = scaleTap(rawX, rawY);
  const t = { id: ++touch.seq, x: s.x, y: s.y, rawX, rawY, t: Date.now() };
  touch.taps.push(t);
  if (touch.taps.length > 500) touch.taps.splice(0, touch.taps.length - 500);
  log(`[touch] tap @ ${s.x},${s.y}  (raw ${rawX},${rawY})`);
}

// Stream getevent and emit one tap per finger-up, at the last known position.
function startTouchStream() {
  if (touch.proc) return;
  const args = ['-s', DEVICE, 'shell', 'getevent', '-l', touch.dev];
  const p = spawn(ADB, args);
  touch.proc = p;
  touch.running = true;
  touch.startedAt = Date.now();

  let buf = '';
  let lastX = null, lastY = null;   // most recent coords during the current touch
  let downX = null, downY = null;   // coords captured at finger-down
  let touching = false;

  const liftFinger = () => {
    if (lastX != null && lastY != null) pushTap(lastX, lastY);
    touching = false; lastX = lastY = null;
  };
  const onLine = (line) => {
    // getevent -l lines, e.g.:
    //   "EV_ABS       ABS_MT_POSITION_X    000003c5"   (value is hex)
    //   "EV_KEY       BTN_TOUCH            DOWN"        (value is symbolic)
    const m = /EV_\w+\s+(\w+)\s+(\S+)/.exec(line);
    if (!m) return;
    const code = m[1];
    const raw = m[2];
    const isHex = /^[0-9a-fA-F]+$/.test(raw);
    const num = isHex ? parseInt(raw, 16) : NaN;
    switch (code) {
      case 'ABS_MT_POSITION_X':
      case 'ABS_X':
        lastX = num; touching = true; break;
      case 'ABS_MT_POSITION_Y':
      case 'ABS_Y':
        lastY = num; break;
      case 'ABS_MT_TRACKING_ID':
        if (num === 0xffffffff) liftFinger();   // finger up (type B multitouch)
        else touching = true;
        break;
      case 'BTN_TOUCH':
        if (raw === 'UP' || num === 0) liftFinger();       // finger up (symbolic or hex)
        else { touching = true; downX = lastX; downY = lastY; }
        break;
    }
  };

  p.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try { onLine(line); } catch (_) {}
    }
  });
  p.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) touch.error = s; });
  const done = (why) => {
    if (touch.proc === p) { touch.proc = null; touch.running = false; }
    log('[touch] getevent stream ended: ' + why);
  };
  p.on('error', (e) => { touch.error = e.message; done(e.message); });
  p.on('close', (c) => done('exit ' + c));
}

let touchInit = null;
// Make sure detection + streaming are up. Safe to call repeatedly.
function ensureTouch(force = false) {
  if (force) {
    try { touch.proc && touch.proc.kill(); } catch (_) {}
    touch.proc = null; touch.running = false; touchInit = null;
  }
  if (touch.running && touch.dev) return Promise.resolve();
  if (!touchInit) {
    touchInit = (async () => {
      if (!touch.dev || force) await detectTouch();
      startTouchStream();
      touch.error = '';
    })().catch((e) => { touch.error = e.message; throw e; })
      .finally(() => { touchInit = null; });
  }
  return touchInit;
}

// Keep the stream alive while the device is connected.
setInterval(() => { if (touch.dev && !touch.running) ensureTouch().catch(() => {}); }, 4000);

// One automation job at a time, so steps from two requests never interleave
let jobChain = Promise.resolve();
function exclusive(fn) {
  const p = jobChain.then(fn);
  jobChain = p.catch(() => {});
  return p;
}

// ---------------------------- validation ----------------------------
function num(v, name, max = 10000) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`Invalid ${name}: ${v}`);
  return Math.round(n);
}
function pkgName(p) {
  p = p || DEFAULT_PACKAGE;
  if (!/^[A-Za-z]\w*(\.[A-Za-z_]\w*)+$/.test(p || '')) throw new Error('Invalid or missing package name');
  return p;
}

// ---------------------------- ADB Keyboard (real paste) ----------------------------
const IME_ID = 'com.android.adbkeyboard/.AdbIME';
let kbReady = false;
let kbSetup = null;
let kbFailedAt = 0;
let kbError = '';

function download(url, dest, redirects = 6) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'redroid-control' } }, (r) => {
        if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location && redirects > 0) {
          r.resume();
          return download(new URL(r.headers.location, url).toString(), dest, redirects - 1).then(resolve, reject);
        }
        if (r.statusCode !== 200) {
          r.resume();
          return reject(new Error('Download failed: HTTP ' + r.statusCode));
        }
        const f = fs.createWriteStream(dest);
        r.pipe(f);
        f.on('finish', () => f.close(() => resolve()));
        f.on('error', reject);
      })
      .on('error', reject);
  });
}

async function setupKeyboard() {
  const pk = await shell('pm list packages com.android.adbkeyboard').catch(() => '');
  if (!pk.includes('package:com.android.adbkeyboard')) {
    const apk = path.join(os.tmpdir(), 'ADBKeyboard.apk');
    if (!fs.existsSync(apk) || fs.statSync(apk).size < 10000) {
      console.log('[keyboard] downloading ADB Keyboard...');
      await download(ADB_KEYBOARD_URL, apk);
    }
    console.log('[keyboard] installing into Android...');
    await adb(['install', '-r', apk], { timeout: 120000 });
  }
  await shell(`ime enable ${IME_ID}`);
  await shell(`ime set ${IME_ID}`);
  const cur = (await shell('settings get secure default_input_method')).trim();
  if (cur !== IME_ID) throw new Error('ADB Keyboard could not be activated (current keyboard: ' + cur + ')');
  console.log('[keyboard] ADB Keyboard is active');
}

// true = ADB Keyboard installed and active; false = fall back to plain "input text"
async function ensureKeyboard({ force = false } = {}) {
  if (!USE_ADB_KEYBOARD) return false;
  if (kbReady) {
    const cur = (await shell('settings get secure default_input_method').catch(() => '')).trim();
    if (cur === IME_ID) return true;
    kbReady = false;
  }
  if (!force && kbFailedAt && Date.now() - kbFailedAt < 60000) return false;
  if (!kbSetup) {
    kbSetup = setupKeyboard()
      .then(() => { kbReady = true; kbFailedAt = 0; kbError = ''; return true; })
      .catch((e) => { kbFailedAt = Date.now(); kbError = e.message; console.error('[keyboard]', e.message); return false; })
      .finally(() => { kbSetup = null; });
  }
  return kbSetup;
}

// Paste text into the focused field. Instant, any language.
async function insertText(text) {
  text = String(text ?? '');
  if (!text) return 'nothing';
  if (await ensureKeyboard()) {
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i += 1500) {
      const b64 = Buffer.from(chars.slice(i, i + 1500).join(''), 'utf8').toString('base64');
      await shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
    }
    return 'keyboard';
  }
  await typeText(text);
  return 'input';
}

async function clearField(count = 80) {
  if (await ensureKeyboard()) {
    await shell('am broadcast -a ADB_CLEAR_TEXT');
    return;
  }
  await shell(`input keyevent 123 ${Array(num(count, 'count', 2000)).fill(67).join(' ')}`);
}

// ---------------------------- typing ----------------------------
function escapeForInput(s) {
  return s
    .split('')
    .map((c) => {
      if (c === ' ') return '%s';
      if (/[A-Za-z0-9._,:@/+=-]/.test(c)) return c;
      return '\\' + c;
    })
    .join('');
}

async function typeText(text) {
  text = String(text ?? '');
  if (/[^\x20-\x7E\n]/.test(text)) {
    throw new Error(
      'This text has non-English characters. ADB Keyboard is needed for that' +
        (kbError ? ' (setup failed: ' + kbError + ')' : '')
    );
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j += 200) {
      await shell(`input text ${escapeForInput(line.slice(j, j + 200))}`);
    }
    if (i < lines.length - 1) await shell('input keyevent 66');
  }
}

const KEYS = {
  HOME: 3, BACK: 4, UP: 19, DOWN: 20, LEFT: 21, RIGHT: 22, VOLUME_UP: 24, VOLUME_DOWN: 25,
  POWER: 26, TAB: 61, SPACE: 62, ENTER: 66, DEL: 67, BACKSPACE: 67, MENU: 82, SEARCH: 84,
  ESCAPE: 111, FORWARD_DEL: 112, MOVE_HOME: 122, MOVE_END: 123, APP_SWITCH: 187, RECENTS: 187,
};
function keyCode(k) {
  if (typeof k === 'number' || /^\d+$/.test(String(k))) return num(k, 'key', 400);
  const c = KEYS[String(k).toUpperCase().replace(/^KEYCODE_/, '')];
  if (!c) throw new Error('Unknown key: ' + k);
  return c;
}

// ---------------------------- screen elements ----------------------------
function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

function parseUi(xml) {
  const nodes = [];
  const nodeRe = /<node\s([^>]*?)\/?>/g;
  let m;
  while ((m = nodeRe.exec(xml))) {
    const a = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let x;
    while ((x = attrRe.exec(m[1]))) a[x[1]] = decodeXml(x[2]);
    const b = (a.bounds || '').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    nodes.push({
      text: a.text || '',
      id: a['resource-id'] || '',
      desc: a['content-desc'] || '',
      cls: a.class || '',
      pkg: a.package || '',
      clickable: a.clickable === 'true',
      enabled: a.enabled === 'true',
      focused: a.focused === 'true',
      bounds: [x1, y1, x2, y2],
      x: Math.round((x1 + x2) / 2),
      y: Math.round((y1 + y2) / 2),
    });
  }
  return nodes;
}

async function dumpUi() {
  for (let i = 0; i < 3; i++) {
    const out = await shell(
      'rm -f /sdcard/ui.xml; uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; cat /sdcard/ui.xml 2>/dev/null',
      { timeout: 30000 }
    ).catch(() => '');
    if (out.includes('<hierarchy')) return parseUi(out);
    await sleep(300);
  }
  throw new Error('Could not read the screen layout (uiautomator dump failed)');
}

function matchNode(n, q) {
  const contains = !!q.contains;
  const cmp = (val, want) =>
    contains ? val.toLowerCase().includes(String(want).toLowerCase()) : val === String(want);
  if (q.text !== undefined && !cmp(n.text, q.text)) return false;
  if (q.desc !== undefined && !cmp(n.desc, q.desc)) return false;
  if (q.id !== undefined && !(n.id === q.id || n.id.endsWith(':id/' + q.id))) return false;
  if (q.cls !== undefined && n.cls !== q.cls) return false;
  if (q.text === undefined && q.desc === undefined && q.id === undefined && q.cls === undefined) return false;
  return n.bounds[2] > n.bounds[0] && n.bounds[3] > n.bounds[1];
}

async function findElement(q) {
  const timeout = q.timeout !== undefined ? num(q.timeout, 'timeout', 600000) : 10000;
  const start = Date.now();
  while (true) {
    const nodes = await dumpUi().catch(() => []);
    const hits = nodes.filter((n) => matchNode(n, q));
    if (hits.length) return hits[q.index || 0] || hits[0];
    if (Date.now() - start >= timeout) {
      const { text, id, desc, cls, contains } = q;
      throw new Error('Element not found: ' + JSON.stringify({ text, id, desc, cls, contains }));
    }
    await sleep(400);
  }
}

// Tap an element found by a selector ({id}/{text}/...).
async function tapSelector(sel, timeout = 15000) {
  const el = await findElement({ ...sel, timeout });
  await shell(`input tap ${el.x} ${el.y}`);
  return el;
}

// Type any string as key events (works in numeric fields where IME paste doesn't).
// No stripping, no data-type checks — whatever is given goes on screen.
async function inputChars(text) {
  const t = String(text ?? '');
  if (!t) return '';
  await shell(`input text ${escapeForInput(t)}`);
  return t;
}

// Put text on Android's clipboard. `cmd clipboard` is blocked on this ROM, so we launch
// the Clip Setter helper app (a foreground app IS allowed to set the clipboard). Text is
// passed base64 so the whole SMS (spaces/newlines) survives the shell.
async function setClipboard(text) {
  const t = String(text ?? '');
  const b64 = Buffer.from(t, 'utf8').toString('base64');
  const out = await shell(`am start -n ${CLIP_ACTIVITY} --es b64 ${b64} --activity-no-animation`);
  if (/does not exist|unable to resolve|Error type/i.test(out || '')) {
    throw new Error('Clip Setter app not installed on the phone (install android-build/clip-setter). ' + (out || '').trim());
  }
  return t;
}

// Select all text in the focused field. Ctrl+A on modern Android; falls back to Shift+Home.
async function selectAll() {
  try { await shell('input keycombination 113 29'); return 'ctrl-a'; } catch (_) {}
  await shell('input keyevent 123').catch(() => {});        // MOVE_END
  await shell('input keycombination 59 122').catch(() => {});// SHIFT + MOVE_HOME
  return 'shift-home';
}

// Tap a fixed [x,y] coordinate, with a log line.
async function tapXY(xy, labelStr) {
  log('  tap ' + labelStr + ' (' + xy[0] + ',' + xy[1] + ')');
  await shell(`input tap ${xy[0]} ${xy[1]}`);
}

// Keep only digits (for PIN / OTP typed on the numeric keypad).
function digitsOnly(s) {
  return String(s ?? '').replace(/\D/g, '');
}

// A keypad key's center: use the exact measured map when present, else the computed grid.
function keyXY(k) {
  if (KEYPAD.keys && KEYPAD.keys[k]) return KEYPAD.keys[k];
  const L = KEYPAD.layout, rows = L.length, cols = L[0].length;
  let r = -1, c = -1;
  for (let i = 0; i < rows; i++) {
    const j = L[i].indexOf(k);
    if (j >= 0) { r = i; c = j; break; }
  }
  if (r < 0) throw new Error('key not on keypad: ' + k);
  const [x1, y1] = KEYPAD.oneXY, [x2, y2] = KEYPAD.doneXY;
  const x = x1 + (cols > 1 ? ((x2 - x1) / (cols - 1)) * c : 0);
  const y = y1 + (rows > 1 ? ((y2 - y1) / (rows - 1)) * r : 0);
  return [Math.round(x), Math.round(y)];
}

// Tap a sequence of digits on the on-screen keypad. If submit, tap DONE after.
async function tapPad(str, { submit = false } = {}) {
  const digits = digitsOnly(str);
  for (const ch of digits) {
    const xy = keyXY(ch);
    log('  key ' + ch + ' (' + xy[0] + ',' + xy[1] + ')');
    await shell(`input tap ${xy[0]} ${xy[1]}`);
    await sleep(KEYPAD.keyDelayMs);
  }
  if (submit) {
    const d = keyXY('DONE');
    log('  key DONE (' + d[0] + ',' + d[1] + ')');
    await shell(`input tap ${d[0]} ${d[1]}`);
  }
  return digits;
}

// Armed by the PIN step; the next incoming SMS then types the OTP on the keypad.
let awaitingOtpUntil = 0;
const OTP_ARM_MS = 180000;

async function currentScreen() {
  const out = await shell('dumpsys window | grep -m1 mCurrentFocus').catch(() => '');
  const m = out.match(/\s([\w.]+)\/([\w.$]+)\}/);
  if (m) {
    const activity = m[2].startsWith('.') ? m[1] + m[2] : m[2];
    return { package: m[1], activity, name: activity.split('.').pop() };
  }
  const w = out.match(/\s([^\s}]+)\}/);
  return { package: '', activity: '', name: w ? w[1] : 'Unknown' };
}

// ---------------------------- SMS / OTP ----------------------------
const smsLog = [];
const smsWaiters = new Set();

function extractOtp(message) {
  const m = String(message || '').match(OTP_REGEX);
  return m ? m[1] : null;
}

function smsMatches(s, f) {
  if (s.used) return false;
  if (f.from && !s.from.toLowerCase().includes(String(f.from).toLowerCase())) return false;
  if (f.contains && !s.message.toLowerCase().includes(String(f.contains).toLowerCase())) return false;
  return true;
}

function receiveSms({ from = '', message = '' }) {
  const sms = {
    at: new Date().toISOString(),
    ts: Date.now(),
    from: String(from),
    message: String(message),
    otp: extractOtp(message),
    used: false,
  };
  smsLog.unshift(sms);
  if (smsLog.length > 100) smsLog.pop();

  for (const w of [...smsWaiters]) {
    if (w(sms)) {
      smsWaiters.delete(w);
      break;
    }
  }

  if (!sms.used && AUTO_TYPE_SMS_OTP && sms.otp) {
    sms.used = true;
    exclusive(() =>
      actions.otp({ code: sms.otp, field: OTP_FIELD || undefined, submit: OTP_AUTO_SUBMIT || undefined })
    ).catch((e) => console.error('[auto-otp]', e.message));
  }
  return sms;
}

function waitForSms({ timeout = 120000, from, contains, lookbackMs = 15000 }) {
  const f = { from, contains };
  const recent = smsLog.find((s) => Date.now() - s.ts <= lookbackMs && smsMatches(s, f));
  if (recent) {
    recent.used = true;
    return Promise.resolve(recent);
  }
  return new Promise((resolve, reject) => {
    const w = (s) => {
      if (!smsMatches(s, f)) return false;
      s.used = true;
      clearTimeout(t);
      resolve(s);
      return true;
    };
    const t = setTimeout(() => {
      smsWaiters.delete(w);
      reject(new Error('Timed out waiting for OTP SMS'));
    }, timeout);
    smsWaiters.add(w);
  });
}

async function doSubmit(submit) {
  if (!submit) return;
  if (typeof submit === 'string') return shell(`input keyevent ${keyCode(submit)}`);
  const el = await findElement(submit);
  return shell(`input tap ${el.x} ${el.y}`);
}

// ---------------------------- actions ----------------------------
const actions = {
  tap: async ({ x, y }) => {
    x = num(x, 'x');
    y = num(y, 'y');
    await shell(`input tap ${x} ${y}`);
    return { x, y };
  },

  longpress: async ({ x, y, ms = 800 }) => {
    x = num(x, 'x');
    y = num(y, 'y');
    await shell(`input swipe ${x} ${y} ${x} ${y} ${num(ms, 'ms')}`);
    return { x, y, ms };
  },

  swipe: async ({ x1, y1, x2, y2, ms = 300 }) => {
    await shell(
      `input swipe ${num(x1, 'x1')} ${num(y1, 'y1')} ${num(x2, 'x2')} ${num(y2, 'y2')} ${num(ms, 'ms')}`
    );
    return { x1, y1, x2, y2, ms };
  },

  // direction = which way the content moves into view: 'down' shows content further down
  scroll: async ({ direction = 'down', ms = 350 }) => {
    const cx = Math.round(SCREEN_W / 2);
    const cy = Math.round(SCREEN_H / 2);
    const dy = Math.round(SCREEN_H * 0.3);
    const dx = Math.round(SCREEN_W * 0.35);
    const map = {
      down: [cx, cy + dy, cx, cy - dy],
      up: [cx, cy - dy, cx, cy + dy],
      right: [cx + dx, cy, cx - dx, cy],
      left: [cx - dx, cy, cx + dx, cy],
    };
    const s = map[direction];
    if (!s) throw new Error('direction must be up, down, left or right');
    await shell(`input swipe ${s.join(' ')} ${num(ms, 'ms')}`);
    return { direction };
  },

  // Paste text into the focused field (or into "field" if given). Any language.
  paste: async ({ text, field, clear = false, submit }) => {
    if (field) {
      const el = await findElement(field);
      await shell(`input tap ${el.x} ${el.y}`);
      await sleep(300);
    }
    if (clear) await clearField();
    const via = await insertText(text);
    await doSubmit(submit);
    return { pasted: Array.from(String(text ?? '')).length, via };
  },

  // Same as paste, kept for older scripts
  text: async ({ text }) => {
    const via = await insertText(text);
    return { typed: Array.from(String(text ?? '')).length, via };
  },

  // Paste whatever is in Android's own clipboard
  'paste-clipboard': async () => {
    await shell('input keyevent 279');
    return { pasted: 'clipboard' };
  },

  key: async ({ key }) => {
    await shell(`input keyevent ${keyCode(key)}`);
    return { key };
  },

  clear: async ({ count = 80 }) => {
    await clearField(count);
    return { cleared: true };
  },

  wait: async ({ ms = 1000 }) => {
    await sleep(num(ms, 'ms', 600000));
    return { waited: ms };
  },

  launch: async ({ package: p }) => {
    p = pkgName(p);
    await shell(`monkey -p ${p} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1`);
    return { launched: p };
  },

  stop: async ({ package: p }) => {
    p = pkgName(p);
    await shell(`am force-stop ${p}`);
    return { stopped: p };
  },

  restart: async ({ package: p }) => {
    await actions.stop({ package: p });
    await sleep(500);
    return actions.launch({ package: p });
  },

  find: async (q) => findElement(q),

  'tap-element': async (q) => {
    const el = await findElement(q);
    await shell(`input tap ${el.x} ${el.y}`);
    return el;
  },

  'type-into': async (q) => {
    const el = await findElement(q);
    await shell(`input tap ${el.x} ${el.y}`);
    await sleep(300);
    if (q.clear !== false) await clearField();
    const via = await insertText(q.value);
    await doSubmit(q.submit);
    return { ...el, via };
  },

  otp: async ({ message, code, field, submit, clear = true }) => {
    const otp = code ? String(code) : extractOtp(message);
    if (!otp) throw new Error('No OTP code found in message');
    await actions.paste({ text: otp, field, clear: field ? clear : false, submit });
    return { otp };
  },

  'wait-otp': async ({ timeout = 120000, from, contains, field, submit, lookbackMs }) => {
    const sms = await waitForSms({ timeout: num(timeout, 'timeout', 600000), from, contains, lookbackMs });
    await actions.otp({ code: sms.otp, field, submit });
    return { otp: sms.otp, from: sms.from, at: sms.at };
  },

  'setup-keyboard': async () => {
    const ok = await ensureKeyboard({ force: true });
    if (!ok) throw new Error('ADB Keyboard setup failed: ' + kbError);
    return { keyboard: 'ready' };
  },

  // Full registration (one call): mobile -> Next -> PIN (keypad) -> Next -> wait SMS -> OTP (keypad) -> DONE
  register: async ({ mobile, pin = PIN, otpTimeout = 120000 }) => {
    const R = REGISTER;
    const done = [];
    log('REGISTER start mobile=' + mobile + ' pin=' + pin);

    await tapXY(R.mobileXY, 'mobile field');
    await sleep(400);
    log('  type mobile:', mobile);
    await inputChars(String(mobile ?? ''));
    done.push('mobile entered');
    await tapXY(R.nextMobileXY, 'Next (mobile)');
    await sleep(R.pageWaitMs);

    await tapXY(R.pinXY, 'PIN field');
    await sleep(500);
    log('  tap PIN on keypad:', pin);
    await tapPad(String(pin));
    done.push('pin entered');
    await tapXY(R.nextPinXY, 'Next (pin)');
    done.push('OTP requested');

    log('  waiting for forwarded SMS…');
    const sms = await waitForSms({ timeout: num(otpTimeout, 'otpTimeout', 600000), lookbackMs: 2000 });
    const otp = digitsOnly(sms.message);
    log('  tap OTP on keypad:', otp);
    await sleep(R.pageWaitMs);
    await tapXY(R.otpXY, 'OTP field');
    await sleep(500);
    await tapPad(otp);
    if (R.otpNextXY) { await sleep(400); await tapXY(R.otpNextXY, 'Confirm (otp)'); }
    done.push('OTP ' + otp + ' entered');

    log('REGISTER done:', JSON.stringify(done));
    return { mobile, pin, otp, steps: done };
  },

  // --- step-by-step, driven from the app ---
  // Step 1: tap mobile field, type number, tap Next.
  'reg-mobile': async ({ mobile }) => {
    log('STEP mobile=' + mobile);
    await tapXY(REGISTER.mobileXY, 'mobile field');
    await sleep(400);
    await inputChars(String(mobile ?? ''));
    await tapXY(REGISTER.nextMobileXY, 'Next (mobile)');
    return { step: 'mobile', mobile: String(mobile ?? '') };
  },

  // Step 2: tap the PIN field (shows keypad), tap each PIN digit on the keypad, tap Next.
  'reg-pin': async ({ pin = PIN }) => {
    log('STEP pin=' + pin);
    await tapXY(REGISTER.pinXY, 'PIN field');
    await sleep(500);
    const typed = await tapPad(String(pin));      // taps the digits on the on-screen keypad
    await tapXY(REGISTER.nextPinXY, 'Next (pin)');
    return { step: 'pin', pin: typed };
  },

  // Step 3: typing doesn't register in this OTP field — it needs a real paste (like you do
  // by hand). The ROM blocks `cmd clipboard`, so we put the OTP on the clipboard via the
  // Clip Setter helper app, then tap the field and paste. No final submit tap.
  'reg-otp': async ({ code, message, text }) => {
    const otp = String(code ?? message ?? text ?? '').trim();
    if (!otp) throw new Error('No OTP text sent — paste the OTP in the box first');
    log('STEP otp=' + JSON.stringify(otp) + ' -> set clipboard (helper app), tap field, paste');

    await setClipboard(otp);                 // OTP onto the phone clipboard via the helper app
    await sleep(900);                        // let it set + return focus to the target app
    await tapXY(REGISTER.otpXY, 'OTP field'); // focus the field
    await sleep(400);
    await shell('input keyevent 279');        // KEYCODE_PASTE — same as your manual paste
    return { step: 'otp', otp };
  },

  // Test the keypad: type any digit string on it.
  'keypad': async ({ digits, submit = false }) => ({ typed: await tapPad(digits, { submit }) }),

  'set-clipboard': async ({ text }) => ({ clipboard: await setClipboard(text) }),

  'input-chars': async ({ text, field }) => {
    if (field) {
      const el = await findElement(field);
      await shell(`input tap ${el.x} ${el.y}`);
      await sleep(300);
    }
    return { typed: await inputChars(text) };
  },
};

// ---------------------------- HTTP ----------------------------
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Log every request coming in and its response going out (skip the screenshot polling).
app.use((req, res, next) => {
  if (req.path === '/api/screenshot') return next();
  const t = Date.now();
  log('→', req.method, req.path);
  res.on('finish', () => log('←', res.statusCode, req.path, Date.now() - t + 'ms'));
  next();
});

function auth(req, res, next) {
  const key = String(req.get('x-api-key') || req.query.key || '');
  const a = Buffer.from(key);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => res.type('html').send(DASHBOARD_HTML));
app.get('/flow', (req, res) => res.type('html').send(FLOW_HTML));
app.get('/tapsfinder', (req, res) => res.type('html').send(FINDER_HTML));
app.use('/api', auth);

app.get('/api/status', async (req, res) => {
  try {
    const boot = (await shell('getprop sys.boot_completed')).trim();
    const screen = await currentScreen();
    res.json({
      ok: true,
      device: DEVICE,
      booted: boot === '1',
      screen,
      keyboard: kbReady ? 'ready' : kbSetup ? 'installing' : kbError ? 'failed' : 'not set up',
      keyboardError: kbError || undefined,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/screen', async (req, res) => {
  try {
    res.json({ ok: true, ...(await currentScreen()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/apps', async (req, res) => {
  try {
    const out = await shell('pm list packages -3');
    const apps = out
      .split('\n')
      .map((l) => l.replace('package:', '').trim())
      .filter((p) => p && p !== 'com.android.adbkeyboard')
      .sort();
    res.json({ ok: true, apps, default: DEFAULT_PACKAGE || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/screenshot', async (req, res) => {
  try {
    const png = await screenshot();
    res.set('Cache-Control', 'no-store').type('png').send(png);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Live taps captured from the REAL phone's touchscreen (for /tapsfinder).
app.get('/api/taps', async (req, res) => {
  try { await ensureTouch(); } catch (_) {}
  const since = Number(req.query.since) || 0;
  const taps = touch.taps.filter((t) => t.id > since);
  res.json({
    ok: touch.running,
    connected: touch.running,
    device: touch.dev,
    display: { w: touch.dispW, h: touch.dispH },
    raw: { x: touch.maxX, y: touch.maxY },
    error: touch.error || '',
    last: touch.seq,
    taps,
  });
});

// Force re-detect the touchscreen / restart the stream (after reconnecting the phone).
app.post('/api/taps/redetect', async (req, res) => {
  try { await ensureTouch(true); res.json({ ok: true, device: touch.dev, display: { w: touch.dispW, h: touch.dispH } }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Clear the server-side tap buffer.
app.post('/api/taps/clear', (req, res) => { touch.taps = []; res.json({ ok: true }); });

app.get('/api/ui', async (req, res) => {
  try {
    let nodes = await dumpUi();
    if (!req.query.all) nodes = nodes.filter((n) => n.text || n.desc || n.clickable || n.id);
    res.json({ ok: true, count: nodes.length, nodes });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SMS webhook (from an SMS-forwarder app on the phone with the SIM)
app.post('/api/sms', (req, res) => {
  const b = req.body || {};
  const message = b.message ?? b.text ?? b.body ?? b.msg ?? b.content ?? '';
  const from = b.from ?? b.sender ?? b.phone ?? b.number ?? '';
  if (!String(message).trim()) return res.status(400).json({ ok: false, error: 'Empty message' });
  const sms = receiveSms({ from, message });
  log('[sms] from=' + (sms.from || '?') + ' body=' + JSON.stringify(sms.message));
  const otp = digitsOnly(sms.message);

  if (awaitingOtpUntil && Date.now() < awaitingOtpUntil) {
    // Armed by the PIN step: type the OTP digits on the keypad, then DONE.
    awaitingOtpUntil = 0;
    log('  auto-OTP: typing ' + otp + ' on the keypad');
    exclusive(async () => {
      await sleep(600);
      await tapPad(otp, { submit: true });
      log('  auto-OTP done');
    }).catch((e) => log('  auto-OTP failed: ' + e.message));
    return res.json({ ok: true, otp, autoOtp: true });
  }

  res.json({ ok: true, otp, autoOtp: false });
});

app.get('/api/sms', (req, res) => {
  res.json({ ok: true, sms: smsLog.slice(0, 20).map(({ ts, ...s }) => s) });
});

// Run a list of steps in order, e.g. { "steps": [ { "action": "tap-element", "text": "Login" }, ... ] }
app.post('/api/run', async (req, res) => {
  const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;
  if (!steps || !steps.length) return res.status(400).json({ ok: false, error: 'Body must be { steps: [...] }' });
  const started = Date.now();
  const out = await exclusive(async () => {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const fn = actions[step.action];
      if (!fn) return { ok: false, failedStep: i, error: 'Unknown action: ' + step.action, results };
      try {
        results.push({ step: i, action: step.action, result: await fn(step) });
      } catch (e) {
        if (step.optional) {
          results.push({ step: i, action: step.action, skipped: true, error: e.message });
          continue;
        }
        return { ok: false, failedStep: i, action: step.action, error: e.message, results };
      }
    }
    return { ok: true, results };
  });
  out.ms = Date.now() - started;
  res.status(out.ok ? 200 : 500).json(out);
});

// Single action: POST /api/tap  { "x": 100, "y": 200 }
app.post('/api/:action', async (req, res) => {
  const fn = actions[req.params.action];
  if (!fn) {
    return res.status(404).json({ ok: false, error: 'Unknown action: ' + req.params.action, actions: Object.keys(actions) });
  }
  try {
    const result = await exclusive(() => fn(req.body || {}));
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------- dashboard ----------------------------
const DASHBOARD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Redroid Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --desk:#D9DEE3;--panel:#F4F6F8;--ink:#1A2129;--muted:#5C6872;--line:#C3CCD4;
  --field:#FFFFFF;--accent:#1F5FBF;--accent-soft:#E3ECF9;--ok:#1E7F4F;--err:#B23A2C;
  --frame:#11161B;--navbar:#0C1014;--navkey:#C7D0D8;
}
@media(prefers-color-scheme:dark){:root{
  --desk:#161B20;--panel:#222A31;--ink:#E6EAEE;--muted:#98A3AD;--line:#333D46;
  --field:#1A2127;--accent:#6CA0EA;--accent-soft:#223449;--ok:#54B98A;--err:#E07B6C;
  --frame:#05080B;--navbar:#05080B;--navkey:#8A95A0;
}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--desk);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:560px;margin:0 auto;padding:26px 18px 48px;display:block}
@media(max-width:760px){.wrap{grid-template-columns:1fr;justify-items:center}}

/* ---- phone ---- */
.stage{display:flex;flex-direction:column;align-items:center;gap:12px}
.where{font-family:"IBM Plex Mono",monospace;font-size:13px;color:var(--muted);text-align:center;min-height:19px}
.where b{color:var(--ink);font-weight:500}
.phone{width:300px;background:var(--frame);border-radius:30px;padding:12px 12px 0;box-shadow:0 20px 50px -24px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.04) inset}
.screen-hold{position:relative;border-radius:19px;overflow:hidden;background:#000;aspect-ratio:${SCREEN_W}/${SCREEN_H}}
#screen{display:block;width:100%;height:100%;object-fit:fill;cursor:crosshair;user-select:none;-webkit-user-drag:none}
#veil{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:24px;color:#8b96a0;font-size:13px;background:#0b0f13}
#veil.hide{display:none}
/* on-phone nav bar, sits directly under the screen like a real device */
.navbar{display:flex;justify-content:space-around;align-items:center;height:46px;background:var(--navbar)}
.navkey{flex:1;height:100%;background:none;border:0;cursor:pointer;color:var(--navkey);display:grid;place-items:center}
.navkey:hover{background:rgba(255,255,255,.06)}
.navkey:active{background:rgba(255,255,255,.12)}
.navkey svg{width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
.navkey.back svg{fill:currentColor;stroke:none}

/* ---- control panel ---- */
.panel{width:100%;max-width:440px;display:flex;flex-direction:column;gap:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.card h2{margin:0 0 12px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:600}
.key-row{display:flex;gap:8px}
input[type=text],input[type=password],select,textarea{width:100%;background:var(--field);border:1px solid var(--line);border-radius:9px;padding:9px 11px}
textarea{resize:vertical;min-height:52px}
.stack{display:flex;flex-direction:column;gap:9px}
.inline{display:flex;gap:8px}
.inline>*{flex:1}
.btn{background:var(--field);border:1px solid var(--line);border-radius:9px;padding:9px 12px;cursor:pointer;font-weight:500;white-space:nowrap}
.btn:hover{border-color:var(--accent)}
.btn:active{transform:translateY(1px)}
.btn.go{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.go:hover{filter:brightness(1.07)}
.btn.grow{flex:1}
.hint{font-size:12.5px;color:var(--muted);margin:2px 0 0}
.chip{font-family:"IBM Plex Mono",monospace;font-size:11.5px;padding:2px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.chip.on{color:var(--ok);border-color:var(--ok)}
.chip.off{color:var(--err);border-color:var(--err)}
.kbrow{display:flex;align-items:center;gap:8px;justify-content:space-between}
#log{font-family:"IBM Plex Mono",monospace;font-size:11.5px;line-height:1.6;background:var(--field);border:1px solid var(--line);border-radius:9px;padding:9px;height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.log-ok{color:var(--ok)}.log-err{color:var(--err)}
</style></head><body>
<div class="wrap">
  <div class="panel">
    <div class="card">
      <h2>Device navigation</h2>
      <div class="where" id="where" style="margin-bottom:10px">&mdash;</div>
      <div class="inline">
        <button class="btn grow" onclick="key('BACK')">&larr; Back</button>
        <button class="btn grow" onclick="key('HOME')">Home</button>
        <button class="btn grow" onclick="key('APP_SWITCH')">Recents</button>
      </div>
    </div>
    <div class="card">
      <h2>Connection</h2>
      <div class="key-row">
        <input id="key" type="password" placeholder="API key" autocomplete="off">
        <button class="btn go" onclick="saveKey()">Connect</button>
      </div>
    </div>

    <div class="card">
      <div class="kbrow"><h2 style="margin:0">Paste text into the focused field</h2><span class="chip" id="kb">keyboard&nbsp;?</span></div>
      <div class="stack" style="margin-top:12px">
        <textarea id="text" placeholder="Type or paste here — Bangla, emoji, anything. Tap the app field first, then Paste."></textarea>
        <div class="inline">
          <button class="btn go grow" onclick="sendText()">Paste</button>
          <button class="btn" onclick="call('clear',{})">Clear field</button>
          <button class="btn" onclick="key('ENTER')">Enter</button>
        </div>
        <p class="hint">First Paste installs a helper keyboard into Android (a few seconds, once).</p>
      </div>
    </div>

    <div class="card">
      <h2>OTP</h2>
      <div class="inline">
        <input id="otp" type="text" placeholder="Paste the SMS text or just the code">
        <button class="btn go" onclick="sendOtp()">Fill OTP</button>
      </div>
      <p class="hint">Forwarded SMS also arrive automatically at /api/sms.</p>
    </div>

    <div class="card">
      <h2>App</h2>
      <div class="stack">
        <select id="pkg"><option value="">Loading installed apps…</option></select>
        <div class="inline">
          <button class="btn go grow" onclick="app('launch')">Launch</button>
          <button class="btn" onclick="app('restart')">Restart</button>
          <button class="btn" onclick="app('stop')">Stop</button>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Register &mdash; step by step</h2>
      <div class="stack">
        <div class="inline"><input id="rmobile" type="text" placeholder="Mobile number"><button class="btn go" onclick="regMobile()">1 &middot; Mobile &rarr; Next</button></div>
        <div class="inline"><input id="rpin" type="text" placeholder="4-digit PIN" maxlength="8"><button class="btn go" onclick="regPin()">2 &middot; PIN &rarr; Next</button></div>
        <p class="hint">PIN is tapped on the keypad. "PIN &rarr; Next" arms auto-OTP &mdash; the next SMS is typed on the keypad + DONE automatically.</p>
      </div>
    </div>

    <div class="card">
      <h2>Tap test &mdash; click each to check it lands</h2>
      <div class="row" id="taps"></div>
    </div>

    <div class="card">
      <h2>Keypad test</h2>
      <div class="stack">
        <div class="inline">
          <input id="kp" type="text" placeholder="Digits, e.g. 1234" maxlength="10">
          <button class="btn go" onclick="call('keypad',{digits:$('kp').value})">Type on keypad</button>
          <button class="btn" onclick="call('keypad',{digits:$('kp').value,submit:true})">+ DONE</button>
        </div>
        <div class="inline">
          <button class="btn" onclick="tapKey('oneXY')">Tap "1"</button>
          <button class="btn" onclick="tapKey('doneXY')">Tap "DONE"</button>
        </div>
        <p class="hint">Use "Tap 1" and "Tap DONE" to confirm the two keypad corners are right; every other key is computed from them.</p>
      </div>
    </div>

    <div class="card">
      <h2>Activity</h2>
      <div id="log"></div>
    </div>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
let K=localStorage.getItem('rk')||'${API_KEY}';$('key').value=K;
function saveKey(){K=$('key').value.trim();localStorage.setItem('rk',K);status();loadApps();}
function log(m,cls){const l=$('log');const s=document.createElement('div');if(cls)s.className=cls;s.textContent=new Date().toLocaleTimeString()+'  '+m;l.prepend(s);while(l.childElementCount>60)l.lastChild.remove();}
async function call(a,b){
  if(!K){log('connect first','log-err');return;}
  try{
    const r=await fetch('/api/'+a,{method:'POST',headers:{'content-type':'application/json','x-api-key':K},body:JSON.stringify(b||{})});
    const j=await r.json();
    log(a+' '+(j.ok?'ok '+JSON.stringify(j.result):'ERROR '+j.error),j.ok?'log-ok':'log-err');
    setTimeout(status,300);return j;
  }catch(e){log(a+' ERROR '+e.message,'log-err');}
}
async function status(){
  if(!K)return;
  try{
    const j=await (await fetch('/api/status',{headers:{'x-api-key':K}})).json();
    if(!j.ok)return;
    $('where').innerHTML=j.screen&&j.screen.name?('on <b>'+j.screen.name+'</b> &middot; '+(j.screen.package||'')):'&mdash;';
    const kb=$('kb');kb.className='chip '+(j.keyboard==='ready'?'on':j.keyboard==='failed'?'off':'');
    kb.textContent='keyboard '+j.keyboard;
  }catch(e){}
}
async function loadApps(){
  if(!K)return;
  try{
    const j=await (await fetch('/api/apps',{headers:{'x-api-key':K}})).json();
    if(!j.ok)return;
    const sel=$('pkg');const saved=localStorage.getItem('rpkg')||j.default||'';
    sel.innerHTML='';
    if(!j.apps.length)sel.innerHTML='<option value="">no user apps found</option>';
    for(const p of j.apps){const o=document.createElement('option');o.value=p;o.textContent=p;if(p===saved)o.selected=true;sel.appendChild(o);}
  }catch(e){}
}
function key(k){call('key',{key:k});}
function sendText(){const t=$('text').value;if(t==='')return;call('paste',{text:t});}
function sendOtp(){const v=$('otp').value.trim();if(!v)return;call('otp',/^\\d{4,8}$/.test(v)?{code:v}:{message:v});}
function app(a){const p=$('pkg').value;localStorage.setItem('rpkg',p);call(a,{package:p});}
function regMobile(){call('reg-mobile',{mobile:$('rmobile').value.trim()});}
function regPin(){call('reg-pin',{pin:$('rpin').value.trim()});}
// Tap-test buttons, built from the server's REGISTER coordinates + keypad corners.
const COORDS=${JSON.stringify(REGISTER)};
const KPAD=${JSON.stringify(KEYPAD)};
const TAPLABELS={mobileXY:'Mobile field',nextMobileXY:'Next (mobile)',pinXY:'PIN field',nextPinXY:'Next (pin)',otpXY:'OTP field',otpNextXY:'Confirm (otp)'};
(function(){const box=$('taps');for(const k in TAPLABELS){const xy=COORDS[k];if(!xy)continue;const b=document.createElement('button');b.className='btn';b.textContent=TAPLABELS[k]+' ('+xy[0]+','+xy[1]+')';b.onclick=()=>call('tap',{x:xy[0],y:xy[1]});box.appendChild(b);}})();
function tapKey(c){const xy=KPAD[c];if(xy)call('tap',{x:xy[0],y:xy[1]});}
if(K){loadApps();}
setInterval(status,2500);
status();
</script></body></html>`;

// ---------------------------- /flow wizard ----------------------------
const FLOW_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GadgetX Flow</title>
<style>
:root{--bg:#0f1419;--card:#1a212a;--ink:#e6eaee;--muted:#8a95a0;--line:#2a333d;--accent:#2f6fed;--ok:#38b06e;--err:#e06b5c;--field:#0f151b}
@media(prefers-color-scheme:light){:root{--bg:#eef1f4;--card:#fff;--ink:#1a2129;--muted:#5c6872;--line:#d6dce2;--accent:#1f5fbf;--ok:#1e7f4f;--err:#b23a2c;--field:#fff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
.wrap{max-width:460px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:20px;margin:0 0 4px}.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:14px}
.card.done{opacity:.6}.card.locked{opacity:.4;pointer-events:none}
.step{font-size:12px;color:var(--muted);letter-spacing:.04em;text-transform:uppercase;margin-bottom:8px}
input{width:100%;background:var(--field);border:1px solid var(--line);border-radius:9px;padding:11px;color:inherit;font:inherit;margin-bottom:10px}
button{width:100%;background:var(--accent);color:#fff;border:0;border-radius:9px;padding:12px;font:inherit;font-weight:600;cursor:pointer}
button:disabled{opacity:.5;cursor:default}
.msg{font-size:13px;margin-top:8px;min-height:18px;white-space:pre-wrap;word-break:break-word}
.hint{font-size:13px;color:var(--muted);margin:0 0 10px}
.ok{color:var(--ok)}.err{color:var(--err)}
#shot{width:100%;border:1px solid var(--line);border-radius:12px;margin-top:8px;display:none}
</style></head><body>
<div class="wrap">
  <h1>GadgetX Flow</h1>
  <p class="sub">One step at a time. Each unlocks after the one before it succeeds.</p>

  <div class="msg" id="m0" style="margin-bottom:14px"></div>

  <div class="card" id="c1">
    <div class="step">Step 1 — Mobile</div>
    <input id="mobile" type="text" placeholder="Mobile number" inputmode="numeric">
    <button id="b1" onclick="doStep(1,'/api/reg-mobile',()=>({mobile:v('mobile')}))">Mobile &rarr; Next</button>
    <div class="msg" id="m1"></div>
  </div>

  <div class="card locked" id="c2">
    <div class="step">Step 2 — PIN</div>
    <input id="pin" type="text" placeholder="4-digit PIN" inputmode="numeric" maxlength="8">
    <button id="b2" onclick="doStep(2,'/api/reg-pin',()=>({pin:v('pin')}))">PIN &rarr; Next</button>
    <div class="msg" id="m2"></div>
  </div>

  <div class="card locked" id="c3">
    <div class="step">Step 3 — OTP</div>
    <p class="hint">Paste the OTP (or the whole SMS) in the box and submit. The server puts it on the phone's clipboard, taps Paste, and submits. Your place is saved if you switch apps.</p>
    <input id="otp" type="text" placeholder="Paste the OTP / SMS here" inputmode="text">
    <button id="b3" onclick="doStep(3,'/api/reg-otp',()=>({code:v('otp')}))">Submit OTP</button>
    <div class="msg" id="m3"></div>
  </div>

  <button onclick="startOver()" style="background:none;border:1px solid var(--line);color:var(--muted);font-weight:500;margin-top:4px">Start over (new registration)</button>
</div>
<script>
var K='${API_KEY}';
var SKEY='gxflow';            // saved wizard progress (survives tab reloads when app-switching)
function $(i){return document.getElementById(i)}
function v(i){return $(i).value.trim()}
function unlock(n){$('c'+n).classList.remove('locked')}
function lock(n){$('c'+n).classList.add('locked')}

// ---- persistence: remember the step + entered values so switching to the SMS app
//      and coming back doesn't throw us back to step 1 ----
function loadState(){try{return JSON.parse(localStorage.getItem(SKEY))||{}}catch(_){return{}}}
function saveState(s){try{localStorage.setItem(SKEY,JSON.stringify(s))}catch(_){}}
function resetState(){try{localStorage.removeItem(SKEY)}catch(_){}}

function restore(){
  const s=loadState();
  if(s.mobile)$('mobile').value=s.mobile;
  if(s.pin)$('pin').value=s.pin;
  const step=s.step||1;
  if(s.done&&s.done[1]){$('c1').classList.add('done');}
  if(s.done&&s.done[2]){$('c2').classList.add('done');}
  if(step>=2)unlock(2);
  if(step>=3)unlock(3);
  if(step>1){
    // jump straight to where we left off (the OTP step after an app-switch)
    const card=$('c'+step);
    if(card){card.scrollIntoView({block:'center'});}
    if(step===3)$('m3').innerHTML='<span class=ok>Back on the OTP step. Paste the OTP/SMS below and submit.</span>';
  }
}

async function connect(){
  try{
    const r=await fetch('/api/status',{headers:{'x-api-key':K}});
    const j=await r.json();
    if(!j.ok){$('m0').innerHTML='<span class=err>'+ (j.error||'not connected') +'</span>';return}
    $('m0').innerHTML='<span class=ok>Device connected'+(j.screen&&j.screen.name?(' — on '+j.screen.name):'')+'</span>';
  }catch(e){$('m0').innerHTML='<span class=err>'+e.message+'</span>'}
}
async function doStep(n,path,body){
  const btn=$('b'+n),m=$('m'+n);
  btn.disabled=true;m.textContent='Working…';
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-api-key':K},body:JSON.stringify(body())});
    const j=await r.json();
    if(j.ok){
      m.innerHTML='<span class=ok>&#10003; '+JSON.stringify(j.result)+'</span>';
      $('c'+n).classList.add('done');
      const s=loadState();s.done=s.done||{};s.done[n]=true;
      if(n===1)s.mobile=v('mobile');
      if(n===2)s.pin=v('pin');
      if(n<3){unlock(n+1);s.step=n+1;saveState(s);}
      else{s.step=3;saveState(s);m.innerHTML='<span class=ok>&#10003; OTP submitted</span>';}
    }else{
      m.innerHTML='<span class=err>&#10007; '+(j.error||'failed')+'</span>';btn.disabled=false;
    }
  }catch(e){m.innerHTML='<span class=err>'+e.message+'</span>';btn.disabled=false;}
}
function startOver(){resetState();location.reload();}

restore();
connect();
// If the tab was restored from the mobile bfcache after an app-switch, re-apply our place.
window.addEventListener('pageshow',function(e){if(e.persisted)restore();});
document.addEventListener('visibilitychange',function(){if(!document.hidden){restore();connect();}});
</script></body></html>`;

// ---------------------------- /tapsfinder ----------------------------
const FINDER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Taps Finder</title>
<style>
:root{--bg:#0f1419;--panel:#1a212a;--ink:#e6eaee;--muted:#8a95a0;--line:#2a333d;--accent:#2f6fed;--ok:#38b06e;--bad:#e5534b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif;display:flex;justify-content:center;padding:18px}
.wrap{width:100%;max-width:560px;display:flex;flex-direction:column;gap:12px}
h1{font-size:18px;margin:0}.sub{color:var(--muted);font-size:13px;margin:0}
.status{font-size:13px;padding:9px 12px;border-radius:9px;border:1px solid var(--line);background:var(--panel)}
.status.ok{border-color:var(--ok);color:var(--ok)}.status.bad{border-color:var(--bad);color:var(--bad)}
.big{font:700 34px/1.1 monospace;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px;text-align:center}
.big small{display:block;color:var(--muted);font:500 12px system-ui;margin-top:6px}
.row{display:flex;gap:8px;flex-wrap:wrap}
button{background:var(--panel);border:1px solid var(--line);color:inherit;border-radius:9px;padding:9px 12px;cursor:pointer;font:inherit}
button:hover{border-color:var(--accent)}
#list{list-style:none;margin:0;padding:0;max-height:55vh;overflow:auto}
#list li{display:flex;justify-content:space-between;align-items:center;gap:8px;font:14px monospace;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:9px 12px;margin-bottom:7px}
#list li.new{border-color:var(--ok)}
#list .n{color:var(--muted);font-size:12px}
#list .act{display:flex;gap:10px}
#list .copy,#list .tap{cursor:pointer;color:var(--accent)}
.empty{color:var(--muted);font-size:13px;text-align:center;padding:18px}
</style></head><body>
<div class="wrap">
  <h1>Taps Finder</h1>
  <p class="sub">Tap anywhere on the <b>real phone</b> — the X,Y shows up here. No screen preview needed.</p>
  <div class="status" id="status">Connecting…</div>
  <div class="big" id="cur">— , —<small>last tap on the phone</small></div>
  <div class="row">
    <button onclick="redetect()">Re-detect phone</button>
    <button onclick="clearList()">Clear list</button>
  </div>
  <ul id="list"><li class="empty" id="empty">No taps yet. Tap the phone screen.</li></ul>
</div>
<script>
const K='${API_KEY}';
const H={'x-api-key':K};
const cur=document.getElementById('cur'),list=document.getElementById('list'),statusEl=document.getElementById('status');
let since=0;

function setStatus(t,cls){statusEl.textContent=t;statusEl.className='status'+(cls?' '+cls:'');}
function copy(s){try{navigator.clipboard.writeText(s);}catch(_){}}

function addTap(t){
  const empty=document.getElementById('empty'); if(empty)empty.remove();
  const xy='['+t.x+', '+t.y+']';
  const li=document.createElement('li');li.className='new';
  li.innerHTML='<span class=xy>'+xy+'</span><span class=act><span class=n>raw '+t.rawX+','+t.rawY+'</span><span class=copy>copy</span><span class=tap>re-tap</span></span>';
  li.querySelector('.copy').onclick=()=>{copy(xy);li.querySelector('.copy').textContent='copied';setTimeout(()=>li.querySelector('.copy').textContent='copy',900);};
  li.querySelector('.tap').onclick=()=>retap(t.x,t.y);
  list.prepend(li);
  while(list.childElementCount>200)list.lastChild.remove();
  cur.innerHTML=t.x+' , '+t.y+'<small>last tap on the phone — copied to clipboard</small>';
  copy(xy);                          // newest tap is always on the clipboard
  setTimeout(()=>li.classList.remove('new'),1200);
}

async function retap(x,y){
  try{await fetch('/api/tap',{method:'POST',headers:{'content-type':'application/json',...H},body:JSON.stringify({x,y})});}catch(_){}
}
function clearList(){
  list.innerHTML='<li class="empty" id="empty">No taps yet. Tap the phone screen.</li>';
  fetch('/api/taps/clear',{method:'POST',headers:H}).catch(()=>{});
}
async function redetect(){
  setStatus('Re-detecting touchscreen…');
  try{const r=await fetch('/api/taps/redetect',{method:'POST',headers:H});const j=await r.json();
    if(j.ok)setStatus('Re-detected — '+j.device+'  ('+j.display.w+'×'+j.display.h+')','ok');
    else setStatus('Re-detect failed: '+(j.error||'?'),'bad');}
  catch(e){setStatus('Re-detect failed: '+(e.message||e),'bad');}
}

let busy=false;
async function poll(){
  if(busy)return;busy=true;
  try{
    const r=await fetch('/api/taps?since='+since,{headers:H,cache:'no-store'});
    const j=await r.json();
    if(j.connected){
      setStatus('Listening — '+j.device+'  (display '+j.display.w+'×'+j.display.h+', raw '+j.raw.x+'×'+j.raw.y+'). Tap the phone.','ok');
    }else{
      setStatus('Touch stream not running'+(j.error?' — '+j.error:'')+'. Phone connected? Then Re-detect.','bad');
    }
    if(j.taps&&j.taps.length){ for(const t of j.taps){addTap(t);since=t.id;} }
    else if(typeof j.last==='number' && j.last>since && !j.taps.length){ since=j.last; }
  }catch(e){ setStatus('Server unreachable: '+(e.message||e),'bad'); }
  finally{busy=false;}
}
setInterval(()=>{if(!document.hidden)poll();},700);
poll();
</script></body></html>`;

// ---------------------------- start ----------------------------
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && e.message));

app.listen(PORT, HOST, async () => {
  console.log(`Redroid control server on http://${HOST}:${PORT}`);
  if (API_KEY.startsWith('CHANGE_THIS')) console.warn('!! Set API_KEY in server.js before exposing this server !!');
  try {
    await reconnect();
    console.log(`Connected to Android at ${DEVICE}`);
  } catch (e) {
    console.error(e.message);
  }
});
