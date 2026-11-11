# GadgetX Automation — control server

Node.js + PostgreSQL server that drives an Android phone by **tapping screen coordinates**:
registration, login, send/out/check, and **many cloned app instances** (one row each),
with a request **scheduler** so simultaneous requests run one‑by‑one but all get served.

No `.env`, no `yml`, no Docker. All settings are plain files you edit and restart.

## Files (what to edit)

| File | What it's for |
|---|---|
| **`config.js`** | All settings. **Edit the app `PACKAGE` here** (the cloner renames it), plus server port, API key, `DATABASE_URL`, transport, Telegram, OTP sender. |
| **`coords.js`** | **Every tap point** — `REGISTER`, `KEYPAD`, `COORDS` (the send/out/check flow), `PAUSE` (wait times), `APP` (screen names + reset taps). Change any `[x, y]` and restart. |
| **`queue.js`** | The scheduler — FIFO, one job at a time, all served. |
| `server.js` | The engine + web pages (`/admin`, `/mydashboard`, `/flow`, `/tapsfinder`). |
| `package.json` | Deps: `express`, `pg`. |

Find the right coordinates with **`/tapsfinder`** (tap the real button, read the X,Y).

## Install & run

```bash
npm install                 # express + pg
# set your Postgres in config.js (DATABASE_URL), then:
pm2 start server.js --name gadgetx-control
# to use the on-device agent instead of adb+tunnel:
TRANSPORT=agent pm2 restart gadgetx-control --update-env
```
On boot: `[db] instances table ready` means Postgres is connected.

## Web pages

- **`/admin`** — the multi‑instance panel. Scan/add clones, and per instance: Send, Out, Check, Login, Register (wipe), Start Over, edit saved mobile/PIN. Shows the live **scheduler** queue.
- **`/mydashboard`** — single‑phone controls (Start Over, Login, Register, OTP/SMS, Send, Out, Check, tap‑marks).
- **`/flow`** — step‑by‑step registration wizard.
- **`/tapsfinder`** — tap the real phone, read back the exact X,Y.

## How it decides which screen it's on

By the Android **Activity name** (`/api/screen`), which is language‑independent:

| Screen | Activity | Action |
|---|---|---|
| Home | `HomeActivity` | run the operation |
| Login | `CustomerLoginActivity` | log in with the PIN, then run |
| Needs account | `CheckUserStatusActivity` | register, then run |

The **PIN is asked once** and reused for both the login and the flow's own PIN step.

## Multi‑instance (cloned apps)

Two cloning modes, set in `config.js → DUAL_SPACE.enabled`:

- **Dual Space (`enabled: true`)** — all clones live inside the Dual Space app (same package). A clone is opened by **launching Dual Space and tapping that clone's icon**. Each instance stores its **icon X,Y** (set per row in `/admin`; get the numbers from `/tapsfinder`). Set `DUAL_SPACE.pkg` to Dual Space's own package (`pm list packages | grep -i dual`). Note: **Start Over (wipe) isn't available** here — a Dual Space clone is reset from inside Dual Space; Register just opens the fresh clone and registers.
- **App Cloner (`enabled: false`)** — each clone is its own package; the server launches/clears by package, and **Scan** discovers them.

The `instances` table stores the package (or a synthetic key in Dual Space), icon X,Y, saved `mobile`+`pin`, `status`, `last_balance`, and the last outcome. A request names an instance → the server **opens that clone** → runs the operation. Because only one app is foreground at a time, the **queue** serializes everything.

API: `GET /api/instances`, `POST /api/instances {label,package}`, `PATCH /api/instances/:id`,
`DELETE /api/instances/:id`, `POST /api/instances/scan {filter}`,
`POST /api/i/:id/:action` (action = `goonesend|gooneout|gooncheck|login|register|startover`) → returns a **job**,
`GET /api/jobs`, `GET /api/jobs/:id`.

## Outcomes — how it knows success / failed / stuck

Tapping coordinates is blind, so every operation is **verified**:

- **Step verification** — the page‑changing taps (go to number‑2 page, submit numbers, submit PIN) use `tapExpectChange`: tap, then wait for the screen to actually change; re‑tap a few times; if it still won't move → **stuck at "<step>"** (it does not blindly continue).
- **Result verification** — money ops (send/out) are confirmed by the **balance actually changing**: the server reads the balance before and after and compares (language‑independent ground truth). Check = a number was read. Login/Register = reached Home.
- **Outcome** of every op is one of: `success` (verified) · `failed` (known bad end, e.g. balance unchanged / wrong PIN) · `stuck` (taps done, screen wouldn't progress) · `error` (device/other).
- The outcome is stored on the instance (`last_status`, `last_detail`) and returned in the job.
- **Recovery** — after each op the server returns the phone to **Home** so the next instance starts clean.

Tune in `config.js → VERIFY` (`verifyByBalance`, `stepChangeMs`, `stepRetries`, `settleMs`).

## Phone side (in `android-build/`)

- **gadgetx-agent/** — the on‑device agent (phone connects OUT to the server; no PC/tunnel). Needs Accessibility; wipe/grant/show‑touches need root. See its README.
- **clip-setter/** — tiny app that sets the clipboard + an OTP viewer (this ROM blocks `cmd clipboard`).
- **sms-forwarder/** — forwards the OTP SMS to the server (`/api/sms`).

## Security note

The app ships the server URL + API key, which are extractable by decompiling the APK, and traffic is plain HTTP. For real protection: provision the key at setup (not baked in), put the server behind HTTPS, and don't commit the key to a public repo.
