// src/bot.ts
import "dotenv/config";
import { Client, GatewayIntentBits, PermissionFlagsBits as PermissionFlagsBits2, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder, TextInputBuilder, TextInputStyle, ModalBuilder, escapeMarkdown } from "discord.js";

// src/db.ts
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
var defaults = { timezone: "America/New_York", excludedChannels: [], excludedCategories: [], excludedRoles: [], loaRoles: [], excludeSelfDeaf: false, requireTwoHumans: false, participationCap: 5, aliases: { "arma reforger": "Arma Reforger" }, apolloBotId: "", retentionDays: 365, newcomerGraceDays: 7 };
var Store = class {
  db;
  constructor(path) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.migrate();
  }
  migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)");
    if (this.db.prepare("SELECT 1 FROM migrations WHERE version=1").get()) return;
    this.db.exec(`CREATE TABLE IF NOT EXISTS guilds(guild_id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, config TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS heartbeats(guild_id TEXT PRIMARY KEY,last_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS members(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,joined_at INTEGER, PRIMARY KEY(guild_id,user_id));
      CREATE TABLE IF NOT EXISTS messages(guild_id TEXT NOT NULL,message_id TEXT NOT NULL,user_id TEXT NOT NULL,channel_id TEXT NOT NULL,parent_id TEXT,at INTEGER NOT NULL,participation INTEGER NOT NULL,PRIMARY KEY(guild_id,message_id));
      CREATE INDEX IF NOT EXISTS msg_period ON messages(guild_id,at,user_id);
      CREATE TABLE IF NOT EXISTS intervals(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,channel_id TEXT,game TEXT,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,qualifies INTEGER NOT NULL CHECK(qualifies IN(0,1)),CHECK(end_at>start_at));
      CREATE INDEX IF NOT EXISTS interval_period ON intervals(guild_id,kind,start_at,end_at);
      CREATE TABLE IF NOT EXISTS live(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,kind TEXT NOT NULL,channel_id TEXT,game TEXT,since_at INTEGER NOT NULL,checkpoint_at INTEGER NOT NULL,qualifies INTEGER NOT NULL,PRIMARY KEY(guild_id,user_id,kind));
      CREATE TABLE IF NOT EXISTS voice_sessions(guild_id TEXT NOT NULL,user_id TEXT NOT NULL,at INTEGER NOT NULL,channel_id TEXT NOT NULL,PRIMARY KEY(guild_id,user_id,at,channel_id));
      CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER NOT NULL,reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,start_at INTEGER NOT NULL,end_at INTEGER,channels TEXT NOT NULL,min_ms INTEGER NOT NULL,source TEXT NOT NULL,source_url TEXT,source_message_id TEXT,source_event_id TEXT,source_occurrence_id TEXT,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,created_by TEXT NOT NULL, UNIQUE(guild_id,source_message_id));
      CREATE INDEX IF NOT EXISTS event_period ON events(guild_id,start_at,end_at);
      CREATE TABLE IF NOT EXISTS event_audit(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,event_id INTEGER NOT NULL,actor_id TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corrections(id INTEGER PRIMARY KEY,guild_id TEXT NOT NULL,event_id INTEGER NOT NULL,user_id TEXT NOT NULL,minutes INTEGER NOT NULL,actor_id TEXT NOT NULL,at INTEGER NOT NULL,reason TEXT NOT NULL);
      INSERT OR IGNORE INTO migrations(version) VALUES(1);`);
  }
  ensureGuild(guild, now) {
    this.db.prepare("INSERT OR IGNORE INTO guilds VALUES(?,?,?)").run(guild, now, JSON.stringify(defaults));
    this.db.prepare("INSERT OR IGNORE INTO heartbeats VALUES(?,?)").run(guild, now);
  }
  config(guild) {
    const row = this.db.prepare("SELECT config FROM guilds WHERE guild_id=?").get(guild);
    return { ...defaults, ...row ? JSON.parse(row.config) : {} };
  }
  setConfig(guild, value) {
    this.db.prepare("UPDATE guilds SET config=? WHERE guild_id=?").run(JSON.stringify(value), guild);
  }
  member(guild, user, joined) {
    this.db.prepare("INSERT INTO members VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET joined_at=COALESCE(excluded.joined_at,members.joined_at)").run(guild, user, joined);
  }
  message(guild, id, user, channel, parent, at) {
    const cap = this.config(guild).participationCap;
    const window = at - 6e4;
    const count = this.db.prepare("SELECT COUNT(*) n FROM messages WHERE guild_id=? AND user_id=? AND at>? AND at<=?").get(guild, user, window, at).n;
    return this.db.prepare("INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)").run(guild, id, user, channel, parent, at, count < cap ? 1 : 0).changes > 0;
  }
  segment(guild, user, kind, start, end, qualifies, channel, game) {
    if (end <= start) return;
    this.db.prepare("INSERT INTO intervals(guild_id,user_id,kind,channel_id,game,start_at,end_at,qualifies) VALUES(?,?,?,?,?,?,?,?)").run(guild, user, kind, channel ?? null, game ?? null, start, end, qualifies ? 1 : 0);
  }
  live(guild, user, kind) {
    return this.db.prepare("SELECT * FROM live WHERE guild_id=? AND user_id=? AND kind=?").get(guild, user, kind);
  }
  startLive(guild, user, kind, at, qualifies, channel, game) {
    this.db.prepare("INSERT INTO live VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET channel_id=excluded.channel_id,game=excluded.game,since_at=excluded.since_at,checkpoint_at=excluded.checkpoint_at,qualifies=excluded.qualifies").run(guild, user, kind, channel ?? null, game ?? null, at, at, qualifies ? 1 : 0);
  }
  flushLive(guild, user, kind, at, remove = false) {
    const old = this.live(guild, user, kind);
    if (!old) return;
    const end = Math.max(at, old.since_at);
    this.segment(guild, user, kind, old.since_at, end, !!old.qualifies, old.channel_id, old.game);
    if (remove) this.db.prepare("DELETE FROM live WHERE guild_id=? AND user_id=? AND kind=?").run(guild, user, kind);
    else this.db.prepare("UPDATE live SET since_at=?,checkpoint_at=? WHERE guild_id=? AND user_id=? AND kind=?").run(end, end, guild, user, kind);
  }
  checkpoint(at) {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM live").all();
      for (const r of rows) this.flushLive(r.guild_id, r.user_id, r.kind, at);
      this.db.prepare("UPDATE heartbeats SET last_at=?").run(at);
    })();
  }
  recover(at) {
    this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM live").all();
      for (const r of rows) this.flushLive(r.guild_id, r.user_id, r.kind, r.checkpoint_at, true);
      for (const hb of this.db.prepare("SELECT guild_id,last_at FROM heartbeats").all()) if (at > hb.last_at) this.gap(hb.guild_id, hb.last_at, at, "Bot disconnected or restarted");
      this.db.prepare("UPDATE heartbeats SET last_at=?").run(at);
    })();
  }
  gap(guild, start, end, reason) {
    if (end > start) this.db.prepare("INSERT INTO gaps(guild_id,start_at,end_at,reason) VALUES(?,?,?,?)").run(guild, start, end, reason);
  }
  prune(guild, now) {
    const cutoff = now - this.config(guild).retentionDays * 864e5;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages WHERE guild_id=? AND at<?").run(guild, cutoff);
      this.db.prepare("DELETE FROM voice_sessions WHERE guild_id=? AND at<?").run(guild, cutoff);
      this.db.prepare("DELETE FROM intervals WHERE guild_id=? AND end_at<?").run(guild, cutoff);
      this.db.prepare("UPDATE intervals SET start_at=? WHERE guild_id=? AND start_at<? AND end_at>?").run(cutoff, guild, cutoff, cutoff);
    })();
  }
  deleteMember(guild, user) {
    this.db.transaction(() => {
      for (const table of ["messages", "intervals", "live", "voice_sessions", "corrections", "members"]) this.db.prepare(`DELETE FROM ${table} WHERE guild_id=? AND user_id=?`).run(guild, user);
    })();
  }
  resetGuild(guild, now) {
    this.db.transaction(() => {
      for (const table of ["messages", "intervals", "live", "voice_sessions", "gaps", "events", "event_audit", "corrections", "members"]) this.db.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guild);
      this.db.prepare("UPDATE guilds SET started_at=? WHERE guild_id=?").run(now, guild);
      this.db.prepare("UPDATE heartbeats SET last_at=? WHERE guild_id=?").run(now, guild);
    })();
  }
  close() {
    this.db.close();
  }
};

