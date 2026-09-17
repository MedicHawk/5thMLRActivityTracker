# HWK Activity

Discord activity and voice attendance for an Arma Reforger community. Apollo remains the scheduling source; this bot records only activity it observes. It never reads message bodies for counting, voice audio, or DMs.

## Start

Requires Node.js 24 LTS and a Discord application. Copy `.env.example` to `.env`, fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`, then run:

```sh
npm ci
npm run build
npm test
npm run register
npm start
```

For Docker, run `docker compose up -d --build` after filling in `.env`. Compose sets the database path to `/data/activity.sqlite`, uses a persistent named volume for SQLite, and has `restart: unless-stopped`. Run **one instance only** against that volume. A lease file refuses a second writer; after an unclean crash it can take up to two minutes to expire. Keep the host running continuously; offline periods cannot be reconstructed.

### Cybrancee bot hosting panel

Cybrancee's Discord bot panel runs a chosen JavaScript file from its own Node image. Use the committed `index.js` as **BOT JS FILE**; it is a single bundled entry file and does not import `dist/src/bot.js`. The Dockerfile and Compose volume are for VPS/Docker deployments, not this panel. After changing TypeScript locally, run `npm run build` and commit the updated `index.js` (and `dist/src` for standard Node/Docker) before pushing. Choose a **Node.js 24** image in Startup (the package targets Node 24); if your panel does not offer Node 24, contact Cybrancee or use a compatible host before starting. [Cybrancee's Node version guide](https://cybrancee.com/learn/knowledge-base/how-to-change-the-nodejs-version-of-your-discord-bot/) describes the Docker Image selector.

For a **new empty panel server**, set Git Repo Address to `https://github.com/MedicHawk/5thMLRActivityTracker.git`, Git Branch to `main`, and Auto Update on. Follow [Cybrancee's Git integration guide](https://cybrancee.com/learn/knowledge-base/how-to-use-git-with-cybrancee/) to install from the repository. Its clean reinstall option **deletes existing files**; back up an existing installation and its database before using that option. Start one bot server only. Cybrancee says the Git integration pulls on server start; check its console after each update.

