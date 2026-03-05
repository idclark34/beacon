# Alfred

Alfred is a local-first AI companion for solo developers. He lives in your menu bar, watches your build sessions, and checks in like a dry, opinionated butler who has been in the room the whole time.

He is not an assistant. He does not suggest ticket titles or summarize PRs. He watches what you do — your commits, your files, your browser tabs, your hours — and occasionally says something about it.

> "Three repos today, Ian. Which one are we actually shipping?"

---

## What Alfred does

### Proactive check-ins

Alfred fires on his own schedule. He doesn't wait to be asked. The check-in queue runs every 5 minutes and evaluates triggers in priority order:

| Trigger | Condition | Cooldown |
|---|---|---|
| **Inactivity return** | Away from coding for 3+ days | Once per absence |
| **Weekly recap** | 7 days since last recap | 7 days |
| **Browser distraction** | 20+ min on YouTube, Reddit, Twitter, LinkedIn | 2 hours |
| **Commit roast** | Vague commit message (`fix`, `wip`, `misc`, etc.) | 4 hours |
| **Branch roast** | Terrible branch name (`final-final`, `wip`, `temp`, etc.) | 24 hours |
| **Distraction return** | Back in editor after 60+ min away | 2 hours |
| **Project switch warning** | 3+ repos in 4 hours, or 3+ repos over 7 days with no commits | 4 hours |
| **Intel drop** | High-relevance RSS item waiting | 2 hours |
| **Intro check-in** | First 10 active minutes on a new project | Once |
| **Quote** | Once per day, only when idle | 24 hours |
| **Progress narrative** | 90+ active minutes, 3+ days since last | 3 days |
| **Regular check-in** | 30+ active minutes since last check-in, then gone idle | Variable |

Alfred also fires immediately on:
- **New commits detected** (git poll)
- **Hot file observation** — a file saved 5+ times in 30 minutes goes idle (2hr per-file cooldown)

### What Alfred sees

Alfred's context at check-in time includes:

- **Current app** — which application is focused right now
- **Current browser tab** — the active Safari URL, including domain and time spent
- **App session summary** — time in each app this session
- **Commit activity** — commit count, file paths touched, commit messages (last 24h)
- **Active coding time** — hours tracked via file-save activity
- **Hot files** — most-edited files in the current session
- **Weekly summary** — commits, active hours, active days, recurring files
- **Webcam frame** — optional, if camera is enabled (see Settings)

When responding to user messages, Alfred can also use tools:
- `read_file` — peek at a specific file in the repo
- `get_git_diff` — read actual code changes from recent commits
- `get_recent_intel` — pull from the RSS feed

### Alfred's character

Alfred is patrician, dry, and warm underneath — but he doesn't show it often. He has edge. He pushes back. He uses your name occasionally, when it lands.

```
"Eight commits and it's not yet noon. You're in it today."
"The repo was quiet for three days. I noticed."
"You've been in that browser for over an hour. Something stuck, or just avoiding it?"
"You pushed 'fix stuff.' That's not a commit message, Ian. That's a confession."
"You're on 'final-final-v2'. I've seen this branch before. Different repo, same energy."
```

He never gives step-by-step instructions. He never writes code. He never says "Great job!" He names what he sees and lets the implication land.

---

## Requirements

- macOS (uses `say`, AppleScript, vibrancy, and screen position APIs)
- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)

Optional:
- `brew install switchaudio-osx` — for headphone auto-detection with voice

---

## Installation

```bash
git clone https://github.com/idclark34/beacon.git
cd beacon

cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env

npm install
```

The `postinstall` script rebuilds `better-sqlite3` for Electron automatically. If it fails:

```bash
npm install --ignore-scripts
npm run rebuild
```

---

## Running

```bash
npm start
```

Development mode (opens detached DevTools):

```bash
npm run dev
```

Alfred launches as a frameless floating widget in the bottom-right corner of your screen. It hides itself until there's something to say. A green dot appears in your menu bar.

---

## First run

On first launch with no projects configured, Alfred shows an onboarding card. Enter your project name and the path to your repo. Alfred will start watching immediately.

---

## Menu bar

Click the green dot in your menu bar for:

- **Check in now** — manually trigger a check-in
- **Scan git now** — force an immediate git poll
- **Settings** — open the settings window
- **Quit**

---

## Settings

Open via tray → Settings.

### Camera

Alfred can capture a webcam frame during check-ins and reference your environment — the hour, the posture, the cold coffee. He reads the room the way a butler reads the Batcave after a long night: with quiet, knowing respect.