// src/collect.ts
var Collector = class {
  constructor(store2) {
    this.store = store2;
  }
  voice = /* @__PURE__ */ new Map();
  key(g, u) {
    return `${g}:${u}`;
  }
  message(input) {
    if (input.bot || input.webhook) return false;
    const c = this.store.config(input.guild);
    if (c.excludedChannels.includes(input.channel) || !!input.parent && c.excludedChannels.includes(input.parent) || !!input.category && c.excludedCategories.includes(input.category) || input.roleIds?.some((r) => c.excludedRoles.includes(r))) return false;
    this.store.ensureGuild(input.guild, input.at);
    return this.store.message(input.guild, input.id, input.user, input.channel, input.parent, input.at);
  }
  voiceUpdate(next) {
    const key = this.key(next.guild, next.user);
    const prev = this.voice.get(key);
    const affected = new Set([prev?.channel, next.channel].filter((v) => !!v));
    const at = next.at;
    this.store.db.transaction(() => {
      for (const state of this.voice.values()) if (state.guild === next.guild && state.channel && affected.has(state.channel)) this.store.flushLive(state.guild, state.user, "voice", at, true);
      if (next.bot || !next.channel) this.voice.delete(key);
      else this.voice.set(key, next);
      if (next.channel && (!prev || prev.channel !== next.channel) && !next.bot) this.store.db.prepare("INSERT OR IGNORE INTO voice_sessions VALUES(?,?,?,?)").run(next.guild, next.user, at, next.channel);
      for (const state of this.voice.values()) if (state.guild === next.guild && state.channel && affected.has(state.channel)) this.store.startLive(state.guild, state.user, "voice", at, this.qualifies(state), state.channel);
    })();
  }
  qualifies(s) {
    const c = this.store.config(s.guild);
    return !!s.channel && s.channel !== s.afk && !c.excludedChannels.includes(s.channel) && !c.excludedCategories.includes(s.parent ?? "") && !s.roleIds?.some((r) => c.excludedRoles.includes(r)) && (!c.excludeSelfDeaf || !s.selfDeaf) && (!c.requireTwoHumans || [...this.voice.values()].filter((v) => v.guild === s.guild && v.channel === s.channel && !v.bot).length >= 2);
  }
  presence(input) {
    if (input.bot) return;
    const c = this.store.config(input.guild);
    const games = input.roleIds?.some((r) => c.excludedRoles.includes(r)) ? [] : [...new Set(input.games.map((g) => c.aliases[g.toLowerCase()] ?? g.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const selected = games[0] ?? null;
    const old = this.store.live(input.guild, input.user, "game");
    if (old?.game === selected) return;
    this.store.db.transaction(() => {
      if (old) this.store.flushLive(input.guild, input.user, "game", input.at, true);
      if (selected) this.store.startLive(input.guild, input.user, "game", input.at, true, null, selected);
    })();
  }
  clearMemory() {
    this.voice.clear();
  }
  reconcileVoice(states) {
    for (const s of states) this.voiceUpdate(s);
  }
};

// src/commands.ts
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, REST, Routes, InteractionContextType } from "discord.js";
var admin = (name, description) => new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
var period = (s) => s.addStringOption((o) => o.setName("period").setDescription("7d, 14d, 30d, 90d or custom").addChoices(...["7d", "14d", "30d", "90d", "custom"].map((x) => ({ name: x, value: x })))).addStringOption((o) => o.setName("from").setDescription("Custom start date YYYY-MM-DD")).addStringOption((o) => o.setName("to").setDescription("Custom end date YYYY-MM-DD"));
var voice = (o) => o.addChannelOption((x) => x.setName("voice_channel").setDescription("Attendance voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(true)).addChannelOption((x) => x.setName("voice_channel_2").setDescription("Second voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)).addChannelOption((x) => x.setName("voice_channel_3").setDescription("Third voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice));
var activity = admin("activity", "Observed activity reports").addSubcommand((s) => period(s.setName("user").setDescription("Member report").addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)))).addSubcommand((s) => period(s.setName("role").setDescription("Current role members").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)).addChannelOption((o) => o.setName("channel").setDescription("Optional text or voice filter")))).addSubcommand((s) => period(s.setName("channel").setDescription("Channel report").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))).addSubcommand((s) => period(s.setName("server").setDescription("Server report"))).addSubcommand((s) => period(s.setName("game").setDescription("Game report").addStringOption((o) => o.setName("game").setDescription("Game name").setRequired(true)))).addSubcommand((s) => period(s.setName("leaderboard").setDescription("Separate metric ranking").addStringOption((o) => o.setName("metric").setDescription("Metric").setRequired(true).addChoices({ name: "messages", value: "messages" }, { name: "voice", value: "voice" }, { name: "game", value: "game" })))).addSubcommand((s) => s.setName("inactive").setDescription("No observed qualifying activity").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)).addIntegerOption((o) => o.setName("days").setDescription("Lookback days").setMinValue(1).setMaxValue(365).setRequired(true))).addSubcommand((s) => period(s.setName("compare").setDescription("Current versus previous period"))).addSubcommand((s) => period(s.setName("export").setDescription("CSV export").addStringOption((o) => o.setName("scope").setDescription("Export scope").setRequired(true).addChoices({ name: "server", value: "server" }, { name: "attendance", value: "attendance" })))).addSubcommand((s) => s.setName("health").setDescription("Tracking coverage and configuration"));
var attendance = admin("attendance", "Discord voice attendance").addSubcommand((s) => voice(s.setName("create").setDescription("Preview a new event").addStringOption((o) => o.setName("name").setDescription("Event name").setRequired(true)).addStringOption((o) => o.setName("start").setDescription("ISO date/time with UTC offset").setRequired(true)).addIntegerOption((o) => o.setName("minimum").setDescription("Minimum minutes").setMinValue(0).setRequired(true))).addStringOption((o) => o.setName("end").setDescription("ISO date/time with UTC offset")).addStringOption((o) => o.setName("description").setDescription("Description"))).addSubcommand((s) => s.setName("update").setDescription("Preview an event change").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)).addStringOption((o) => o.setName("name").setDescription("New name")).addStringOption((o) => o.setName("description").setDescription("New description")).addStringOption((o) => o.setName("start").setDescription("New ISO start")).addStringOption((o) => o.setName("end").setDescription("New ISO end")).addChannelOption((o) => o.setName("voice_channel").setDescription("Replace channels with this voice channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)).addChannelOption((o) => o.setName("voice_channel_2").setDescription("Second replacement channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)).addChannelOption((o) => o.setName("voice_channel_3").setDescription("Third replacement channel").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)).addIntegerOption((o) => o.setName("minimum").setDescription("Minimum minutes").setMinValue(0))).addSubcommand((s) => s.setName("start").setDescription("Start event now").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))).addSubcommand((s) => s.setName("end").setDescription("End event now").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true))).addSubcommand((s) => s.setName("report").setDescription("Attendance report").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true)).addUserOption((o) => o.setName("member").setDescription("Optional member")).addRoleOption((o) => o.setName("role").setDescription("Optional current role")).addBooleanOption((o) => o.setName("csv").setDescription("Attach CSV"))).addSubcommand((s) => s.setName("list").setDescription("Tracked events")).addSubcommand((s) => s.setName("history").setDescription("Event setting and correction audit").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true))).addSubcommand((s) => voice(s.setName("import").setDescription("Preview Apollo post import").addStringOption((o) => o.setName("apollo_message_url").setDescription("Discord message link").setRequired(true)).addIntegerOption((o) => o.setName("minimum").setDescription("Minimum minutes").setRequired(true).setMinValue(0)))).addSubcommand((s) => s.setName("sync").setDescription("Preview changes from Apollo post").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true))).addSubcommand((s) => s.setName("correct").setDescription("Manual attendance correction").addIntegerOption((o) => o.setName("event").setDescription("Event ID").setRequired(true)).addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true)).addIntegerOption((o) => o.setName("minutes").setDescription("Signed adjustment minutes").setRequired(true)).addStringOption((o) => o.setName("reason").setDescription("Reason").setRequired(true)));
var config = admin("activity-config", "Tracking configuration").addSubcommand((s) => s.setName("view").setDescription("View effective settings")).addSubcommand((s) => s.setName("set").setDescription("Set a configuration value").addStringOption((o) => o.setName("key").setDescription("Setting").setRequired(true).addChoices(...["timezone", "apolloBotId", "excludeSelfDeaf", "requireTwoHumans", "participationCap", "retentionDays", "newcomerGraceDays"].map((x) => ({ name: x, value: x })))).addStringOption((o) => o.setName("value").setDescription("New value").setRequired(true))).addSubcommand((s) => s.setName("add").setDescription("Add excluded channel/category/role or LOA role").addStringOption((o) => o.setName("list").setDescription("List").setRequired(true).addChoices(...["excludedChannels", "excludedCategories", "excludedRoles", "loaRoles"].map((x) => ({ name: x, value: x })))).addStringOption((o) => o.setName("id").setDescription("Discord ID").setRequired(true))).addSubcommand((s) => s.setName("remove").setDescription("Remove list entry").addStringOption((o) => o.setName("list").setDescription("List").setRequired(true).addChoices(...["excludedChannels", "excludedCategories", "excludedRoles", "loaRoles"].map((x) => ({ name: x, value: x })))).addStringOption((o) => o.setName("id").setDescription("Discord ID").setRequired(true))).addSubcommand((s) => s.setName("alias").setDescription("Set a game alias").addStringOption((o) => o.setName("observed").setDescription("Observed game name").setRequired(true)).addStringOption((o) => o.setName("canonical").setDescription("Canonical game name").setRequired(true)));
var privacy = admin("activity-data", "Delete tracked data with confirmation").addSubcommand((s) => s.setName("delete-member").setDescription("Delete one member\u2019s stored activity").addUserOption((o) => o.setName("member").setDescription("Member").setRequired(true))).addSubcommand((s) => s.setName("reset-guild").setDescription("Reset this server\u2019s stored activity"));
var commands = [activity, attendance, config, privacy];
async function register(token2, clientId, guildId) {
  const rest = new REST({ version: "10" }).setToken(token2);
  await rest.put(guildId ? Routes.applicationGuildCommands(clientId, guildId) : Routes.applicationCommands(clientId), { body: commands.map((c) => c.toJSON()) });
}

