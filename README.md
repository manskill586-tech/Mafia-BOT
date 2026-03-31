# Mafia Slack Bot

Full-featured Mafia bot for Slack (Socket Mode) with anonymous voting, timers, DM actions, and state persistence in Postgres (Render) or SQLite (local).

Telegram support is optional and documented at the end. The main focus is Slack.

## Quick Start (Slack only)

1. Create a Slack App from `manifest.json`.
2. Enable Socket Mode and create an app-level token with `connections:write`.
3. Install the app in your workspace and copy:
   - Bot Token (`xoxb-...`)
   - Signing Secret
   - App Token (`xapp-...`)
4. Create `.env` from `.env.example`.
5. Install deps and run:


```bash
npm install
npm start
npm.cmd start
```

You should see "Socket Mode connected" in logs.

## Day/Night media and Home icon

- Day/Night MP4 in the channel requires the `files:write` scope and app reinstall.
- Home icon requires public access to assets:
  - Set `ASSET_BASE_URL=https://<your-domain>` (e.g., your Render domain).
  - The bot serves `/assets/*` via the health server (PORT).
- If `ASSET_BASE_URL` is not set, Home icons are hidden (text only).

## Beginner Guide (Slack, step by step)

### 1) Install requirements
- Install Node.js (LTS).
- Open terminal in project folder.

### 2) Install dependencies
```bash
npm install
```

### 3) Create Slack App (from manifest)
1. Go to Slack API -> Create App -> From an app manifest.
2. Paste contents of `manifest.json`.
3. Create the app.
4. Go to Socket Mode and enable it.
5. Install the app to your workspace.

### 4) Get Slack tokens
From your app settings:
- Bot Token (`xoxb-...`)
- App Token (`xapp-...`) with `connections:write`
- Signing Secret

Put them into `.env`.

Where to find them in Slack App settings:
- Bot Token: App -> OAuth & Permissions -> Bot User OAuth Token.
- Signing Secret: App -> Basic Information -> App Credentials.
- App Token: App -> Socket Mode -> Generate an app-level token (scope `connections:write`).

### 5) Start locally
```bash
npm start
```
You should see logs that Socket Mode is connected.

### 6) Add bot to a channel
In Slack channel:
```
/invite @MafiaBot
```

### 7) Create a lobby
In the channel:
```
@MafiaBot create
```
Players join with `Join` and host starts with `Start`.

### 8) Slack settings you must enable
These are required for buttons, DMs, and events:
- Interactivity & Shortcuts -> On
- Event Subscriptions -> On
- App Home -> enable "Allow users to send messages to this app" (otherwise DM will not work)

### 9) Update scopes / reinstall
If you changed `manifest.json` (added scopes), reinstall the app in Slack.

### Slack App Settings Map (where to click)
- Socket Mode: App -> Socket Mode
- App Home (DM enable): App -> App Home
- Interactivity & Shortcuts: App -> Interactivity & Shortcuts
- Event Subscriptions: App -> Event Subscriptions
- OAuth scopes: App -> OAuth & Permissions

### 10) Render (production)
1. Create a Render Web Service.
2. Add environment variables (from `.env`).
3. Add Postgres and set:
   - `DATABASE_URL`
   - `PGSSL=1`
4. Deploy.

Where to find `DATABASE_URL` in Render:
- Render -> PostgreSQL -> your DB -> Info -> Internal Database URL.
- Use the Internal Database URL for Render services (more reliable and no public firewall issues).

### 10.1) Prevent Render sleep (optional)
If you are on a free plan, Render may sleep without traffic.
Enable keep-alive ping:
- Set `KEEP_ALIVE_URL` to your service URL.
- Optional: `KEEP_ALIVE_INTERVAL_MINUTES` (default 10).

Note: keep‑alive helps but free plans may still sleep. Paid plans are the only guaranteed option.

### 11) Assets (Home icon + day/night media)
- Set `ASSET_BASE_URL=https://<your-domain>` so Slack can load images.
- Ensure `files:write` scope for day/night MP4.

Where to find `ASSET_BASE_URL`:
- Render -> your Web Service -> Settings -> Service URL
  Example: `https://your-service.onrender.com`

### 12) Telegram webhook (optional)
If you use Telegram webhook:
- `TELEGRAM_WEBHOOK_DOMAIN` = your service URL (Render Service URL)
- `TELEGRAM_WEBHOOK_PATH` = `/telegram` (default)
- `PORT` must be open for webhook

If you leave `TELEGRAM_WEBHOOK_DOMAIN` empty, Telegram will use polling (local dev friendly).

## Project Management (for beginners)

### How to start/stop the bot
- Start: `npm start`
- Stop: `Ctrl + C`

### Where data is stored
- **Local**: `data/mafia.db` (SQLite)
- **Render**: Postgres via `DATABASE_URL`

### Reset the database (local)
Stop the bot, then delete:
```
data/mafia.db
```

### Update dependencies
```
npm install
```

### Typical workflow
1. Change code.
2. Restart `npm start`.
3. Reinstall Slack app if scopes changed.

### Useful logs
If something doesn’t work, check terminal logs:
- Slack connection status
- Telegram webhook/polling status
- Database connection errors

