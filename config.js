/**
 * config.js — ALL SETTINGS IN ONE PLACE
 * -------------------------------------
 * No .env, no yml, no docker — just edit the values here and restart:
 *   pm2 restart gadgetx-control
 */
module.exports = {
  // ======================================================================
  //  THE APP YOU DRIVE  (the cloner renames the package — set it here)
  //  This is the BASE / default package. Each cloned instance also keeps
  //  its own package in the database (managed from /admin).
  // ======================================================================
  PACKAGE: 'com.konasl.nagad',

  // ===== Server =====
  PORT: 3900,
  HOST: '0.0.0.0',
  API_KEY: '76344d7de4bda46b0bea0cf8717088e352e0c1c534474abb',

  // ===== How the server reaches the phone =====
  //   'adb'   -> PC + reverse tunnel
  //   'agent' -> the on-device GadgetX Agent app connects OUT (no PC, no tunnel)
  TRANSPORT: process.env.TRANSPORT || 'adb',
  ADB: 'adb',
  DEVICE: '127.0.0.1:5555',
  DEVICE_ID: 'phone-1',
  SCREEN_W: 720,
  SCREEN_H: 1280,

  // ===== Cloning mode =====
  // Dual Space runs every clone INSIDE itself (same package), so a clone is opened by launching
  // Dual Space and TAPPING that clone's icon. Each instance stores its icon X,Y (set in /admin).
  // (If instead you use App Cloner — each clone a separate package — set enabled:false.)
  DUAL_SPACE: {
    enabled: true,
    pkg: 'multi.parallel.dualspace.cloner',   // the cloner app's OWN package (Multi Parallel – Dual Space)
    launchWaitMs: 2500,             // wait after launching Dual Space before tapping an icon
    openWaitMs: 4000,               // wait after tapping a clone icon for the app to open

    // "Clear data" for one clone (pm clear can't reach a sandboxed clone, so we tap through
    // Dual Space's own UI). Record these from YOUR Dual Space version with /tapsfinder:
    //   the server long-presses the clone's icon, then taps each step below in order.
    clearLongPressMs: 1200,         // long-press the clone icon to open its menu
    clearSteps: [
      // [x, y],   // e.g. the "Clear data" menu item
      // [x, y],   // e.g. the "OK / Confirm" button
    ],
  },

  // ===== Database (cloned instances + their saved mobile/PIN). Install once: npm install pg =====
  DATABASE_URL: 'postgres://postgres:91CCK4MrTdXbBU3dU86Y49o7VGkQiSsusBQJUDRhwNrtB8v8hfseh6PMjMrWRtoX@76.13.223.236:5470/postgres',

  // ===== OTP / SMS =====
  OTP_REGEX: /\b(\d{4,8})\b/,              // how the OTP is pulled from an SMS
  OTP_SENDER: '01750006696',               // the number the OTP comes from
  TELEGRAM_BOT_TOKEN: '8786603241:AAEheZP1dMK6OMtKb9KhBhggrVoegIZJOa0',
  TELEGRAM_CHAT_ID: '1942142052',

  // ===== Typing / clipboard helpers =====
  USE_ADB_KEYBOARD: true,
  ADB_KEYBOARD_URL: 'https://github.com/senzhk/ADBKeyBoard/raw/master/ADBKeyboard.apk',
  CLIP_APP: 'com.baybex.clipsetter',

  // ===== Outcome verification (how the server decides success / failed / stuck) =====
  VERIFY: {
    verifyByBalance: true,   // send/out: confirm the operation by the balance actually CHANGING
    settleMs: 1200,          // wait for the screen to settle before judging the result
    stepChangeMs: 3500,      // a page-change tap must change the screen within this time...
    stepRetries: 2,          // ...else re-tap this many times before calling it STUCK
  },

  // ===== Misc =====
  AUTO_TYPE_SMS_OTP: false,
  OTP_FIELD: null,
  OTP_AUTO_SUBMIT: null,
};