In the panel Files tab, create a private `.env` file based on `.env.example` with `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and (recommended) `DISCORD_GUILD_ID`. Set `DATABASE_PATH=data/activity.sqlite`, `AUTO_REGISTER_COMMANDS=true`, and `APOLLO_IMPORT_ENABLED=true` only after enabling Message Content in Discord. This keeps SQLite in the panel's persistent file area rather than the Docker-only `/data` path. Never commit `.env`; the Git ignore rule excludes it. The first successful start should log “Slash commands registered” and “HWK Activity connected”. [Cybrancee's `.env` guide](https://cybrancee.com/learn/knowledge-base/how-to-use-a-env-file-for-your-discord-bot/) shows how to create the file in the panel. npm 12 blocks dependency install scripts by default; this repository pins approval for only the `better-sqlite3` and `esbuild` versions it uses, so the native SQLite binding can install. Select Node 24 before restarting.

The panel must install the dependencies from `package.json` and `package-lock.json`, including the native `better-sqlite3` module. The pinned `allowScripts` approvals and `postinstall` check rebuild the SQLite binding if an earlier npm 12 install skipped it. If startup reports a missing module, check the panel's Node package installation settings and console output before retrying. Use Cybrancee's [Backups tab](https://cybrancee.com/learn/knowledge-base/how-to-create-a-backup-for-your-discord-bot/) to back up `data/activity.sqlite` and its WAL files; stop the bot for a simple file copy. Do not configure a separate Cybrancee MySQL database for this SQLite app.

Set `DISCORD_GUILD_ID` during setup for guild command registration (fast updates). Omit it to register global commands. Register again after command changes.

## Discord application setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications). Copy its token and application ID into `.env`.
2. On the Bot page enable **Server Members Intent** and **Presence Intent**. The bot uses Guilds, Guild Messages, Guild Voice States, Guild Members, and Guild Presences Gateway intents. Guild Members supplies current role rosters, LOA and newcomer checks. Presence supplies observed Playing activity. The latter two are privileged; Discord approval may be required for verified apps.
3. For Apollo import and sync, also enable **Message Content Intent** on the Bot page, obtain approval if required, and set `APOLLO_IMPORT_ENABLED=true`. Discord restricts `content`, `embeds`, and `components` across Gateway and HTTP without it. Ordinary message counting does **not** require it. The bot passes Message Content only when Apollo import is enabled.
4. Install the application for the guild with the `bot` and `applications.commands` scopes. Give the bot **View Channels** for tracked channels. For Apollo import, give it **View Channel** and **Read Message History** where Apollo posts. It needs no Administrator, Manage Messages, voice Connect, or audio permission. Grant only channels that should be observed.
5. Run `/activity-config view`; set the server timezone and other rules. Configure the Apollo bot **user ID** via `/activity-config set key:apolloBotId value:<ID>`. Do not use its display name.

Commands are guild only, default to members with Administrator, and check Administrator again on every command, button, and modal. Reports and CSV files are ephemeral and output suppresses mentions.

Discord sources: [Gateway intents and privileged intent rules](https://docs.discord.com/developers/events/gateway), [message content fields](https://docs.discord.com/developers/resources/message), [application command permissions and contexts](https://docs.discord.com/developers/interactions/application-commands).

## What is measured

- **Messages sent**: one creation event per message ID, including threads and forum posts. Edits and later deletions do not change the count. The configurable participation cap (default 5 per rolling minute per member) is stored separately. Threads can be viewed on their own or through the parent channel.
- **Discord voice time**: connected and qualifying person time, split on joins, leaves, moves, self deafen, occupancy changes and checkpoints. Default qualification excludes the server AFK channel and configured channels/categories, counts muted people, and does not require a second member. Set `excludeSelfDeaf` or `requireTwoHumans` to change this. This is not speaking time or verified game participation.
- **Observed game activity**: Discord Playing presence from the time the bot sees it. If multiple Playing activities appear, the lexicographically first normalized name is used so one person cannot accrue overlapping game time. Aliases normalize names such as Arma Reforger. Hidden presence, disabled sharing, unavailable integration, and outages cause gaps. A presence does not prove a particular game server join. Game time has no channel attribution; voice and game may overlap.
- **Discord voice attendance**: the union of qualifying voice intervals overlapping an event window and selected channels. Moves among selected channels cannot double count. Manual minute corrections are shown separately and never alter the voice record. RSVPs and signups are not attendance.

Reports state when tracking began and whether coverage is incomplete from an outage or retention. Timestamps are UTC in SQLite; calendar dates and hours use the configured IANA timezone (default America/New_York). Historical role membership is not inferred. The first startup cannot backfill old messages, voice time, or game time.

## Commands

`/activity user`, `role`, `channel`, `server`, `game`, `leaderboard`, `inactive`, `compare`, `export`, and `health` provide reports. Periods are 7d, 14d, 30d, 90d, or `custom` with `from` and `to` as `YYYY-MM-DD`. Role reports use current role holders and include zero activity. Role plus channel filters apply to text and voice; game activity has no channel filter. Server totals use distinct member IDs, including departed members with observations. Channel voice totals are **person-hours**, not elapsed occupied time. `/activity export scope:server` attaches CSV. `/attendance report csv:true` exports member-level attendance.

`/attendance create` asks for an ISO timestamp with UTC offset (such as `2026-09-16T19:00:00-04:00`), one to three voice channels, and a minimum. It previews before saving. Omit the end only for an open event to be ended manually. `/attendance update`, `start`, and `end` preview changes and require a reason; changes are audited and measured attendance is recalculated from retained intervals. `/attendance correct` records a signed minute adjustment with a reason. `/attendance list`, `report`, and `history` display events, results, and audit entries. Confirm controls expire after 15 minutes and are bound to the administrator and guild.

`/activity-config view`, `set`, `add`, `remove`, and `alias` control timezone, exclusions, LOA roles, voice rules, message cap, aliases, Apollo ID, retention, and newcomer grace. Configuration changes apply to new observations; stored intervals retain the rules in effect when observed. `/activity-data delete-member` and `reset-guild` require a confirmation click and remove source records and derived records in that guild.

### Apollo import

Use `/attendance import apollo_message_url:<Discord message URL> voice_channel:<voice> minimum:<minutes>`. The bot verifies the guild and the configured Apollo bot's user ID, parses only reliably accessible title, description, and explicit Discord or ISO start/end timestamps, and displays a preview. If required fields are missing, it opens a form to enter them. The administrator must always choose channels and minimum. The post ID is unique within a guild; separately posted recurring occurrences import as separate events. Apollo event and occurrence IDs are saved only if clearly present; the post ID is the reliable duplicate key.

`/attendance sync event:<ID>` re-fetches the post, previews changed readable fields, and applies only after confirmation. It preserves local channels, threshold and corrections. If the post is gone or inaccessible, it says so. Automatic sync is intentionally unavailable: `MESSAGE_UPDATE` may be missed during downtime and Apollo's post shape is not a stable documented integration contract. Do not use undocumented Apollo APIs or scrape its dashboard. Draft events and events awaiting a Discord post have no message URL to import. **Validate parsing against a real Apollo post in your server before relying on it.** A live post and credentials were not supplied with this project.

## Privacy and operations

Member notice you can post: “HWK Activity records message counts, Discord voice connection intervals and observed Playing presence for activity reports and voice attendance. It does not store message text, attachments, DMs, or audio. Administrators can view reports and request deletion.”

SQLite runs in WAL mode. A checkpoint writes open voice and game intervals every 30 seconds. After an unclean restart, sessions stop at the last checkpoint and the unobserved period becomes a coverage gap; current Gateway state starts new intervals. Retention (default 365 days) prunes messages and intervals. Old event recalculation may become incomplete; reports label that. Keep enough retention for your event history.

Backup with the bot stopped using `docker compose stop hwk-activity`, then copy the database file out of the named volume, including any `-wal` and `-shm` files if present. Alternatively, with SQLite CLI available, use `sqlite3 /data/activity.sqlite ".backup /data/backup.sqlite"` while running for a consistent snapshot. Restore with the bot stopped by replacing the database in the same volume, then start it. Keep backups private because IDs and audit data are present. Update with `docker compose up -d --build` after backing up. Migrations run at startup.

## Synthetic example reports

> Member `111…` | 2026-09-01 to 2026-09-30  
> Messages sent 84; rate-capped participation 62  
> Discord voice time: connected 12.5 h, qualifying 10.8 h  
> Observed game activity: 7.2 h (Arma Reforger)  
> Attendance #12: 1.3 h measured, +10m manual, met minimum  
> Tracking began 2026-08-01; no known gaps

> Event #12 “Wednesday Operation” — Discord voice attendance  
> Member `111…`: first arrival 19:03, last departure 20:21, measured 1.3 h, manual +10m, minimum met  
> Apollo post linked; RSVP count is not used

These examples are invented and are not live server data.

## Verification status

`npm test` uses an in-memory SQLite database and deterministic timestamps for deduplication, occupancy, deafen, moves, AFK, checkpoints, downtime, event boundaries, corrections, updates, duplicate Apollo posts, guild isolation, deletion, CSV safety, and daylight saving transitions. `npm run build` checks TypeScript. Live validation remains necessary for Gateway behavior and the exact layout of your Apollo posts. The bot cannot prove Discord delivered every event while connected, and absence of a game presence is not proof of inactivity.
