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
const { execFile } = require('child_process');

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

// The number your app's OTP SMS comes from (used to pick the right SMS)
const OTP_SENDER = '01750006696';

// Your app's registration screen. Adjust the selectors to match your app.
// Find the real id / text of each field with:  GET /api/ui
// A selector can be { id: 'etName' } or { text: 'Full name' } or { contains: true, text: 'name' }.
// Registration taps fixed screen coordinates (x,y) captured from GET /api/ui on THIS
// device. If you move to a screen of a different size, recapture and update these.
//   page 1: name field -> paste name -> Next
//   page 2: mobile field -> type digits -> Next (this sends the OTP)
//   page 3: Paste button (reads clipboard) -> Confirm
const REGISTER = {
  nameXY:    [582, 721],    // name input
  next1XY:   [540, 1102],   // Next on page 1
  mobileXY:  [540, 934],    // mobile input
  next2XY:   [540, 1366],   // Next on page 2 (requests OTP)
  pasteXY:   [540, 1395],   // the app's Paste button on the OTP page
  confirmXY: [814, 1592],   // the Confirm button
  pageWaitMs: 1800,         // pause after each page change
};

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

// Put text on Android's clipboard, so an in-app "Paste" button can read it.
async function setClipboard(text) {
  const t = String(text);
  const arg = /^[0-9]+$/.test(t) ? t : JSON.stringify(t);
  await shell(`cmd clipboard set-primary-text ${arg}`);
  return t;
}

// Tap a fixed [x,y] coordinate, with a log line.
async function tapXY(xy, labelStr) {
  log('  tap ' + labelStr + ' (' + xy[0] + ',' + xy[1] + ')');
  await shell(`input tap ${xy[0]} ${xy[1]}`);
}