// src/time.ts
function dateParts(at, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const get = (name) => parts.find((x) => x.type === name)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}
function localMidnight(date, zone) {
  if (!/^\d{4}-\d\d-\d\d$/.test(date)) throw new Error("Date must be YYYY-MM-DD");
  const target = Date.parse(date + "T00:00:00Z");
  if (!Number.isFinite(target)) throw new Error("Invalid date");
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(guess);
    const v = (k) => Number(p.find((x) => x.type === k)?.value);
    const asUtc = Date.UTC(v("year"), v("month") - 1, v("day"), v("hour"), v("minute"), v("second"));
    guess += target - asUtc;
  }
  if (dateParts(guess, zone).date !== date) throw new Error("Invalid local date");
  return guess;
}
function period2(now, days, zone) {
  const today = dateParts(now, zone).date;
  const tomorrow = /* @__PURE__ */ new Date(today + "T00:00:00Z");
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const end = localMidnight(tomorrow.toISOString().slice(0, 10), zone);
  const d = /* @__PURE__ */ new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days + 1);
  const start = localMidnight(d.toISOString().slice(0, 10), zone);
  return { start, end: Math.max(end, now) };
}
function union(intervals) {
  const sorted = intervals.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0, end = -Infinity;
  for (const [a, b] of sorted) {
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

// src/reports.ts
function segments(store2, guild, kind, start, end, now) {
  const rows = store2.db.prepare("SELECT user_id,channel_id,game,start_at,end_at,qualifies FROM intervals WHERE guild_id=? AND kind=? AND end_at>? AND start_at<?").all(guild, kind, start, end);
  const live = store2.db.prepare("SELECT user_id,channel_id,game,since_at start_at,? end_at,qualifies FROM live WHERE guild_id=? AND kind=? AND since_at<?").all(now, guild, kind, end);
  return [...rows, ...live].map((r) => ({ ...r, start_at: Math.max(start, r.start_at), end_at: Math.min(end, r.end_at) })).filter((r) => r.end_at > r.start_at);
}
function coverage(store2, guild, start, end) {
  const row = store2.db.prepare("SELECT started_at FROM guilds WHERE guild_id=?").get(guild);
  const gaps = store2.db.prepare("SELECT start_at,end_at,reason FROM gaps WHERE guild_id=? AND end_at>? AND start_at<? ORDER BY start_at").all(guild, start, end);
  const retained = Date.now() - store2.config(guild).retentionDays * 864e5;
  return { trackingStarted: row?.started_at ?? null, gaps, incomplete: !row || start < row.started_at || start < retained || gaps.length > 0 };
}
function userReport(store2, guild, user, start, end, now, channel) {
  const msgs = store2.db.prepare("SELECT channel_id,parent_id,at,participation FROM messages WHERE guild_id=? AND user_id=? AND at>=? AND at<?").all(guild, user, start, end).filter((m) => !channel || m.channel_id === channel || m.parent_id === channel);
  const v = segments(store2, guild, "voice", start, end, now).filter((s) => s.user_id === user && (!channel || s.channel_id === channel));
  const g = channel ? [] : segments(store2, guild, "game", start, end, now).filter((s) => s.user_id === user);
  const cfg = store2.config(guild);
  const dates = /* @__PURE__ */ new Set();
  for (const m of msgs) dates.add(dateParts(m.at, cfg.timezone).date);
  for (const s of [...v.filter((x) => x.qualifies), ...g]) {
    let t = s.start_at;
    while (t < s.end_at) {
      dates.add(dateParts(t, cfg.timezone).date);
      t += 864e5;
    }
    dates.add(dateParts(s.end_at - 1, cfg.timezone).date);
  }
  const channelCounts = /* @__PURE__ */ new Map();
  for (const m of msgs) channelCounts.set(m.parent_id ?? m.channel_id, (channelCounts.get(m.parent_id ?? m.channel_id) ?? 0) + 1);
  const voiceChannels = /* @__PURE__ */ new Map();
  for (const s of v) if (s.channel_id) voiceChannels.set(s.channel_id, (voiceChannels.get(s.channel_id) ?? 0) + s.end_at - s.start_at);
  const games = /* @__PURE__ */ new Map();
  for (const s of g) if (s.game) games.set(s.game, (games.get(s.game) ?? 0) + s.end_at - s.start_at);
  const max = (arr) => arr.length ? Math.max(...arr) : null;
  const lastMsg = store2.db.prepare("SELECT MAX(at) n FROM messages WHERE guild_id=? AND user_id=?").get(guild, user);
  const last = (kind) => store2.db.prepare("SELECT MAX(end_at) n FROM intervals WHERE guild_id=? AND user_id=? AND kind=?").get(guild, user, kind);
  const sort = (map) => [...map].sort((a, b) => b[1] - a[1]);
  const sessions = store2.db.prepare("SELECT COUNT(*) n FROM voice_sessions WHERE guild_id=? AND user_id=? AND at>=? AND at<?").get(guild, user, start, end).n;
  return { user, messages: msgs.length, participation: msgs.reduce((a, m) => a + m.participation, 0), connectedMs: union(v.map((s) => [s.start_at, s.end_at])), qualifyingMs: union(v.filter((s) => s.qualifies).map((s) => [s.start_at, s.end_at])), sessions, gameMs: union(g.map((s) => [s.start_at, s.end_at])), games: sort(games), activeDays: dates.size, lastMessage: lastMsg.n, lastVoice: max([last("voice").n ?? 0, ...v.map((s) => s.end_at)].filter(Boolean)), lastGame: max([last("game").n ?? 0, ...g.map((s) => s.end_at)].filter(Boolean)), textChannels: sort(channelCounts), voiceChannels: sort(voiceChannels), coverage: coverage(store2, guild, start, end) };
}
function roleReport(store2, guild, ids, start, end, now, channel) {
  const rows = ids.map((id) => userReport(store2, guild, id, start, end, now, channel));
  return { rows, totals: { messages: rows.reduce((a, r) => a + r.messages, 0), participation: rows.reduce((a, r) => a + r.participation, 0), voiceMs: rows.reduce((a, r) => a + r.qualifyingMs, 0), gameMs: rows.reduce((a, r) => a + r.gameMs, 0), active: rows.filter((r) => r.messages || r.qualifyingMs || r.gameMs).length } };
}
function serverCalendar(store2, guild, start, end, now) {
  const zone = store2.config(guild).timezone;
  const daily = /* @__PURE__ */ new Map(), hours = /* @__PURE__ */ new Map();
  const add = (date, user) => {
    if (!daily.has(date)) daily.set(date, /* @__PURE__ */ new Set());
    daily.get(date).add(user);
  };
  const msgs = store2.db.prepare("SELECT user_id,at FROM messages WHERE guild_id=? AND at>=? AND at<?").all(guild, start, end);
  for (const m of msgs) {
    const p = dateParts(m.at, zone);
    add(p.date, m.user_id);
    hours.set(p.hour, (hours.get(p.hour) ?? 0) + 1);
  }
  for (const s of [...segments(store2, guild, "voice", start, end, now).filter((x) => x.qualifies), ...segments(store2, guild, "game", start, end, now)]) {
    let t = s.start_at;
    while (t < s.end_at) {
      add(dateParts(t, zone).date, s.user_id);
      t += 36e5;
    }
    add(dateParts(s.end_at - 1, zone).date, s.user_id);
  }
  const weekly = /* @__PURE__ */ new Map();
  for (const [date, users] of daily) {
    const d = /* @__PURE__ */ new Date(date + "T00:00:00Z"), weekday = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - weekday);
    const key = d.toISOString().slice(0, 10);
    if (!weekly.has(key)) weekly.set(key, /* @__PURE__ */ new Set());
    users.forEach((u) => weekly.get(key).add(u));
  }
  return { daily: [...daily].map(([date, users]) => ({ date, active: users.size })).sort((a, b) => a.date.localeCompare(b.date)), weekly: [...weekly].map(([week, users]) => ({ week, active: users.size })).sort((a, b) => a.week.localeCompare(b.week)), busiestMessageHours: [...hours].sort((a, b) => b[1] - a[1]) };
}
function inactiveCandidates(store2, guild, members, start, end, now) {
  const c = store2.config(guild), cov = coverage(store2, guild, start, end);
  const eligible = members.filter((m) => !m.roles.some((r) => c.loaRoles.includes(r) || c.excludedRoles.includes(r)) && m.joinedAt !== null && m.joinedAt <= now - c.newcomerGraceDays * 864e5);
  const ids = eligible.filter((m) => {
    const r = userReport(store2, guild, m.id, start, end, now);
    return !(r.messages || r.qualifyingMs);
  }).map((m) => m.id);
  return { ids, coverage: cov };
}
function attendance2(store2, guild, eventId, now) {
  const event = store2.db.prepare("SELECT * FROM events WHERE guild_id=? AND id=?").get(guild, eventId);
  if (!event) throw new Error("Event not found in this server");
  const end = Math.min(event.end_at ?? now, now), channels = JSON.parse(event.channels);
  const all = segments(store2, guild, "voice", event.start_at, end, now).filter((s) => s.qualifies && !!s.channel_id && channels.includes(s.channel_id));
  const users = new Set(all.map((s) => s.user_id));
  const corrections = store2.db.prepare("SELECT user_id,SUM(minutes) minutes FROM corrections WHERE guild_id=? AND event_id=? GROUP BY user_id").all(guild, eventId);
  corrections.forEach((c) => users.add(c.user_id));
  const rows = [...users].map((user) => {
    const mine = all.filter((s) => s.user_id === user), measuredMs = union(mine.map((s) => [s.start_at, s.end_at]));
    const adjustmentMinutes = corrections.find((c) => c.user_id === user)?.minutes ?? 0;
    return { user, arrival: mine.length ? Math.min(...mine.map((x) => x.start_at)) : null, departure: mine.length ? Math.max(...mine.map((x) => x.end_at)) : null, measuredMs, adjustmentMinutes, metMinimum: measuredMs + adjustmentMinutes * 6e4 >= event.min_ms };
  }).sort((a, b) => b.measuredMs - a.measuredMs);
  return { event, rows, coverage: coverage(store2, guild, event.start_at, end), recalculated: event.revision > 1 };
}
function csvCell(v) {
  let s = String(v ?? "");
  if (/^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
function csv(rows) {
  return "\uFEFF" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

// src/events.ts
function validate(e) {
  if (!e.name.trim() || e.name.length > 100) throw new Error("Event name must be 1\u2013100 characters");
  if (!Number.isFinite(e.start) || e.end !== null && (!Number.isFinite(e.end) || e.end <= e.start)) throw new Error("End time must be after start time");
  if (!e.channels.length || new Set(e.channels).size !== e.channels.length) throw new Error("Choose distinct voice channels");
  if (!Number.isSafeInteger(e.minimumMinutes) || e.minimumMinutes < 0 || e.minimumMinutes > 10080) throw new Error("Invalid minimum attendance");
}
function createEvent(store2, guild, actor, e, now) {
  validate(e);
  return store2.db.transaction(() => {
    const result = store2.db.prepare(`INSERT INTO events(guild_id,name,description,start_at,end_at,channels,min_ms,source,source_url,source_message_id,source_event_id,source_occurrence_id,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(guild, e.name, e.description ?? "", e.start, e.end, JSON.stringify(e.channels), e.minimumMinutes * 6e4, e.source ?? "manual", e.sourceUrl ?? null, e.sourceMessageId ?? null, e.sourceEventId ?? null, e.sourceOccurrenceId ?? null, now, now, actor);
    const id = Number(result.lastInsertRowid);
    store2.db.prepare("INSERT INTO event_audit(guild_id,event_id,actor_id,at,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?)").run(guild, id, actor, now, "Created", null, JSON.stringify(e));
    return id;
  })();
}
function updateEvent(store2, guild, id, actor, patch, reason, now) {
  if (!reason.trim()) throw new Error("Reason is required");
  return store2.db.transaction(() => {
    const old = store2.db.prepare("SELECT * FROM events WHERE guild_id=? AND id=?").get(guild, id);
    if (!old) throw new Error("Event not found");
    const e = { name: patch.name ?? old.name, description: patch.description ?? old.description, start: patch.start ?? old.start_at, end: patch.end === void 0 ? old.end_at : patch.end, channels: patch.channels ?? JSON.parse(old.channels), minimumMinutes: patch.minimumMinutes ?? old.min_ms / 6e4, source: old.source, sourceUrl: old.source_url ?? void 0, sourceMessageId: old.source_message_id ?? void 0, sourceEventId: old.source_event_id ?? void 0, sourceOccurrenceId: old.source_occurrence_id ?? void 0 };
    validate(e);
    const changed = old.start_at !== e.start || old.end_at !== e.end || old.channels !== JSON.stringify(e.channels) || old.min_ms !== e.minimumMinutes * 6e4;
    store2.db.prepare("UPDATE events SET name=?,description=?,start_at=?,end_at=?,channels=?,min_ms=?,revision=revision+?,updated_at=? WHERE guild_id=? AND id=?").run(e.name, e.description, e.start, e.end, JSON.stringify(e.channels), e.minimumMinutes * 6e4, changed ? 1 : 0, now, guild, id);
    store2.db.prepare("INSERT INTO event_audit(guild_id,event_id,actor_id,at,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?)").run(guild, id, actor, now, reason, JSON.stringify(old), JSON.stringify(e));
    return changed;
  })();
}
function correctAttendance(store2, guild, event, user, minutes, actor, reason, now) {
  if (!reason.trim() || !Number.isSafeInteger(minutes)) throw new Error("A reason and integer minutes are required");
  const exists = store2.db.prepare("SELECT 1 FROM events WHERE guild_id=? AND id=?").get(guild, event);
  if (!exists) throw new Error("Event not found");
  store2.db.prepare("INSERT INTO corrections(guild_id,event_id,user_id,minutes,actor_id,at,reason) VALUES(?,?,?,?,?,?,?)").run(guild, event, user, minutes, actor, now, reason);
}
function parseApollo(message) {
  const embed = message.embeds?.[0];
  const text = [message.content ?? "", embed?.description ?? "", ...(embed?.fields ?? []).map((f) => `${f.name}: ${f.value}`)].join("\n");
  const time = (label) => {
    const field = embed?.fields?.find((f) => new RegExp(label, "i").test(f.name));
    const source = field?.value ?? text.match(new RegExp(`${label}[^
]*`, "i"))?.[0] ?? "";
    const discord = source.match(/<t:(\d{9,12})(?::[tTdDfFR])?>/);
    if (discord) return Number(discord[1]) * 1e3;
    const iso = source.match(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:?\d\d)/);
    return iso ? Date.parse(iso[0]) : null;
  };
  const id = embed?.url?.match(/(?:event|events)\/(\d+)/)?.[1] ?? null;
  return { name: embed?.title?.trim() || null, description: embed?.description?.trim() || null, start: time("start"), end: time("end"), eventId: id, occurrenceId: null };
}

// src/bot.ts
import { openSync, closeSync, unlinkSync, writeFileSync, statSync } from "node:fs";
var token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");
var fallbackDatabasePath = "data/activity.sqlite";
var databasePath = process.env.DATABASE_PATH ?? fallbackDatabasePath;
var store;
try {
  store = new Store(databasePath);
} catch (error) {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  if (databasePath !== fallbackDatabasePath && ["EACCES", "ENOENT", "EPERM", "EROFS"].includes(code)) {
    console.warn(`Cannot use DATABASE_PATH ${databasePath} (${code}); falling back to ${fallbackDatabasePath}`);
    databasePath = fallbackDatabasePath;
    store = new Store(databasePath);
  } else throw error;
}
var lockPath = databasePath + ".instance.lock";
function lock() {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${process.pid}`);
    return fd;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 12e4) {
        unlinkSync(lockPath);
        return lock();
      }
    } catch {
    }
    throw new Error("Another bot instance appears to own this database");
  }
}
var lockFd = lock();
var lockBeat = setInterval(() => {
  try {
    writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
  } catch {
  }
}, 3e4);
var intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers];
if (process.env.APOLLO_IMPORT_ENABLED === "true") intents.push(GatewayIntentBits.MessageContent);
var client = new Client({ intents });
var collector = new Collector(store);
var processStarted = Date.now();
var gatewayEvents = { messages: 0, voice: 0, presence: 0 };
var pending = /* @__PURE__ */ new Map();
var safe = { parse: [], users: [], roles: [] };
function ms(n) {
  return `${(n / 36e5).toFixed(1)} h`;
}
function stamp(n) {
  return n ? `<t:${Math.floor(n / 1e3)}:f>` : "none observed";
}
function memberLabel(g, id) {
  const guild = client.guilds.cache.get(g), member = guild?.members.cache.get(id), user = member?.user ?? client.users.cache.get(id), name = member?.displayName ?? user?.globalName ?? user?.username;
  return name ? escapeMarkdown(name) : `<@${id}>`;
}
function channelLabel(g, id) {
  const name = client.guilds.cache.get(g)?.channels.cache.get(id)?.name;
  return name ? `#${escapeMarkdown(name)}` : `<#${id}>`;
}
function auditValue(g, value) {
  if (!value) return "none";
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed.channels)) parsed.channels = parsed.channels.map((id) => channelLabel(g, id));
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}
function requireAdmin(i) {
  if (!i.inGuild() || !i.guildId || !i.memberPermissions?.has(PermissionFlagsBits2.Administrator)) throw new Error("Administrator permission in a server is required");
  return i.guildId;
}
function when(s) {
  if (!/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(s)) throw new Error("Use ISO date/time with Z or UTC offset, e.g. 2026-09-16T19:00:00-04:00");
  const n = Date.parse(s);
  if (!Number.isFinite(n)) throw new Error("Invalid date/time");
  return n;
}
function range(i, now) {
  const p = i.options.getString("period") ?? "30d", zone = store.config(i.guildId).timezone;
  if (p === "custom") {
    const a = i.options.getString("from"), b = i.options.getString("to");
    if (!a || !b) throw new Error("Custom period requires from and to dates");
    const start = localMidnight(a, zone), endDate = /* @__PURE__ */ new Date(b + "T00:00:00Z");
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const end = localMidnight(endDate.toISOString().slice(0, 10), zone);
    if (end <= start) throw new Error("End date must be after start");
    return { start, end };
  }
  return period2(now, Number(p.slice(0, -1)), zone);
}
function preview(i, label, action) {
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  pending.set(id, { guild: i.guildId, actor: i.user.id, expires: Date.now() + 15 * 6e4, label, action });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ok:" + id).setLabel("Confirm").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("no:" + id).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
  return i.deferred || i.replied ? i.editReply({ content: label, components: [row], allowedMentions: safe }) : i.reply({ content: label, components: [row], flags: MessageFlags.Ephemeral, allowedMentions: safe });
}
async function respond(i, content, files) {
  if (!i.deferred) await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply({ content: content.slice(0, 1900), files, allowedMentions: safe });
}
function eventRow(g, id) {
  const e = store.db.prepare("SELECT * FROM events WHERE guild_id=? AND id=?").get(g, id);
  if (!e) throw new Error("Event not found in this server");
  return e;
}
function selectedChannels(i) {
  return ["voice_channel", "voice_channel_2", "voice_channel_3"].map((k) => i.options.getChannel(k)?.id).filter((x) => !!x);
}
function formatUser(g, u, start, end, now) {
  const r = userReport(store, g, u, start, end, now);
  const events = store.db.prepare("SELECT id FROM events WHERE guild_id=? AND start_at<? AND COALESCE(end_at,?)>? ORDER BY start_at DESC LIMIT 10").all(g, end, now, start);
  const results = events.map((e) => {
    const row = attendance2(store, g, e.id, now).rows.find((x) => x.user === u);
    return row ? `#${e.id}: ${ms(row.measuredMs)} measured, ${row.adjustmentMinutes}m manual, ${row.metMinimum ? "met" : "below"} minimum` : null;
  }).filter(Boolean);
  return [`Member ${memberLabel(g, u)} | ${dateParts(start, store.config(g).timezone).date} to ${dateParts(end - 1, store.config(g).timezone).date}`, `Messages sent ${r.messages}; rate-capped participation ${r.participation}`, `Discord voice time: connected ${ms(r.connectedMs)}, qualifying ${ms(r.qualifyingMs)}, ${r.sessions} sessions`, `Observed game activity: ${ms(r.gameMs)} (${r.games.slice(0, 5).map(([n, t]) => `${n} ${ms(t)}`).join(", ") || "none"})`, `Unique active days ${r.activeDays}; last message ${stamp(r.lastMessage)}; voice ${stamp(r.lastVoice)}; game ${stamp(r.lastGame)}`, `Top text channels ${r.textChannels.slice(0, 3).map(([c, n]) => `${channelLabel(g, c)}: ${n}`).join(", ") || "none"}; voice channels ${r.voiceChannels.slice(0, 3).map(([c, n]) => `${channelLabel(g, c)}: ${ms(n)}`).join(", ") || "none"}`, `Attendance: ${results.join("; ") || "none observed"}`, `Tracking began ${stamp(r.coverage.trackingStarted)}; coverage ${r.coverage.incomplete ? "incomplete" : "no known gaps"}. Hidden game presence and outages can leave gaps. Game presence does not verify server participation.`].join("\n");
}
function currentMembers(i, roleId) {
  const guild = i.guild;
  return [...guild.members.cache.values()].filter((m) => !m.user.bot && (!roleId || m.roles.cache.has(roleId)));
}
async function fetchMembers(i) {
  await i.guild.members.fetch();
}
async function activityCommand(i, g) {
  const sub = i.options.getSubcommand(), now = Date.now();
  store.ensureGuild(g, now);
  if (sub === "health") {
    const c = store.config(g), row = store.db.prepare("SELECT started_at FROM guilds WHERE guild_id=?").get(g);
    const gaps = store.db.prepare("SELECT start_at,end_at,reason FROM gaps WHERE guild_id=? ORDER BY start_at DESC LIMIT 5").all(g);
    const count = (table) => store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE guild_id=?`).get(g).n;
    const lastHeartbeat = store.db.prepare("SELECT last_at FROM heartbeats WHERE guild_id=?").get(g)?.last_at ?? null;
    return respond(i, `Tracking began ${stamp(row.started_at)}. Process started ${stamp(processStarted)}; last database checkpoint ${stamp(lastHeartbeat)}.
Database ${databasePath} (WAL enabled). Stored rows: ${count("messages")} messages, ${count("intervals")} completed intervals, ${count("live")} live intervals, ${count("voice_sessions")} voice sessions.
Gateway events received this process: ${gatewayEvents.messages} messages, ${gatewayEvents.voice} voice changes, ${gatewayEvents.presence} presence changes.
Recent coverage gaps: ${gaps.length ? gaps.map((x) => `${stamp(x.start_at)}\u2013${stamp(x.end_at)} ${x.reason}`).join("\n") : "none known"}
Retention ${c.retentionDays} days; timezone ${c.timezone}. Continuous hosting is required.`);
  }
  if (sub === "inactive") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    await fetchMembers(i);
    const days = i.options.getInteger("days", true), r2 = period2(now, days, store.config(g).timezone), role = i.options.getRole("role", true);
    const members = currentMembers(i, role.id), result = inactiveCandidates(store, g, members.map((m) => ({ id: m.id, roles: [...m.roles.cache.keys()], joinedAt: m.joinedTimestamp })), r2.start, r2.end, now);
    return respond(i, `${result.coverage.incomplete ? "Insufficient tracking coverage; review these unobserved members manually." : "No observed qualifying activity"} in ${days} days for current role ${escapeMarkdown(role.name)}: ${result.ids.map((id) => memberLabel(g, id)).join(", ") || "none"}
Rules: messages or qualifying Discord voice time; LOA, excluded roles and new members excluded. Game presence alone is never grounds for a flag.`, [new AttachmentBuilder(Buffer.from(csv([["member_name", "member_id"], ...result.ids.map((id) => [memberLabel(g, id), id])])), { name: "inactive.csv" })]);
  }
  const r = range(i, now);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (sub === "user") return respond(i, formatUser(g, i.options.getUser("member", true).id, r.start, r.end, now));
  if (sub === "role") {
    await fetchMembers(i);
    const role = i.options.getRole("role", true);
    const channel = i.options.getChannel("channel");
    const ids2 = currentMembers(i, role.id).map((m) => m.id), report = roleReport(store, g, ids2, r.start, r.end, now, channel?.id);
    return respond(i, `Current members of ${escapeMarkdown(role.name)} (${ids2.length}, including zero activity)${channel ? ` in ${channelLabel(g, channel.id)}` : ""}:
${report.rows.slice(0, 20).map((x) => `${memberLabel(g, x.user)}: ${x.messages} messages, ${ms(x.qualifyingMs)} voice, ${ms(x.gameMs)} game`).join("\n")}
Totals: ${report.totals.messages} messages, ${ms(report.totals.voiceMs)} qualifying Discord voice, ${ms(report.totals.gameMs)} observed game; ${report.totals.active} unique active members. Roles are current, not historical. Game activity has no channel attribution.`, [new AttachmentBuilder(Buffer.from(csv([["member_name", "member_id", "messages", "participation", "voice_ms", "game_ms"], ...report.rows.map((x) => [memberLabel(g, x.user), x.user, x.messages, x.participation, x.qualifyingMs, x.gameMs])])), { name: "role-report.csv" })]);
  }
  if (sub === "channel") {
    const ch = i.options.getChannel("channel", true);
    const msgs = store.db.prepare("SELECT user_id,at FROM messages WHERE guild_id=? AND (channel_id=? OR parent_id=?) AND at>=? AND at<?").all(g, ch.id, ch.id, r.start, r.end);
    const v = segments(store, g, "voice", r.start, r.end, now).filter((s) => s.channel_id === ch.id);
    const participants = /* @__PURE__ */ new Set([...msgs.map((x) => x.user_id), ...v.map((x) => x.user_id)]);
    const busy = /* @__PURE__ */ new Map();
    for (const m of msgs) {
      const d = dateParts(m.at, store.config(g).timezone).date;
      busy.set(d, (busy.get(d) ?? 0) + 1);
    }
    return respond(i, `${channelLabel(g, ch.id)}: ${msgs.length} messages sent, ${ms(v.reduce((a, x) => a + x.end_at - x.start_at, 0))} Discord voice person-hours; ${participants.size} unique participants. Busiest dates: ${[...busy].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} ${n}`).join(", ") || "none"}. Voice person-hours sum member time, not channel occupancy.`);
  }
  await fetchMembers(i);
  const observed = store.db.prepare(`SELECT DISTINCT user_id FROM (SELECT user_id FROM messages WHERE guild_id=? AND at>=? AND at<? UNION SELECT user_id FROM intervals WHERE guild_id=? AND end_at>? AND start_at<? UNION SELECT user_id FROM live WHERE guild_id=?)`).all(g, r.start, r.end, g, r.start, r.end, g);
  const ids = [.../* @__PURE__ */ new Set([...currentMembers(i).map((m) => m.id), ...observed.map((x) => x.user_id)])], all = roleReport(store, g, ids, r.start, r.end, now), cov = coverage(store, g, r.start, r.end);
  if (sub === "server" || sub === "export") {
    const cal = serverCalendar(store, g, r.start, r.end, now);
    const summary = `Server: ${all.totals.messages} messages, ${ms(all.totals.voiceMs)} qualifying Discord voice, ${ms(all.totals.gameMs)} observed game, ${all.totals.active} unique active members. Daily active: ${cal.daily.slice(-7).map((x) => `${x.date} ${x.active}`).join(", ") || "none"}. Weekly active: ${cal.weekly.slice(-4).map((x) => `${x.week} ${x.active}`).join(", ") || "none"}. Busiest active days: ${[...cal.daily].sort((a, b) => b.active - a.active).slice(0, 3).map((x) => `${x.date} ${x.active}`).join(", ") || "none"}. Busiest message hours (server timezone): ${cal.busiestMessageHours.slice(0, 3).map(([h, n]) => `${h}:00 ${n}`).join(", ") || "none"}. Tracking began ${stamp(cov.trackingStarted)}; ${cov.incomplete ? "coverage incomplete" : "no known gaps"}.`;
    if (sub === "export") {
      if (i.options.getString("scope") === "attendance") throw new Error("Use /attendance report csv:true for member-level attendance");
      return respond(i, summary, [new AttachmentBuilder(Buffer.from(csv([["member_name", "member_id", "messages", "participation", "connected_ms", "qualifying_ms", "game_ms", "active_days"], ...all.rows.map((x) => [memberLabel(g, x.user), x.user, x.messages, x.participation, x.connectedMs, x.qualifyingMs, x.gameMs, x.activeDays])])), { name: "activity.csv" })]);
    }
    return respond(i, summary);
  }
  if (sub === "leaderboard") {
    const metric = i.options.getString("metric", true);
    const sorted = [...all.rows].sort((a, b) => metric === "voice" ? b.qualifyingMs - a.qualifyingMs : metric === "game" ? b.gameMs - a.gameMs : b.messages - a.messages);
    return respond(i, `${metric} leaderboard:
${sorted.slice(0, 20).map((x, n) => `${n + 1}. ${memberLabel(g, x.user)}: ${metric === "messages" ? x.messages : ms(metric === "voice" ? x.qualifyingMs : x.gameMs)}`).join("\n")}`);
  }
  if (sub === "game") {
    const name = i.options.getString("game", true).toLowerCase();
    const rows = all.rows.map((x) => ({ id: x.user, time: x.games.filter(([g2]) => g2.toLowerCase() === name).reduce((a, [, n]) => a + n, 0) })).filter((x) => x.time);
    return respond(i, `Observed game activity for ${escapeMarkdown(name)}: ${ms(rows.reduce((a, x) => a + x.time, 0))}.
${rows.slice(0, 20).map((x) => `${memberLabel(g, x.id)}: ${ms(x.time)}`).join("\n") || "none"}
Hidden presence or disabled activity sharing can leave gaps; this does not prove an Arma server join.`);
  }
  if (sub === "compare") {
    const len = r.end - r.start, prev = roleReport(store, g, ids, r.start - len, r.start, now);
    return respond(i, `Current: ${all.totals.messages} messages, ${ms(all.totals.voiceMs)} voice, ${ms(all.totals.gameMs)} game, ${all.totals.active} active.
Previous: ${prev.totals.messages} messages, ${ms(prev.totals.voiceMs)} voice, ${ms(prev.totals.gameMs)} game, ${prev.totals.active} active. Calendar period comparisons may cover different UTC hours across DST.`);
  }
}
async function fetchApollo(g, url) {
  const m = url.match(/^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/);
  if (!m || m[1] !== g) throw new Error("Use a Discord message link from this server");
  const ch = await client.channels.fetch(m[2]);
  if (!ch || !ch.isTextBased() || !("messages" in ch)) throw new Error("Apollo channel is inaccessible");
  const post = await ch.messages.fetch(m[3]);
  const expected = store.config(g).apolloBotId;
  if (!expected) throw new Error("Configure Apollo bot ID first");
  if (post.author.id !== expected) throw new Error("Message author is not the configured Apollo bot");
  return post;
}
function messageFields(post) {
  return parseApollo({ content: post.content, embeds: post.embeds.map((e) => ({ title: e.title, description: e.description, fields: e.fields.map((f) => ({ name: f.name, value: f.value })), url: e.url })) });
}
function eventPreview(g, e) {
  return `**${e.name}**
Start ${stamp(e.start)}; end ${stamp(e.end)}
Channels ${e.channels.map((id) => channelLabel(g, id)).join(", ")}; minimum ${e.minimumMinutes} minutes
${e.description ?? ""}`;
}
async function attendanceCommand(i, g) {
  const sub = i.options.getSubcommand(), now = Date.now();
  store.ensureGuild(g, now);
  if (sub === "list") {
    const rows = store.db.prepare("SELECT id,name,start_at,end_at,source FROM events WHERE guild_id=? ORDER BY start_at DESC LIMIT 30").all(g);
    return respond(i, rows.map((e) => `#${e.id} ${e.name} ${stamp(e.start_at)}\u2013${stamp(e.end_at)} (${e.source})`).join("\n") || "No events");
  }
  if (sub === "history") {
    const id = i.options.getInteger("event", true);
    eventRow(g, id);
    const changes = store.db.prepare("SELECT actor_id,at,reason,before_json,after_json FROM event_audit WHERE guild_id=? AND event_id=? ORDER BY at DESC LIMIT 20").all(g, id);
    const corrections = store.db.prepare("SELECT actor_id,at,reason,user_id,minutes FROM corrections WHERE guild_id=? AND event_id=? ORDER BY at DESC LIMIT 20").all(g, id);
    return respond(i, `Event #${id} setting history:
${changes.map((x) => `${stamp(x.at)} by ${memberLabel(g, x.actor_id)}: ${x.reason}; old ${auditValue(g, x.before_json)}; new ${auditValue(g, x.after_json)}`).join("\n") || "none"}
Manual corrections:
${corrections.map((x) => `${stamp(x.at)} by ${memberLabel(g, x.actor_id)}: ${memberLabel(g, x.user_id)} ${x.minutes}m \u2014 ${x.reason}`).join("\n") || "none"}`);
  }
  if (sub === "create") {
    const e = { name: i.options.getString("name", true), description: i.options.getString("description") ?? "", start: when(i.options.getString("start", true)), end: i.options.getString("end") ? when(i.options.getString("end", true)) : null, channels: selectedChannels(i), minimumMinutes: i.options.getInteger("minimum", true) };
    return preview(i, `Create attendance event?
${eventPreview(g, e)}`, () => `Created event #${createEvent(store, g, i.user.id, e, Date.now())}`);
  }
  if (sub === "update" || sub === "start" || sub === "end") {
    const id = i.options.getInteger("event", true), old = eventRow(g, id), reason = i.options.getString("reason", true);
    let patch = {};
    if (sub === "start") patch.start = now;
    else if (sub === "end") patch.end = now;
    else {
      const name = i.options.getString("name"), description = i.options.getString("description"), start = i.options.getString("start"), end = i.options.getString("end"), channels = selectedChannels(i), minimum = i.options.getInteger("minimum");
      if (name !== null) patch.name = name;
      if (description !== null) patch.description = description;
      if (start) patch.start = when(start);
      if (end) patch.end = when(end);
      if (channels.length) patch.channels = channels;
      if (minimum !== null) patch.minimumMinutes = minimum;
    }
    return preview(i, `Update event #${id}? Reason: ${reason}
Existing: ${old.name}; ${stamp(old.start_at)}\u2013${stamp(old.end_at)}; channels ${JSON.parse(old.channels).map((channel) => channelLabel(g, channel)).join(", ")}; minimum ${old.min_ms / 6e4}m
New values: ${JSON.stringify({ ...patch, channels: patch.channels?.map((channel) => channelLabel(g, channel)) })}`, () => {
      const recalculated = updateEvent(store, g, id, i.user.id, patch, reason, Date.now());
      return `Updated event #${id}. Attendance ${recalculated ? "recalculated from stored voice intervals" : "settings revised"}.`;
    });
  }
  if (sub === "correct") {
    const id = i.options.getInteger("event", true), user = i.options.getUser("member", true).id, minutes = i.options.getInteger("minutes", true), reason = i.options.getString("reason", true);
    correctAttendance(store, g, id, user, minutes, i.user.id, reason, now);
    return respond(i, `Recorded ${minutes} minute manual adjustment for ${user} on event #${id}. Measured voice history is unchanged.`);
  }
  if (sub === "report") {
    const id = i.options.getInteger("event", true), report = attendance2(store, g, id, now), member = i.options.getUser("member"), role = i.options.getRole("role");
    if (role) await fetchMembers(i);
    const rows = report.rows.filter((x) => (!member || x.user === member.id) && (!role || i.guild.members.cache.get(x.user)?.roles.cache.has(role.id)));
    const gaps = report.coverage.gaps.map((x) => `${stamp(x.start_at)}\u2013${stamp(x.end_at)}`).join(", ");
    const body = `Discord voice attendance \u2014 #${id} ${report.event.name}
${rows.slice(0, 25).map((x) => `${memberLabel(g, x.user)}: measured ${ms(x.measuredMs)}; manual ${x.adjustmentMinutes}m; ${x.metMinimum ? "met minimum" : "below minimum"}; arrival ${stamp(x.arrival)}; departure ${stamp(x.departure)}`).join("\n") || "No observed attendance"}
${report.recalculated ? "Recalculated after event settings changed. " : ""}${report.coverage.incomplete ? "Coverage incomplete from tracking start, retention, or gaps. " : ""}${gaps ? `Known unobserved windows: ${gaps}. ` : ""}${report.event.source_url ?? ""}`;
    const files = i.options.getBoolean("csv") ? [new AttachmentBuilder(Buffer.from(csv([["member_name", "member_id", "arrival_utc", "departure_utc", "measured_ms", "manual_minutes", "met_minimum"], ...rows.map((x) => [memberLabel(g, x.user), x.user, x.arrival ? new Date(x.arrival).toISOString() : "", x.departure ? new Date(x.departure).toISOString() : "", x.measuredMs, x.adjustmentMinutes, x.metMinimum])])), { name: `attendance-${id}.csv` })] : void 0;
    return respond(i, body, files);
  }
  if (sub === "import") {
    if (process.env.APOLLO_IMPORT_ENABLED !== "true") throw new Error("Apollo import requires Message Content intent and APOLLO_IMPORT_ENABLED=true");
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const url = i.options.getString("apollo_message_url", true), post = await fetchApollo(g, url), fields = messageFields(post);
    const channels = selectedChannels(i), minimumMinutes = i.options.getInteger("minimum", true);
    if (store.db.prepare("SELECT 1 FROM events WHERE guild_id=? AND source_message_id=?").get(g, post.id)) throw new Error("This Apollo post has already been imported");
    if (!fields.name || !fields.start || !fields.end) {
      apolloPending.set(post.id, { guild: g, actor: i.user.id, url, channels, minimumMinutes, description: fields.description ?? "", eventId: fields.eventId, name: fields.name, start: fields.start, end: fields.end });
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`form:${post.id}:${i.user.id}`).setLabel("Enter or correct fields").setStyle(ButtonStyle.Primary));
      await i.editReply({ content: "Apollo post did not expose all required fields reliably. Enter or correct the title, start, and end before previewing.", components: [row], allowedMentions: safe });
      return;
    }
    const e = { name: fields.name, description: fields.description ?? "", start: fields.start, end: fields.end, channels, minimumMinutes, source: "apollo", sourceUrl: url, sourceMessageId: post.id, sourceEventId: fields.eventId ?? void 0 };
    return preview(i, `Apollo import preview (RSVP is not attendance):
${eventPreview(g, e)}`, () => `Imported event #${createEvent(store, g, i.user.id, e, Date.now())}`);
  }
  if (sub === "sync") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const id = i.options.getInteger("event", true), old = eventRow(g, id);
    if (old.source !== "apollo" || !old.source_url) throw new Error("Event has no Apollo source");
    let post;
    try {
      post = await fetchApollo(g, old.source_url);
    } catch (e) {
      return respond(i, `Apollo source removed or inaccessible: ${String(e)}`);
    }
    const f = messageFields(post), patch = {};
    if (f.name && f.name !== old.name) patch.name = f.name;
    if (f.description !== null && f.description !== old.description) patch.description = f.description;
    if (f.start && f.start !== old.start_at) patch.start = f.start;
    if (f.end && f.end !== old.end_at) patch.end = f.end;
    if (!Object.keys(patch).length) return respond(i, "No reliably extractable Apollo changes detected. Local voice settings and corrections are unchanged.");
    const token2 = Math.random().toString(36).slice(2);
    pending.set(token2, { guild: g, actor: i.user.id, expires: Date.now() + 9e5, label: "Apollo sync", action: () => {
      const recalculated = updateEvent(store, g, id, i.user.id, patch, "Confirmed Apollo sync", Date.now());
      return `Synced event #${id}; ${recalculated ? "attendance recalculated" : "attendance unchanged"}.`;
    } });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("ok:" + token2).setLabel("Apply changes").setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId("no:" + token2).setLabel("Cancel").setStyle(ButtonStyle.Secondary));
    return i.editReply({ content: `Apollo changes for #${id}: ${JSON.stringify(patch)}
Local channels, minimum, corrections, and audit stay in place.`, components: [row], allowedMentions: safe });
  }
}
var apolloPending = /* @__PURE__ */ new Map();
async function configCommand(i, g) {
  const sub = i.options.getSubcommand(), now = Date.now();
  store.ensureGuild(g, now);
  const c = store.config(g);
  if (sub === "view") return respond(i, "Effective configuration:\n```json\n" + JSON.stringify(c, null, 2).slice(0, 1700) + "\n```");
  if (sub === "set") {
    const key = i.options.getString("key", true), value = i.options.getString("value", true);
    if (key === "timezone") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: value });
      } catch {
        throw new Error("Invalid IANA timezone");
      }
      c[key] = value;
    } else if (key === "apolloBotId") {
      if (!/^\d{17,20}$/.test(value)) throw new Error("Expected Discord bot ID");
      c[key] = value;
    } else if (key === "excludeSelfDeaf" || key === "requireTwoHumans") {
      if (!["true", "false"].includes(value)) throw new Error("Use true or false");
      c[key] = value === "true";
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 1 || n > 3650) throw new Error("Expected positive integer");
      c[key] = n;
    }
  }
  if (sub === "add" || sub === "remove") {
    const list = i.options.getString("list", true), id = i.options.getString("id", true);
    if (!/^\d{17,20}$/.test(id)) throw new Error("Expected Discord ID");
    c[list] = sub === "add" ? [.../* @__PURE__ */ new Set([...c[list], id])] : c[list].filter((x) => x !== id);
  }
  if (sub === "alias") {
    c.aliases[i.options.getString("observed", true).toLowerCase()] = i.options.getString("canonical", true);
  }
  store.setConfig(g, c);
  return respond(i, "Configuration updated.");
}
async function privacyCommand(i, g) {
  const sub = i.options.getSubcommand();
  if (sub === "delete-member") {
    const u = i.options.getUser("member", true);
    return preview(i, `Permanently delete stored activity, attendance corrections, and member metadata for ${memberLabel(g, u.id)} in this server?`, () => {
      store.deleteMember(g, u.id);
      return `Deleted stored activity for ${memberLabel(g, u.id)}.`;
    });
  }
  return preview(i, "Permanently reset all activity, events, gaps, and corrections in this server?", () => {
    store.resetGuild(g, Date.now());
    return "Server activity reset; tracking starts now.";
  });
}
function voiceObs(guild, user, channel, selfDeaf, bot, at) {
  const ch = channel ? guild.channels.cache.get(channel) : null;
  const member = guild.members.cache.get(user);
  return { guild: guild.id, user, channel, parent: ch?.parentId ?? null, selfDeaf, bot, afk: guild.afkChannelId, at, roleIds: member ? [...member.roles.cache.keys()] : [] };
}
function seed(now) {
  store.db.transaction(() => {
    for (const r of store.db.prepare("SELECT guild_id,user_id,kind FROM live").all()) store.flushLive(r.guild_id, r.user_id, r.kind, now, true);
  })();
  collector.clearMemory();
  for (const guild of client.guilds.cache.values()) {
    store.ensureGuild(guild.id, now);
    for (const v of guild.voiceStates.cache.values()) if (v.channelId) {
      const m = guild.members.cache.get(v.id);
      collector.voiceUpdate(voiceObs(guild, v.id, v.channelId, !!v.selfDeaf, !!(m?.user.bot ?? client.users.cache.get(v.id)?.bot), now));
    }
    for (const p of guild.presences.cache.values()) {
      const m = guild.members.cache.get(p.userId);
      collector.presence({ guild: guild.id, user: p.userId, games: p.activities.filter((a) => a.type === 0).map((a) => a.name), bot: !!(m?.user.bot ?? client.users.cache.get(p.userId)?.bot), roleIds: m ? [...m.roles.cache.keys()] : [], at: now });
    }
  }
}
var connected = false;
client.once("ready", () => {
  const now = Date.now();
  store.recover(now);
  seed(now);
  connected = true;
  console.log(`HWK Activity connected to ${client.guilds.cache.size} guild(s)`);
});
client.on("shardDisconnect", () => {
  if (connected) {
    store.recover(Date.now());
    collector.clearMemory();
    connected = false;
  }
});
client.on("shardResume", () => {
  if (!connected) {
    const now = Date.now();
    store.recover(now);
    seed(now);
    connected = true;
  }
});
client.on("messageCreate", (m) => {
  gatewayEvents.messages++;
  if (!m.guildId || !m.guild || m.author.bot || m.webhookId) return;
  const ch = m.channel, thread = ch.isThread() ? ch : null;
  const parent = thread?.parentId ?? null;
  const category = thread?.parent?.parentId ?? ("parentId" in ch ? ch.parentId : null);
  collector.message({ guild: m.guildId, id: m.id, user: m.author.id, channel: ch.id, parent, category: category ?? null, at: m.createdTimestamp, bot: m.author.bot, webhook: !!m.webhookId, roleIds: m.member ? [...m.member.roles.cache.keys()] : [] });
  store.member(m.guildId, m.author.id, m.member?.joinedTimestamp ?? null);
});
client.on("voiceStateUpdate", (oldState, newState) => {
  gatewayEvents.voice++;
  const guild = newState.guild, member = newState.member ?? oldState.member;
  collector.voiceUpdate(voiceObs(guild, newState.id, newState.channelId, !!newState.selfDeaf, !!(member?.user.bot ?? client.users.cache.get(newState.id)?.bot), Date.now()));
  if (member && !member.user.bot) store.member(guild.id, member.id, member.joinedTimestamp);
});
client.on("guildMemberUpdate", (_old, m) => {
  const now = Date.now(), v = m.voice;
  if (v.channelId) collector.voiceUpdate(voiceObs(m.guild, m.id, v.channelId, !!v.selfDeaf, m.user.bot, now));
  if (m.presence) collector.presence({ guild: m.guild.id, user: m.id, games: m.presence.activities.filter((a) => a.type === 0).map((a) => a.name), bot: m.user.bot, roleIds: [...m.roles.cache.keys()], at: now });
});
client.on("presenceUpdate", (_old, newP) => {
  gatewayEvents.presence++;
  const guild = newP.guild;
  if (!guild) return;
  const member = newP.member ?? guild.members.cache.get(newP.userId);
  collector.presence({ guild: guild.id, user: newP.userId, games: newP.activities.filter((a) => a.type === 0).map((a) => a.name), bot: !!(member?.user.bot ?? client.users.cache.get(newP.userId)?.bot), roleIds: member ? [...member.roles.cache.keys()] : [], at: Date.now() });
});
client.on("guildCreate", (g) => {
  const now = Date.now();
  store.ensureGuild(g.id, now);
  seed(now);
});
client.on("interactionCreate", async (i) => {
  try {
    const g = requireAdmin(i);
    if (i.isChatInputCommand()) {
      if (i.commandName === "activity") await activityCommand(i, g);
      else if (i.commandName === "attendance") await attendanceCommand(i, g);
      else if (i.commandName === "activity-config") await configCommand(i, g);
      else if (i.commandName === "activity-data") await privacyCommand(i, g);
      return;
    }
    if (i.isButton()) {
      const [verb, id, actor] = i.customId.split(":");
      if (verb === "form") {
        const p2 = apolloPending.get(id ?? "");
        if (!p2 || p2.guild !== g || p2.actor !== i.user.id || actor !== i.user.id) throw new Error("Import form expired or belongs to another administrator");
        const modal = new ModalBuilder().setCustomId(`apollo:${id}:${actor}`).setTitle("Complete Apollo event fields");
        modal.addComponents(...[["name", "Title", p2.name ?? ""], ["start", "Start ISO time with offset", p2.start ? new Date(p2.start).toISOString() : ""], ["end", "End ISO time with offset", p2.end ? new Date(p2.end).toISOString() : ""]].map(([key, label, value]) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setValue(value).setRequired(true))));
        await i.showModal(modal);
        return;
      }
      const p = pending.get(id ?? "");
      if (!p || p.expires < Date.now()) throw new Error("Confirmation expired");
      if (p.guild !== g || p.actor !== i.user.id) throw new Error("Only the requesting administrator can use this control");
      pending.delete(id);
      const result = verb === "ok" ? p.action() : "Cancelled.";
      await i.update({ content: result, components: [], allowedMentions: safe });
      return;
    }
    if (i.isModalSubmit() && i.customId.startsWith("apollo:")) {
      const [, postId, actor] = i.customId.split(":");
      const p = apolloPending.get(postId ?? "");
      if (!p || p.guild !== g || p.actor !== i.user.id || actor !== i.user.id) throw new Error("Import form expired");
      apolloPending.delete(postId);
      const e = { name: i.fields.getTextInputValue("name"), description: p.description, start: when(i.fields.getTextInputValue("start")), end: when(i.fields.getTextInputValue("end")), channels: p.channels, minimumMinutes: p.minimumMinutes, source: "apollo", sourceUrl: p.url, sourceMessageId: postId, sourceEventId: p.eventId ?? void 0 };
      await preview(i, `Apollo import preview (manually completed fields):
${eventPreview(g, e)}`, () => `Imported event #${createEvent(store, g, i.user.id, e, Date.now())}`);
      return;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Interaction error:", msg);
    if (i.isRepliable()) {
      try {
        if (i.deferred || i.replied) await i.editReply({ content: `Error: ${msg}`.slice(0, 1900), components: [], allowedMentions: safe });
        else await i.reply({ content: `Error: ${msg}`.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: safe });
      } catch {
      }
    }
  }
});
var checkpoint = setInterval(() => {
  try {
    store.checkpoint(Date.now());
    for (const g of client.guilds.cache.keys()) store.prune(g, Date.now());
  } catch (e) {
    console.error("Checkpoint failed", e);
  }
}, 3e4);
function shutdown() {
  clearInterval(checkpoint);
  clearInterval(lockBeat);
  try {
    store.checkpoint(Date.now());
  } catch {
  }
  client.destroy();
  store.close();
  closeSync(lockFd);
  try {
    unlinkSync(lockPath);
  } catch {
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
if (process.env.AUTO_REGISTER_COMMANDS === "true") {
  const clientId = process.env.DISCORD_CLIENT_ID;
  if (!clientId) throw new Error("AUTO_REGISTER_COMMANDS requires DISCORD_CLIENT_ID");
  await register(token, clientId, process.env.DISCORD_GUILD_ID);
  console.log("Slash commands registered");
}
await client.login(token);
