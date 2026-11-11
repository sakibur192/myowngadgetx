/**
 * coords.js — EVERY TAP POINT IN ONE PLACE
 * ----------------------------------------
 * This is the only file you edit when a button moves on the phone.
 * Each value is [x, y] in screen pixels. Find the right numbers with /tapsfinder
 * (tap the real button, read the X,Y) or /admin → Debug screenshots.
 *
 * After editing, restart the server:  pm2 restart gadgetx-control
 */
const { PACKAGE } = require('./config');   // the app package lives in config.js (editable there)

// ---- Registration screen (mobile -> PIN -> OTP) ----
const REGISTER = {
  mobileXY:     [582, 721],    // mobile field
  nextMobileXY: [540, 1102],   // Next (after mobile)
  pinXY:        [540, 934],    // PIN field
  nextPinXY:    [571, 1365],   // Next (after PIN) -> requests the OTP
  otpXY:        [247, 1145],   // OTP: first box
  otpNextXY:    [810, 1736],   // Confirm/Submit on the OTP page
  pageWaitMs:   1800,          // pause after each page change
  otpMode:      'button-paste',// clipboard-set the SMS, then tap the app's Paste button (like a human)
  otpPasteXY:   [512, 1416],   // the app's Paste BUTTON
  otpSubmit:    true,          // also tap otpNextXY (Confirm) after pasting the OTP
};

// ---- On-screen numeric keypad (used for PIN and OTP). Center of each digit key ----
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
  layout: [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['DEL', '0', 'DONE']],
  oneXY:  [207, 1732],
  doneXY: [553, 2286],
  keyDelayMs: 250,             // pause between key taps
};

// Default 4-digit PIN (used only when nothing else supplies one).
const PIN = '1234';

// ---- GO ONE flow (send / out / check). Taps run top-to-bottom. Edit any [x, y]. ----
const COORDS = {
  login: {
    openPin: [499, 1070],   // tap to open the PIN box
    submit:  [596, 1401],   // the Login button
  },
  goone: {
    entrySend: [187, 989],      // STEP 1 (goonesend): the very first tap
    entryOut:  [443, 999],      // STEP 1 (gooneout):  the very first tap

    // -- PAGE 1 : NUMBER 1 --
    number1Open:   [317, 718],  // STEP 2a: tap to open the number 1 box
    number1Field:  [249, 492],  // STEP 2b: tap this box to focus it, then it types number 1

    // -- go to the NUMBER 2 page --
    number2Open:   [963, 459],  // STEP 3 : tap this to open the number 2 page (then it waits)

    // -- PAGE 2 : NUMBER 2 --
    number2PageTap: [248, 713], // STEP 4a: first tap on the number 2 page
    number2Field:   [301, 503], // STEP 4b: long-press this box to focus, then it types number 2
    number2Confirm: [955, 481], // STEP 4c: tap right after number 2

    numbersNext:   [599, 1366], // STEP 5 : submit both numbers -> next page

    // -- PIN page --
    pinField:  [597, 1392],     // STEP 6a: tap the PIN box, then it types the PIN
    pinNext:   [562, 1406],     // STEP 6b: submit the PIN -> next page

    // -- final --
    holdSpot:    [574, 1628],   // STEP 7a: press and hold here...
    holdSeconds: 4,             // STEP 7a: ...for this many seconds
    finalTap:    [614, 2242],   // STEP 7b: the last tap
  },
  check: {
    row: [268, 653],            // gooncheck: tap this row, then read its text
  },
};

// ---- Pauses (milliseconds). Raise these if the phone is slow. ----
const PAUSE = {
  afterTap:        150,    // small settle after every single tap
  afterType:       400,    // after typing into a box
  afterPage:       1800,   // after a whole new page loads
  afterNumber1:    1000,   // extra wait after number 1 is typed
  number2PageLoad: 2000,   // wait for the NUMBER 2 page to load before touching it
};

// ---- Screen names (the decision layer) + a few reset/register taps ----
const APP = {
  pkg: PACKAGE,                // comes from config.js — change the package there
  screens: {
    home:        'HomeActivity',              // the home page — all operations start here
    login:       'CustomerLoginActivity',     // the login (PIN) screen
    checkStatus: 'CheckUserStatusActivity',   // router; if it stays here, we must register
  },
  regToHome1: [555, 1678],     // after register's OTP confirm: 1st tap toward Home
  regToHome2: [598, 433],      // ...then (after 150ms) 2nd tap -> Home
  afterLaunchTap: [843, 1862], // after a FRESH launch (wipe+relaunch), tap this once to continue
};

module.exports = { REGISTER, KEYPAD, PIN, COORDS, PAUSE, APP };