// When the mobile step runs it "arms" this; the next incoming SMS then auto-completes
// the OTP page (clipboard -> Paste -> Confirm). 0 = not armed.
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

  // Coordinate-based registration: taps fixed (x,y) on each page. Logs every step.
  // No type checking — name and mobile are taken as-is, any string. Never reopens the app.
  register: async ({ name, mobile, otpTimeout = 120000 }) => {
    const R = REGISTER;
    const done = [];
    const tap = async (xy, labelStr) => {
      log('  tap', labelStr, '(' + xy[0] + ',' + xy[1] + ')');
      await shell(`input tap ${xy[0]} ${xy[1]}`);
    };

    log('REGISTER start name=' + JSON.stringify(name) + ' mobile=' + mobile);

    // Page 1 — name
    await tap(R.nameXY, 'name field');
    await sleep(400);
    log('  paste name:', name);
    await insertText(name || '');
    done.push('name entered');
    await tap(R.next1XY, 'Next (1)');
    await sleep(R.pageWaitMs);

    // Page 2 — mobile (digits injected as key events)
    await tap(R.mobileXY, 'mobile field');
    await sleep(400);
    log('  type mobile:', mobile);
    await inputChars(String(mobile ?? ''));
    done.push('mobile entered');
    await tap(R.next2XY, 'Next (2) — requests OTP');
    done.push('OTP requested');

    // Wait for a freshly-forwarded SMS (any number) and use the WHOLE message (no regex)
    log('  waiting for forwarded SMS…');
    const sms = await waitForSms({ timeout: num(otpTimeout, 'otpTimeout', 600000), lookbackMs: 2000 });
    const code = String(sms.message).trim();
    log('  SMS received -> clipboard:', JSON.stringify(code));
    await setClipboard(code);
    done.push('SMS on clipboard');
    await sleep(R.pageWaitMs);

    // Page 3 — tap the app's Paste button, then Confirm
    await tap(R.pasteXY, 'Paste button');
    await sleep(700);
    await tap(R.confirmXY, 'Confirm');
    done.push('confirmed');

    log('REGISTER done:', JSON.stringify(done));
    return { name, mobile, sms: sms.message, steps: done };
  },

  // --- step-by-step, driven from the app ---
  // Step 1: tap name field, paste name, tap Next.
  'reg-name': async ({ name }) => {
    log('STEP name=' + JSON.stringify(name));
    await tapXY(REGISTER.nameXY, 'name field');
    await sleep(400);
    await insertText(name || '');
    await tapXY(REGISTER.next1XY, 'Next (1)');
    return { step: 'name', name: name || '' };
  },

  // Step 2: tap mobile field, type number, tap Next (requests OTP), then ARM auto-OTP.
  'reg-mobile': async ({ mobile }) => {
    log('STEP mobile=' + mobile);
    await tapXY(REGISTER.mobileXY, 'mobile field');
    await sleep(400);
    await inputChars(String(mobile ?? ''));
    await tapXY(REGISTER.next2XY, 'Next (2) — requests OTP');
    awaitingOtpUntil = Date.now() + OTP_ARM_MS;
    log('  auto-OTP armed for ' + OTP_ARM_MS / 1000 + 's (next SMS will Paste + Confirm)');
    return { step: 'mobile', mobile: String(mobile ?? ''), armed: true };
  },

  // Step 3 (manual fallback): clipboard -> Paste -> Confirm, using the latest SMS text.
  'reg-otp': async ({ code }) => {
    if (code != null && code !== '') await setClipboard(String(code));
    await tapXY(REGISTER.pasteXY, 'Paste');
    await sleep(700);
    await tapXY(REGISTER.confirmXY, 'Confirm');
    return { step: 'otp' };
  },

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
  const whole = String(sms.message).trim();

  if (awaitingOtpUntil && Date.now() < awaitingOtpUntil) {
    // Armed by the mobile step: set clipboard, then Paste + Confirm on the OTP page.
    awaitingOtpUntil = 0;
    log('  auto-OTP: completing OTP page');
    exclusive(async () => {
      await setClipboard(whole);
      log('  clipboard <- ' + JSON.stringify(whole));
      await sleep(600);
      await tapXY(REGISTER.pasteXY, 'Paste');
      await sleep(700);
      await tapXY(REGISTER.confirmXY, 'Confirm');
      log('  auto-OTP done');
    }).catch((e) => log('  auto-OTP failed: ' + e.message));
    return res.json({ ok: true, copied: whole, autoOtp: true });
  }

  // Otherwise just copy the whole SMS onto the clipboard (always, any number).
  setClipboard(whole)
    .then(() => log('  clipboard <- ' + JSON.stringify(whole)))
    .catch((e) => log('  clipboard set failed: ' + e.message));
  res.json({ ok: true, copied: whole, autoOtp: false });
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
.wrap{max-width:1040px;margin:0 auto;padding:26px 18px 48px;display:grid;grid-template-columns:auto minmax(290px,1fr);gap:36px;align-items:start}
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
  <div class="stage">
    <div class="where" id="where">&mdash;</div>
    <div class="phone">
      <div class="screen-hold">
        <img id="screen" alt="Live Android screen">
        <div id="veil">Enter your API key to connect</div>
      </div>
      <div class="navbar">
        <button class="navkey back" title="Back" onclick="key('BACK')"><svg viewBox="0 0 24 24"><polygon points="15,5 7,12 15,19"/></svg></button>
        <button class="navkey" title="Home" onclick="key('HOME')"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg></button>
        <button class="navkey" title="Recent apps" onclick="key('APP_SWITCH')"><svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2"/></svg></button>
      </div>
    </div>
    <div class="inline" style="width:270px">
      <button class="btn grow" onclick="refresh()">Refresh</button>
      <label class="btn grow" style="display:flex;gap:7px;align-items:center;justify-content:center;cursor:pointer"><input type="checkbox" id="auto" checked style="width:auto">Live</label>
    </div>
  </div>

  <div class="panel">
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
        <div class="inline"><input id="rname" type="text" placeholder="Name"><button class="btn go" onclick="regName()">Name &rarr; Next</button></div>
        <div class="inline"><input id="rmobile" type="text" placeholder="Mobile number"><button class="btn go" onclick="regMobile()">Mobile &rarr; Next</button></div>
        <p class="hint">"Mobile &rarr; Next" requests the OTP and arms auto-complete &mdash; the next SMS is pasted + confirmed automatically.</p>
      </div>
    </div>

    <div class="card">
      <h2>Tap test &mdash; click each to check it lands on the right spot</h2>
      <div class="row" id="taps"></div>
    </div>

    <div class="card">
      <h2>Clipboard</h2>
      <div class="stack">
        <input id="clip" type="text" placeholder="Text to copy to the device clipboard">
        <div class="inline">
          <button class="btn go grow" onclick="copyText()">Copy to clipboard</button>
          <button class="btn" onclick="call('paste-clipboard',{})">Paste (Ctrl+V)</button>
          <button class="btn" onclick="tapPaste()">Tap app's Paste</button>
        </div>
        <p class="hint">Copy sets the device clipboard. Paste sends Ctrl+V. "Tap app's Paste" taps your OTP-page Paste button.</p>
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
let K=localStorage.getItem('rk')||'';$('key').value=K;
function saveKey(){K=$('key').value.trim();localStorage.setItem('rk',K);$('veil').classList.toggle('hide',!!K);refresh();status();loadApps();}
function log(m,cls){const l=$('log');const s=document.createElement('div');if(cls)s.className=cls;s.textContent=new Date().toLocaleTimeString()+'  '+m;l.prepend(s);while(l.childElementCount>60)l.lastChild.remove();}
async function call(a,b){
  if(!K){log('connect first','log-err');return;}
  try{
    const r=await fetch('/api/'+a,{method:'POST',headers:{'content-type':'application/json','x-api-key':K},body:JSON.stringify(b||{})});
    const j=await r.json();
    log(a+' '+(j.ok?'ok '+JSON.stringify(j.result):'ERROR '+j.error),j.ok?'log-ok':'log-err');
    setTimeout(refresh,300);return j;
  }catch(e){log(a+' ERROR '+e.message,'log-err');}
}
let loading=false;
async function refresh(){
  if(loading||!K)return;loading=true;
  try{
    const r=await fetch('/api/screenshot',{headers:{'x-api-key':K}});
    if(!r.ok)return;
    const u=URL.createObjectURL(await r.blob());const old=$('screen').src;$('screen').src=u;$('veil').classList.add('hide');
    if(old.startsWith('blob:'))URL.revokeObjectURL(old);
  }catch(e){}finally{loading=false;}
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
const sc=$('screen');let down=null;
function pt(e){const r=sc.getBoundingClientRect();return{x:Math.round((e.clientX-r.left)*${SCREEN_W}/r.width),y:Math.round((e.clientY-r.top)*${SCREEN_H}/r.height),t:Date.now()};}
sc.addEventListener('mousedown',e=>{e.preventDefault();down=pt(e);});
sc.addEventListener('mouseup',e=>{
  if(!down)return;const u=pt(e),d=down;down=null;
  if(Math.hypot(u.x-d.x,u.y-d.y)<15){u.t-d.t>600?call('longpress',{x:d.x,y:d.y}):call('tap',{x:d.x,y:d.y});}
  else call('swipe',{x1:d.x,y1:d.y,x2:u.x,y2:u.y,ms:Math.max(100,Math.min(1500,u.t-d.t))});
});
function key(k){call('key',{key:k});}
function sendText(){const t=$('text').value;if(t==='')return;call('paste',{text:t});}
function sendOtp(){const v=$('otp').value.trim();if(!v)return;call('otp',/^\\d{4,8}$/.test(v)?{code:v}:{message:v});}
function app(a){const p=$('pkg').value;localStorage.setItem('rpkg',p);call(a,{package:p});}
function regName(){call('reg-name',{name:$('rname').value.trim()});}
function regMobile(){call('reg-mobile',{mobile:$('rmobile').value.trim()});}
// Tap-test buttons, built from the server's REGISTER coordinates.
const COORDS=${JSON.stringify(REGISTER)};
const TAPLABELS={nameXY:'Name field',next1XY:'Next 1',mobileXY:'Mobile field',next2XY:'Next 2',pasteXY:'Paste btn',confirmXY:'Confirm'};
(function(){const box=$('taps');for(const k in TAPLABELS){const xy=COORDS[k];if(!xy)continue;const b=document.createElement('button');b.className='btn';b.textContent=TAPLABELS[k]+' ('+xy[0]+','+xy[1]+')';b.onclick=()=>call('tap',{x:xy[0],y:xy[1]});box.appendChild(b);}})();
function copyText(){call('set-clipboard',{text:$('clip').value});}
function tapPaste(){const xy=COORDS.pasteXY;if(xy)call('tap',{x:xy[0],y:xy[1]});}
if(K){$('veil').classList.add('hide');loadApps();}
setInterval(()=>{if($('auto').checked&&!document.hidden)refresh();},1500);
setInterval(status,2500);
refresh();status();
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
