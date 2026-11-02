# dsh-web-share

> **Think cheap, then build.** Work out the plan in the DeepSeek web UI, then hand it to DeepSeek Harness with one click.

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License](https://img.shields.io/badge/license-MIT-263146?style=flat-square)](LICENSE)
[![Read-only](https://img.shields.io/badge/design-read--only-10b981?style=flat-square)](#read-only-by-design)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)](#requirements)

English · [中文](README.md)

---

## What it actually saves: **tokens**

The first half of any non-trivial agent task is planning: trying phrasings, comparing options, rewriting, starting over.

Doing that inside the agent is **expensive** — every exploratory turn burns context and tokens. Doing it in the **DeepSeek web UI** is free of that cost, and you get web search and deep thinking along the way.

The only remaining problem: **how do you hand it over?** Copy-pasting a 200-message conversation is not an option.

This plugin turns that last step into **one click**:

```
Plan it out in the web UI (free quota, take your time)
        ↓
Click "Export to new conversation" in DSH
        ↓
A "handoff pack" is built → a new conversation is created → pre-filled
        ↓
Press Enter — the agent picks up the plan and starts working
```

**What you save is the planning phase**, which can be thousands to tens of thousands of tokens. The agent only receives the conclusion.

---

## Two entry points, two destinations

| Entry | Where |
|---|---|
| **Sidebar → "Web export"** | A row below Plugins / Automation / Task board; opens a full-page panel → **creates a new conversation** |
| **Conversation tab → "Web"** | Sits next to Chat and Trajectory → **writes into the current conversation's composer** |

The sidebar panel button reads **"Export to new conversation"**; the tab button reads **"Export to composer"**. Both will:

1. Build a **handoff pack** — last 2 exchanges kept verbatim, earlier rounds compressed to one line each
2. **Create a new conversation** (workspace picked automatically)
3. **Pre-fill** that conversation's composer — it does **not** auto-send

### Why a "handoff pack" instead of the full transcript

Measured: a 202-message conversation is **~253k characters ≈ 240k tokens** — it will blow up any composer.

What a handoff actually needs is the **finalised plan**, which lives in the last exchange or two. So:

- **Earlier rounds**: one line each (your question + its answer, truncated)
- **Last 2 exchanges**: verbatim, nothing dropped

A 30-round conversation becomes **6,620 characters** with the last 2 rounds intact. No files are written to disk.

---

## Requirements

| Dependency | Notes |
|---|---|
| **Edge or Chrome** | Drives the browser already on your machine via `playwright-core` — no extra Chromium download |
| **DSH** | `>= 0.1.7-rc.2` (verified on 0.1.7-rc.2 and 0.2.1-rc.2) |
| **Node** | `>= 20` |
| **OS** | **Windows only** (the published package declares `os: win32`; npm refuses to install on macOS / Linux by that field unless you pass `--force`) |

> Tabbit users can switch to the zero-login `tabbit` driver (Windows only):
> `DSWEB_DRIVER=tabbit node dsweb-share/dsweb.mjs doctor`

### ⚠️ Browser compatibility — self-test first

This plugin does **not** call an official API. It drives a **real browser** against `chat.deepseek.com`.
Its stability therefore depends on three things **outside our control**:

1. Your local browser (version, enterprise policy, writable profile directory)
2. DeepSeek's front-end implementation (endpoints and fields can change)
3. Your network environment (proxy, accelerator, DNS)

**So run the self-test below before relying on it.** A failure cannot break anything — the plugin is read-only; worst case it reads nothing.

#### Self-test (three commands, one minute)

```powershell
cd <plugin-dir>\dsweb-share

node dsweb.mjs selftest        # 1) read-only self-check — must pass
node dsweb.mjs doctor          # 2) driver + login status
node dsweb.mjs list --count 5  # 3) actually read the session list
```

- ① fails → files were modified; don't use them
- ② shows `playwright ⚪ available, not logged in` → run `node dsweb.mjs login`
- ③ lists titles → **working**; otherwise paste the error into an issue

---

## Install

```powershell
# 1) Install (pulls in playwright-core, ~5 MB, no browser download)
dsh plugin --profile web add github:huang13113/dsh-web-share
```

**Restart DSH** afterwards.

```powershell
# 2) Log in once (a real browser window opens)
cd "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-web-share\dsweb-share"
node dsweb.mjs login
```

Log into `chat.deepseek.com` in that window; it closes itself on success.
The plugin never touches or stores your password — the login lives in that browser profile.

```powershell
# 3) Verify
node dsweb.mjs doctor
```

> You can also click **"Log in to DeepSeek"** in the DSH panel — same thing.

---

## Usage

**Sidebar (recommended, works in every state)**

Sidebar → **Web export** → find the conversation → **Export to new conversation** → review the pre-filled composer → Enter.

> The panel has no session context, so it can only create a new conversation.

**Conversation tab** — open the **Web** tab and press **"Export to composer"**; the pack lands in the composer of the conversation you are already in. No new conversation is created.

**Agent tool**
```
read_deepseek_web action=list
read_deepseek_web action=read query="thesis"
```

**CLI**
```powershell
node dsweb.mjs doctor
node dsweb.mjs list --count 20
node dsweb.mjs handoff "thesis"                 # print the handoff pack
node dsweb.mjs export "thesis" --out D:\share   # full transcript (archive, writes files)
```

---

## Highlights

| | |
|---|---|
| **Saves tokens** | Planning happens on the free web tier; the agent only receives the conclusion |
| **One click** | Export = build pack + create conversation + pre-fill |
| **Handoff pack** | Last 2 exchanges verbatim + earlier rounds compressed; 30 rounds → 6,600 chars |
| **No files** | Pack travels in memory; the rare temp file is deleted right after reading |
| **Read-only** | GET only. A hard-coded self-check refuses to start if write capability appears |
| **No stored credentials** | Login stays in the browser profile; the plugin never reads or writes credential files |
| **Swappable driver** | `playwright` (default, system Edge/Chrome) or `tabbit` |
| **Two entries, two destinations** | Sidebar → new conversation; conversation tab → current conversation's composer |

---

## Read-only by design

Mainstream projects in this space turn the web UI into a **model provider** — letting it generate for you. Tempting, but it carries account risk:

| Fact | Source |
|---|---|
| Concurrent generation on one account → **1-day ban in under 6 minutes** | `cv-superding/dsh-deepseek-web-login` README |
| Observed penalties: `5` muted / `10` **permanent ban** / `11` device risk | `NIyueeE/ds-free-api` |
| The earliest project here stopped after its author's account was banned | downstream fork README |

**This project is read-only.** Reading history produces no generation request.
That is why it needs no reverse engineering, no fingerprint spoofing, and **no stored reusable credential**.

### Enforced self-check

`dsweb-share/readonly.guard.json` holds the rules, kept **outside** the scanned files (otherwise the check matches itself).
Every run scans all engine sources and refuses to start on a hit:

```
❌ Read-only self-check failed, refusing to run. Forbidden patterns: POST
```

Covered: generation endpoint, session create/delete/rename, file upload, and `POST/PUT/PATCH/DELETE`.

---

## Architecture

```
DSH Web GUI (browser)
  lib/client.js
  ├─ sidebar.panellist  → sidebar row
  ├─ main#web-share     → full-page panel
  └─ conversation.view  → "Web" tab
        │ same-origin fetch  /api/dsweb/*
DSH host (Node)
  lib/index.js
  ├─ tool read_deepseek_web
  └─ routes list / handoff / login / read
        │ spawn (read-only child)
dsweb-share/dsweb.mjs   business logic (parse / render)
dsweb-share/driver.mjs  driver selection (auto)
  ├─ driver-playwright  system Edge/Chrome
  └─ driver-tabbit      Tabbit CLI
        │ fetch inside the page context
Real browser → chat.deepseek.com
```

**No LLM in the bridge layer.** Letting a subagent "look at the browser and click" burns tens of thousands of tokens — cancelling out the savings. This layer is plain deterministic code.

---

## FAQ

**Empty panel / tab shows nothing?** Host-side failures are silent in DSH. Run `node docs/read-diag.mjs` to read the diagnostic log.

**`doctor` says "available, not logged in"?** Run `node dsweb.mjs login`, or click "Log in to DeepSeek" in the panel.

**Clicking export does nothing?** Run the self-test. Check the browser console for `[dsweb]` lines, or paste `node dsweb.mjs list` output into an issue.

**Can it use the browser I already have open?** Not transparently — a normally launched browser has no debugging port, and cross-origin rules stop the DSH page from reading DeepSeek. This project uses **your system Edge/Chrome with its own profile**, one login.

**Does it touch my daily browser's session?** No. It uses `~/.dsh/web-share/browser-profile`, separate from your daily browsing.

---

## Development notes (pitfalls)

Full version in [docs/DESIGN.md](docs/DESIGN.md).

| Pitfall | Symptom | Cause |
|---|---|---|
| **`ctx` is a proxy** | Plugin silently does nothing | Reading an undeclared property throws — even a `typeof` probe |
| **Host failures are silent** | Tab renders, routes never register | Two independent load paths; you need an on-disk log |
| **HTTP 200 ≠ success** | List silently empty | Business errors live in `biz_code` |
| **Too-small `count`** | Health check reports "not logged in" | `fetch_page?count=1` returns `ILLEGAL_COUNT`; use ≥20 |
| **`startSession({prompt})` swallows the prompt** | Session created, composer empty | Draft cleared on composer mount; create → open → retry after mount |
| **Reusing a blank session eats the new pack** | Click appears to do nothing | `requestDraftInitialization` returns `preserved` on a non-empty draft; always create fresh |
| **Playwright context keeps the process alive** | Command finishes but never exits | Persistent context must be closed explicitly |

---

## Roadmap

- [ ] CDP driver: attach to your own Edge/Chrome launched with `--remote-debugging-port`
- [ ] Multi-site abstraction
- [ ] Inline pack preview in the panel
- [ ] Workspace dropdown (defaults to most recent)

---

## Disclaimer

> ⚠️ **Unofficial.** Not affiliated with or endorsed by DeepSeek.
>
> ⚠️ **Browser-compatibility risk.** The plugin depends on a real browser and private web endpoints; it **can break** with browser versions, enterprise policy, or site changes. Run the self-test first.
>
> ⚠️ **Your data.** It reads **your own** conversations and keeps everything local. Don't commit exported transcripts.
>
> ⚠️ **Terms of service.** Driving the web client to read your own data is a grey area. This plugin deliberately limits itself to read-only, low-frequency, manually triggered use — that is not a compliance guarantee.
>
> ⚠️ **As-is.** No warranty (see MIT License).

---

## License

[MIT](LICENSE)
