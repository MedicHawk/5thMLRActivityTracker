# HWK Activity

**Discord activity reporting and voice attendance for the 5th MLR Arma Reforger community**

HWK Activity gives server administrators a factual view of activity the bot directly observes after installation. Apollo remains the event scheduling system; HWK Activity records Discord engagement and measures attendance from qualifying Discord voice time.

## What it tracks

- **Messages sent:** Counts message creation events by member, channel, and date without storing message text, attachments, edits, DMs, bot messages, or webhooks. A configurable rate cap provides a separate participation count.
- **Discord voice time:** Records joins, leaves, channel moves, total connected time, qualifying time, session count, and time by channel. AFK and configured exclusions are respected. Optional rules can exclude self-deafened time or require two human members.
- **Observed game activity:** Measures Discord “Playing” presence from the moment the bot observes it. Game aliases normalize titles such as Arma Reforger.
- **Attendance:** Measures the union of qualifying voice intervals within an event’s time window and selected voice channels. Reports show arrival, departure, measured time, manual adjustments, and whether the minimum was met.
- **Community trends:** Provides active days, current and previous period comparisons, leaderboards, inactive-member review, daily and weekly activity, and CSV exports.

## Activity commands

| Command | Purpose |
|---|---|
| `/activity user` | Report one member’s messages, voice, game activity, active days, recent activity, and attendance. |
| `/activity role` | Report current members of a role, optionally filtered to a channel. |
| `/activity channel` | Show message and voice participation for a text, forum, thread, or voice channel. |
| `/activity server` | Summarize server-wide activity, active members, busy dates, and message hours. |
| `/activity game` | Report observed activity for a specified game. |
| `/activity leaderboard` | Rank members separately by messages, voice time, or game time. |
| `/activity inactive` | Find eligible role members with no observed messages or qualifying voice activity. |
| `/activity compare` | Compare a selected period with the immediately preceding period. |
| `/activity export` | Export server activity as CSV. |
| `/activity health` | Show tracking coverage, database status, stored rows, and Gateway event diagnostics. |

Activity reports support **7, 14, 30, or 90 days**, plus custom date ranges.

## Attendance commands

| Command | Purpose |
|---|---|
| `/attendance create` | Preview and create a scheduled or open attendance event. |
| `/attendance update` | Preview changes to an event’s name, time, channels, or minimum attendance. |
| `/attendance start` / `/attendance end` | Start or end an event at the current time. |
| `/attendance list` | List tracked events. |
| `/attendance report` | Show measured attendance and optionally export member results as CSV. |
| `/attendance import` | Import reliable event details from a configured Apollo post. |
| `/attendance sync` | Re-read an imported Apollo post and preview detected changes. |
| `/attendance correct` | Add a signed manual attendance adjustment with administrator and reason recorded. |
| `/attendance history` | Show event-setting changes and manual correction history. |

## Configuration and privacy

- `/activity-config view` shows effective server settings.
- `/activity-config set` changes timezone, Apollo bot ID, voice rules, participation cap, retention, or newcomer grace.
- `/activity-config add` and `/activity-config remove` manage excluded channels, categories, roles, and LOA roles.
- `/activity-config alias` normalizes observed game names.
- `/activity-data delete-member` deletes one member’s stored records after confirmation.
- `/activity-data reset-guild` clears the server’s tracked data after confirmation.

All commands are administrator-only. Data is isolated by Discord server and stored in SQLite using WAL mode. On Cybrancee, the database is normally `/home/container/data/activity.sqlite`; back it up before reinstalling or replacing files.

## Measurement limits

HWK Activity does not backfill activity from before it started and cannot reconstruct host outages. Hidden Discord presence or disabled activity sharing creates gaps in game tracking. Observed game presence does not prove an Arma server join, and an Apollo RSVP does not count as attendance. Reports identify the tracking start date and known coverage gaps so administrators can interpret results accurately.