- **Enable camera observations** — on/off
- **Capture timing** — limit to after 6pm, 8pm, 10pm, or midnight for the full effect

Camera access is requested through Electron's standard permission flow. Frames are captured, sent to the AI, and immediately discarded — never written to disk.

### Voice

Alfred can speak his check-ins aloud using macOS `say` with the Daniel voice at 165 WPM.

- **Enable Alfred's voice** — on/off
- **Auto-detect headphones** — only speaks when headphones are plugged in. Requires `switchaudio-osx`:
  ```bash
  brew install switchaudio-osx
  ```
  Without it, voice fires regardless of audio device.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `ANTHROPIC_MONTHLY_BUDGET` | No | Monthly USD budget for spend alerts (e.g. `20`) |
| `NODE_ENV` | No | Set to `development` to open DevTools on launch |

---

## Architecture

```
main.js                   — Electron main process, check-in timer, IPC, voice, camera
preload.js                — contextBridge IPC bridge (contextIsolation: true)
renderer/
  index.html              — Floating widget UI
  app.js                  — Typewriter streaming, chat input, camera capture
  settings.html/js        — Settings window
services/
  database.js             — SQLite via better-sqlite3
  ai-character.js         — Anthropic streaming, all Alfred generators, tool-call loop
  app-tracker.js          — Active app polling, Safari URL tracking, distraction domain timing
  git-monitor.js          — simple-git polling every 5 min, commit metadata
  file-watcher.js         — chokidar, tracks file saves by extension
  activity-tracker.js     — 5-min active window polling
  interest-manager.js     — Auto-detects interests from project context
  feed-fetcher.js         — RSS polling, relevance scoring
  dep-monitor.js          — npm audit + outdated package checks
  secret-scanner.js       — Scans commits for credentials and API keys
  spend-tracker.js        — Anthropic usage API, budget threshold alerts
```

### Database

SQLite stored at `~/Library/Application Support/outpost-companion/outpost.db`.

| Table | Contents |
|---|---|
| `projects` | Name and repo path |
| `activity` | File saves, commit events, active coding windows |
| `conversations` | Full Alfred ↔ user message history |
| `manual_goals` | Weekly goals (not yet surfaced in UI) |
| `app_state` | Key/value store for cooldowns, settings, flags |
| `feed_items` | RSS items with relevance scores |
| `spend_snapshots` | Anthropic API cost history |

### Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` in all BrowserWindows
- Path traversal guard on all file reads (`_executePeek`)
- Secret scanner checks commits for credential patterns and alerts immediately
- No commit message content is stored unless explicitly passed through the activity summary query

### AI model

All Alfred generators use `claude-haiku-4-5-20251001`. Token budgets are kept tight (80–300 tokens) to keep latency low and cost minimal. The main check-in uses a tool-call loop (up to 3 rounds) for git diff, file peek, and intel access before producing a final response.

---

## Distraction tracking

Alfred polls Safari's active tab every 15 seconds via AppleScript. Distraction domains:

- `youtube.com`
- `reddit.com`
- `twitter.com` / `x.com`
- `linkedin.com`

After 20 continuous minutes on any of these, Alfred fires a single-sentence observation. The last known domain persists for 5 minutes after Safari loses focus, so tray clicks don't wipe the context before the check-in fires.

---

## Commit and branch roasting

**Commit roast** fires when a recent commit message matches the bad-message pattern: single vague words or phrases like `fix`, `wip`, `update`, `misc`, `asdf`, `temp`, `done`, `final`, `cleanup`, `test`, etc. 4-hour cooldown, won't re-roast the same message.

**Branch roast** fires when the current branch name contains `final`, repeating segments (`fix-fix`), or matches the bad-branch list (`wip`, `temp`, `test`, `new`, `old`, etc.). Safe branches (`main`, `master`, `develop`, `staging`, `production`) are never roasted. 24-hour cooldown, won't re-roast the same branch.

---

## Intel feed

Alfred can surface relevant articles and discussions from RSS feeds during check-ins or as standalone intel drops. Configure feeds in Settings (not yet in the UI — currently set via `rss_feeds` in `app_state`). Items are scored for relevance against your project context and auto-interests. Items scoring 7+ are eligible for intel drops. Feed items are pruned after 48 hours.

---

## Chatting with Alfred

After any check-in, a text input appears at the bottom of the widget. You can reply directly. Alfred maintains a rolling 12-message conversation history. He can read files and git diffs on request. Press Escape to dismiss.

The widget auto-dismisses after a countdown if you don't interact. Losing focus (switching apps mid-chat) resumes the countdown.

---

## License

See `LICENSE`.