### Common issues (Slack)
- **DM says \"Sending messages to this app has been turned off\"**: App -> App Home -> enable \"Allow users to send messages to this app\".
- **Buttons do not work**: App -> Interactivity & Shortcuts -> On.
- **Bot does not react to mentions**: App -> Event Subscriptions -> On, and make sure the bot is invited to the channel.
- **Home tab empty**: open Home again or check logs.
- **Files (day/night) not posted**: add `files:write` and reinstall the app.
- **Cannot delete messages**: check Slack message deletion settings and reinstall after scope changes.

## Commands (Slack)

Slack in channel (mention the bot):
- `@MafiaBot create` - create lobby
- `@MafiaBot join` - join
- `@MafiaBot leave` - leave
- `@MafiaBot start` - start game (host only)
- `@MafiaBot extend 2` - extend lobby by 2 minutes
- `@MafiaBot status` - status
- `@MafiaBot config` - settings (day/night/lobby/min/extend)
- `@MafiaBot end` - end game (host only)

Slack in DM (fallback):
- `vote @user` - day vote
- `kill @user` - mafia kill
- `save @user` - doctor
- `check @user` - detective
- `protect @user` - bodyguard
- `whisper <text>` - anonymous whisper (once per day)
- `lang en` / `lang ru` - language
- `mychannels` - your channels + defaults
- `faq` / `faq <id>` - FAQ list or a specific answer
- `dev <code>` - Dev panel (DEV_USER_ID only)
- Any DM - onboarding instructions
- `Find games` button in DM - public game list
- `My channels` button in DM - edit privacy and defaults
Default language is English.

## Mechanics

- Minimum 4 players: mafia, doctor, detective, town.
- Extra roles:
  - `>=7` players — mayor (double vote)
  - `>=8` players — bodyguard (takes the hit)
- Day/night actions are delivered via interactive DMs.
- Lobby panel has buttons `Join`, `Leave`, `Start`, `Ready`, `Extend`, `End`.
- Timers: lobby 5m, day 5m, night 2m by default; warnings + auto actions.
- Eliminated players can’t speak in game channel (messages are deleted).
- Last words: after death bot asks for a DM and posts it to the channel.
- Game Dashboard is pinned (phase/timer/alive).
- State is stored in Postgres (Render) or SQLite (`data/mafia.db`) locally when `DATABASE_URL` is absent.

## Render + Postgres

1. Create Render Postgres (Managed DB).
2. Add in service env:
   - `DATABASE_URL` (Render connection string)
   - `PGSSL=1`
3. Redeploy. The bot will use Postgres and persist data between deploys.

## Public Channels and Find Games

- When the bot is invited, it asks whether the channel should be listed in Find Games.
- If DM is blocked, it asks in the channel.
- If nothing arrived, mention the bot in the channel (e.g. `@MafiaBot help`) to re-trigger.
- In DM press `Find games` to open the list:
  - Filters: Active / Recruiting / Inactive
  - Pagination: Prev / Next
- Private channels are not listed.

## My Channels

- In DM press `My channels`.
- You’ll see channels where you last changed privacy.
- Click a channel to edit privacy and default settings.
- Settings have “?” buttons that open the relevant FAQ answer.

## FAQ

- In DM press `FAQ` to open the list.
- Answers show ID: `faq <id>` — open a specific question via command.

## Dev Mode and Maintenance

- Set `DEV_USER_ID` and `DEV_CODE` in `.env`.
- In DM run `dev <code>` to open the Dev panel.
- `Enable maintenance`:
  - New lobbies and games are blocked.
  - All lobbies close immediately.
  - Active games finish.
  - Dev gets a DM when the last game ends.
- `Disable maintenance` turns it off.

## Test Mode (single account)

DEV only. Create virtual players and control them from DM.

- Create test lobby:
  `test setup #channel Alice,Bob,Charlie`
- Actions:
  `as Alice vote Bob`
  `as Alice kill Bob`
  `as Alice save Bob`
  `as Alice check Bob`
  `as Alice protect Bob`
  `as Alice whisper <text>`
  `as Alice abstain`
- List:
  `test list #channel`

Notes:
- Test players don’t receive DMs and don’t count toward stats.
- Names must be one word (no spaces).

## Scopes

If you updated `manifest.json`, reinstall the app to refresh permissions.
Required scopes for new features: `pins:write`, `groups:write`, `mpim:write`, `channels:read`, `groups:read`, `files:write`.

## Telegram (optional)

Telegram setup is optional. See "12) Telegram webhook (optional)" above for env values.

Telegram in groups:
- `/create` - create lobby
- `/join` - join
- `/leave` - leave
- `/start` - start game (host only)
- `/extend 2` - extend lobby by 2 minutes
- `/status` - status
- `/config` - settings (day/night/lobby/min/extend/lang)
- `/end` - end game (host only)

Telegram in DM:
- `/home` - stats + current game
- `/faq` - FAQ
- `/find` - find games
- `/mychannels` - your channels
- `/lang en|ru` - language
- `/whisper <text>` - anonymous whisper (once per day)
