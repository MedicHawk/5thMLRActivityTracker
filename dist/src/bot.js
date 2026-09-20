import 'dotenv/config';
import { Client, GatewayIntentBits, PermissionFlagsBits, MessageFlags, ButtonBuilder, ButtonStyle, ActionRowBuilder, AttachmentBuilder, TextInputBuilder, TextInputStyle, ModalBuilder } from 'discord.js';
import { Store } from './db.js';
import { Collector } from './collect.js';
import { register } from './commands.js';
import { userReport, roleReport, attendance, segments, coverage, csv, serverCalendar, inactiveCandidates } from './reports.js';
import { createEvent, updateEvent, correctAttendance, parseApollo } from './events.js';
import { localMidnight, period, dateParts } from './time.js';
import { openSync, closeSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
const token = process.env.DISCORD_TOKEN;
if (!token)
    throw new Error('DISCORD_TOKEN is required');
const fallbackDatabasePath = 'data/activity.sqlite';
let databasePath = process.env.DATABASE_PATH ?? fallbackDatabasePath;
let store;
try {
    store = new Store(databasePath);
}
catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
    if (databasePath !== fallbackDatabasePath && ['EACCES', 'ENOENT', 'EPERM', 'EROFS'].includes(code)) {
        console.warn(`Cannot use DATABASE_PATH ${databasePath} (${code}); falling back to ${fallbackDatabasePath}`);
        databasePath = fallbackDatabasePath;
        store = new Store(databasePath);
    }
    else
        throw error;
}
const lockPath = databasePath + '.instance.lock';
function lock() { try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${process.pid}`);
    return fd;
}
catch {
    try {
        if (Date.now() - statSync(lockPath).mtimeMs > 120_000) {
            unlinkSync(lockPath);
            return lock();
        }
    }
    catch { }
    throw new Error('Another bot instance appears to own this database');
} }
const lockFd = lock();
const lockBeat = setInterval(() => { try {
    writeFileSync(lockPath, `${process.pid} ${Date.now()}`);
}
catch { } }, 30_000);
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers];
if (process.env.APOLLO_IMPORT_ENABLED === 'true')
    intents.push(GatewayIntentBits.MessageContent);
const client = new Client({ intents });
const collector = new Collector(store);
const processStarted = Date.now();
const gatewayEvents = { messages: 0, voice: 0, presence: 0 };
const pending = new Map();
const safe = { parse: [], users: [], roles: [] };
function ms(n) { return `${(n / 3_600_000).toFixed(1)} h`; }
function stamp(n) { return n ? `<t:${Math.floor(n / 1000)}:f>` : 'none observed'; }
function requireAdmin(i) { if (!i.inGuild() || !i.guildId || !i.memberPermissions?.has(PermissionFlagsBits.Administrator))
    throw new Error('Administrator permission in a server is required'); return i.guildId; }
function when(s) { if (!/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:\d\d)$/.test(s))
    throw new Error('Use ISO date/time with Z or UTC offset, e.g. 2026-09-16T19:00:00-04:00'); const n = Date.parse(s); if (!Number.isFinite(n))
    throw new Error('Invalid date/time'); return n; }
function range(i, now) { const p = i.options.getString('period') ?? '30d', zone = store.config(i.guildId).timezone; if (p === 'custom') {
    const a = i.options.getString('from'), b = i.options.getString('to');
    if (!a || !b)
        throw new Error('Custom period requires from and to dates');
    const start = localMidnight(a, zone), endDate = new Date(b + 'T00:00:00Z');
    endDate.setUTCDate(endDate.getUTCDate() + 1);
    const end = localMidnight(endDate.toISOString().slice(0, 10), zone);
    if (end <= start)
        throw new Error('End date must be after start');
    return { start, end };
} return period(now, Number(p.slice(0, -1)), zone); }
function preview(i, label, action) { const id = Math.random().toString(36).slice(2) + Date.now().toString(36); pending.set(id, { guild: i.guildId, actor: i.user.id, expires: Date.now() + 15 * 60_000, label, action }); const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ok:' + id).setLabel('Confirm').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('no:' + id).setLabel('Cancel').setStyle(ButtonStyle.Secondary)); return i.deferred || i.replied ? i.editReply({ content: label, components: [row], allowedMentions: safe }) : i.reply({ content: label, components: [row], flags: MessageFlags.Ephemeral, allowedMentions: safe }); }
async function respond(i, content, files) { if (!i.deferred)
    await i.deferReply({ flags: MessageFlags.Ephemeral }); await i.editReply({ content: content.slice(0, 1900), files, allowedMentions: safe }); }
function eventRow(g, id) { const e = store.db.prepare('SELECT * FROM events WHERE guild_id=? AND id=?').get(g, id); if (!e)
    throw new Error('Event not found in this server'); return e; }
function selectedChannels(i) { return ['voice_channel', 'voice_channel_2', 'voice_channel_3'].map(k => i.options.getChannel(k)?.id).filter((x) => !!x); }
function formatUser(g, u, start, end, now) { const r = userReport(store, g, u, start, end, now); const events = store.db.prepare('SELECT id FROM events WHERE guild_id=? AND start_at<? AND COALESCE(end_at,?)>? ORDER BY start_at DESC LIMIT 10').all(g, end, now, start); const results = events.map(e => { const row = attendance(store, g, e.id, now).rows.find(x => x.user === u); return row ? `#${e.id}: ${ms(row.measuredMs)} measured, ${row.adjustmentMinutes}m manual, ${row.metMinimum ? 'met' : 'below'} minimum` : null; }).filter(Boolean); return [`Member ${u} | ${dateParts(start, store.config(g).timezone).date} to ${dateParts(end - 1, store.config(g).timezone).date}`, `Messages sent ${r.messages}; rate-capped participation ${r.participation}`, `Discord voice time: connected ${ms(r.connectedMs)}, qualifying ${ms(r.qualifyingMs)}, ${r.sessions} sessions`, `Observed game activity: ${ms(r.gameMs)} (${r.games.slice(0, 5).map(([n, t]) => `${n} ${ms(t)}`).join(', ') || 'none'})`, `Unique active days ${r.activeDays}; last message ${stamp(r.lastMessage)}; voice ${stamp(r.lastVoice)}; game ${stamp(r.lastGame)}`, `Top text channels ${r.textChannels.slice(0, 3).map(([c, n]) => `${c}: ${n}`).join(', ') || 'none'}; voice channels ${r.voiceChannels.slice(0, 3).map(([c, n]) => `${c}: ${ms(n)}`).join(', ') || 'none'}`, `Attendance: ${results.join('; ') || 'none observed'}`, `Tracking began ${stamp(r.coverage.trackingStarted)}; coverage ${r.coverage.incomplete ? 'incomplete' : 'no known gaps'}. Hidden game presence and outages can leave gaps. Game presence does not verify server participation.`].join('\n'); }
function currentMembers(i, roleId) { const guild = i.guild; return [...guild.members.cache.values()].filter(m => !m.user.bot && (!roleId || m.roles.cache.has(roleId))); }
async function fetchMembers(i) { await i.guild.members.fetch(); }
function excluded(g, userRoles) { const c = store.config(g); return userRoles.some(r => c.excludedRoles.includes(r)); }
async function activityCommand(i, g) {
    const sub = i.options.getSubcommand(), now = Date.now();
    store.ensureGuild(g, now);
    if (sub === 'health') {
        const c = store.config(g), row = store.db.prepare('SELECT started_at FROM guilds WHERE guild_id=?').get(g);
        const gaps = store.db.prepare('SELECT start_at,end_at,reason FROM gaps WHERE guild_id=? ORDER BY start_at DESC LIMIT 5').all(g);
        const count = (table) => store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE guild_id=?`).get(g).n;
        const lastHeartbeat = store.db.prepare('SELECT last_at FROM heartbeats WHERE guild_id=?').get(g)?.last_at ?? null;
        return respond(i, `Tracking began ${stamp(row.started_at)}. Process started ${stamp(processStarted)}; last database checkpoint ${stamp(lastHeartbeat)}.\nDatabase ${databasePath} (WAL enabled). Stored rows: ${count('messages')} messages, ${count('intervals')} completed intervals, ${count('live')} live intervals, ${count('voice_sessions')} voice sessions.\nGateway events received this process: ${gatewayEvents.messages} messages, ${gatewayEvents.voice} voice changes, ${gatewayEvents.presence} presence changes.\nRecent coverage gaps: ${gaps.length ? gaps.map(x => `${stamp(x.start_at)}–${stamp(x.end_at)} ${x.reason}`).join('\n') : 'none known'}\nRetention ${c.retentionDays} days; timezone ${c.timezone}. Continuous hosting is required.`);
    }
    if (sub === 'inactive') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await fetchMembers(i);
        const days = i.options.getInteger('days', true), r = period(now, days, store.config(g).timezone), role = i.options.getRole('role', true);
        const members = currentMembers(i, role.id), result = inactiveCandidates(store, g, members.map(m => ({ id: m.id, roles: [...m.roles.cache.keys()], joinedAt: m.joinedTimestamp })), r.start, r.end, now);
        return respond(i, `${result.coverage.incomplete ? 'Insufficient tracking coverage; review these unobserved members manually.' : 'No observed qualifying activity'} in ${days} days for current role ${role.name}: ${result.ids.join(', ') || 'none'}\nRules: messages or qualifying Discord voice time; LOA, excluded roles and new members excluded. Game presence alone is never grounds for a flag.`, [new AttachmentBuilder(Buffer.from(csv([['member_id'], ...result.ids.map(id => [id])])), { name: 'inactive.csv' })]);
    }
    const r = range(i, now);
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (sub === 'user')
        return respond(i, formatUser(g, i.options.getUser('member', true).id, r.start, r.end, now));
    if (sub === 'role') {
        await fetchMembers(i);
        const role = i.options.getRole('role', true);
        const channel = i.options.getChannel('channel');
        const ids = currentMembers(i, role.id).map(m => m.id), report = roleReport(store, g, ids, r.start, r.end, now, channel?.id);
        return respond(i, `Current members of ${role.name} (${ids.length}, including zero activity)${channel ? ` in channel ${channel.id}` : ''}:\n${report.rows.slice(0, 20).map(x => `${x.user}: ${x.messages} messages, ${ms(x.qualifyingMs)} voice, ${ms(x.gameMs)} game`).join('\n')}\nTotals: ${report.totals.messages} messages, ${ms(report.totals.voiceMs)} qualifying Discord voice, ${ms(report.totals.gameMs)} observed game; ${report.totals.active} unique active members. Roles are current, not historical. Game activity has no channel attribution.`, [new AttachmentBuilder(Buffer.from(csv([['member_id', 'messages', 'participation', 'voice_ms', 'game_ms'], ...report.rows.map(x => [x.user, x.messages, x.participation, x.qualifyingMs, x.gameMs])])), { name: 'role-report.csv' })]);
    }
    if (sub === 'channel') {
        const ch = i.options.getChannel('channel', true);
        const msgs = store.db.prepare('SELECT user_id,at FROM messages WHERE guild_id=? AND (channel_id=? OR parent_id=?) AND at>=? AND at<?').all(g, ch.id, ch.id, r.start, r.end);
        const v = segments(store, g, 'voice', r.start, r.end, now).filter(s => s.channel_id === ch.id);
        const participants = new Set([...msgs.map(x => x.user_id), ...v.map(x => x.user_id)]);
        const busy = new Map();
        for (const m of msgs) {
            const d = dateParts(m.at, store.config(g).timezone).date;
            busy.set(d, (busy.get(d) ?? 0) + 1);
        }
        return respond(i, `Channel ${ch.id}: ${msgs.length} messages sent, ${ms(v.reduce((a, x) => a + x.end_at - x.start_at, 0))} Discord voice person-hours; ${participants.size} unique participants. Busiest dates: ${[...busy].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d} ${n}`).join(', ') || 'none'}. Voice person-hours sum member time, not channel occupancy.`);
    }
    await fetchMembers(i);
    const observed = store.db.prepare(`SELECT DISTINCT user_id FROM (SELECT user_id FROM messages WHERE guild_id=? AND at>=? AND at<? UNION SELECT user_id FROM intervals WHERE guild_id=? AND end_at>? AND start_at<? UNION SELECT user_id FROM live WHERE guild_id=?)`).all(g, r.start, r.end, g, r.start, r.end, g);
    const ids = [...new Set([...currentMembers(i).map(m => m.id), ...observed.map(x => x.user_id)])], all = roleReport(store, g, ids, r.start, r.end, now), cov = coverage(store, g, r.start, r.end);
    if (sub === 'server' || sub === 'export') {
        const cal = serverCalendar(store, g, r.start, r.end, now);
        const summary = `Server: ${all.totals.messages} messages, ${ms(all.totals.voiceMs)} qualifying Discord voice, ${ms(all.totals.gameMs)} observed game, ${all.totals.active} unique active members. Daily active: ${cal.daily.slice(-7).map(x => `${x.date} ${x.active}`).join(', ') || 'none'}. Weekly active: ${cal.weekly.slice(-4).map(x => `${x.week} ${x.active}`).join(', ') || 'none'}. Busiest active days: ${[...cal.daily].sort((a, b) => b.active - a.active).slice(0, 3).map(x => `${x.date} ${x.active}`).join(', ') || 'none'}. Busiest message hours (server timezone): ${cal.busiestMessageHours.slice(0, 3).map(([h, n]) => `${h}:00 ${n}`).join(', ') || 'none'}. Tracking began ${stamp(cov.trackingStarted)}; ${cov.incomplete ? 'coverage incomplete' : 'no known gaps'}.`;
        if (sub === 'export') {
            if (i.options.getString('scope') === 'attendance')
                throw new Error('Use /attendance report csv:true for member-level attendance');
            return respond(i, summary, [new AttachmentBuilder(Buffer.from(csv([['member_id', 'messages', 'participation', 'connected_ms', 'qualifying_ms', 'game_ms', 'active_days'], ...all.rows.map(x => [x.user, x.messages, x.participation, x.connectedMs, x.qualifyingMs, x.gameMs, x.activeDays])])), { name: 'activity.csv' })]);
        }
        return respond(i, summary);
    }
    if (sub === 'leaderboard') {
        const metric = i.options.getString('metric', true);
        const sorted = [...all.rows].sort((a, b) => metric === 'voice' ? b.qualifyingMs - a.qualifyingMs : metric === 'game' ? b.gameMs - a.gameMs : b.messages - a.messages);
        return respond(i, `${metric} leaderboard:\n${sorted.slice(0, 20).map((x, n) => `${n + 1}. ${x.user}: ${metric === 'messages' ? x.messages : ms(metric === 'voice' ? x.qualifyingMs : x.gameMs)}`).join('\n')}`);
    }
    if (sub === 'game') {
        const name = i.options.getString('game', true).toLowerCase();
        const rows = all.rows.map(x => ({ id: x.user, time: x.games.filter(([g]) => g.toLowerCase() === name).reduce((a, [, n]) => a + n, 0) })).filter(x => x.time);
        return respond(i, `Observed game activity for ${name}: ${ms(rows.reduce((a, x) => a + x.time, 0))}.\n${rows.slice(0, 20).map(x => `${x.id}: ${ms(x.time)}`).join('\n') || 'none'}\nHidden presence or disabled activity sharing can leave gaps; this does not prove an Arma server join.`);
    }
    if (sub === 'compare') {
        const len = r.end - r.start, prev = roleReport(store, g, ids, r.start - len, r.start, now);
        return respond(i, `Current: ${all.totals.messages} messages, ${ms(all.totals.voiceMs)} voice, ${ms(all.totals.gameMs)} game, ${all.totals.active} active.\nPrevious: ${prev.totals.messages} messages, ${ms(prev.totals.voiceMs)} voice, ${ms(prev.totals.gameMs)} game, ${prev.totals.active} active. Calendar period comparisons may cover different UTC hours across DST.`);
    }
}
async function fetchApollo(g, url) { const m = url.match(/^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)\/?$/); if (!m || m[1] !== g)
    throw new Error('Use a Discord message link from this server'); const ch = await client.channels.fetch(m[2]); if (!ch || !ch.isTextBased() || !('messages' in ch))
    throw new Error('Apollo channel is inaccessible'); const post = await ch.messages.fetch(m[3]); const expected = store.config(g).apolloBotId; if (!expected)
    throw new Error('Configure Apollo bot ID first'); if (post.author.id !== expected)
    throw new Error('Message author is not the configured Apollo bot'); return post; }
function messageFields(post) { return parseApollo({ content: post.content, embeds: post.embeds.map(e => ({ title: e.title, description: e.description, fields: e.fields.map(f => ({ name: f.name, value: f.value })), url: e.url })) }); }
function eventPreview(e) { return `**${e.name}**\nStart ${stamp(e.start)}; end ${stamp(e.end)}\nChannels ${e.channels.join(', ')}; minimum ${e.minimumMinutes} minutes\n${e.description ?? ''}`; }
async function attendanceCommand(i, g) {
    const sub = i.options.getSubcommand(), now = Date.now();
    store.ensureGuild(g, now);
    if (sub === 'list') {
        const rows = store.db.prepare('SELECT id,name,start_at,end_at,source FROM events WHERE guild_id=? ORDER BY start_at DESC LIMIT 30').all(g);
        return respond(i, rows.map(e => `#${e.id} ${e.name} ${stamp(e.start_at)}–${stamp(e.end_at)} (${e.source})`).join('\n') || 'No events');
    }
    if (sub === 'history') {
        const id = i.options.getInteger('event', true);
        eventRow(g, id);
        const changes = store.db.prepare('SELECT actor_id,at,reason,before_json,after_json FROM event_audit WHERE guild_id=? AND event_id=? ORDER BY at DESC LIMIT 20').all(g, id);
        const corrections = store.db.prepare('SELECT actor_id,at,reason,user_id,minutes FROM corrections WHERE guild_id=? AND event_id=? ORDER BY at DESC LIMIT 20').all(g, id);
        return respond(i, `Event #${id} setting history:\n${changes.map(x => `${stamp(x.at)} by ${x.actor_id}: ${x.reason}; old ${x.before_json ?? 'none'}; new ${x.after_json}`).join('\n') || 'none'}\nManual corrections:\n${corrections.map(x => `${stamp(x.at)} by ${x.actor_id}: ${x.user_id} ${x.minutes}m — ${x.reason}`).join('\n') || 'none'}`);
    }
    if (sub === 'create') {
        const e = { name: i.options.getString('name', true), description: i.options.getString('description') ?? '', start: when(i.options.getString('start', true)), end: i.options.getString('end') ? when(i.options.getString('end', true)) : null, channels: selectedChannels(i), minimumMinutes: i.options.getInteger('minimum', true) };
        return preview(i, `Create attendance event?\n${eventPreview(e)}`, () => `Created event #${createEvent(store, g, i.user.id, e, Date.now())}`);
    }
    if (sub === 'update' || sub === 'start' || sub === 'end') {
        const id = i.options.getInteger('event', true), old = eventRow(g, id), reason = i.options.getString('reason', true);
        let patch = {};
        if (sub === 'start')
            patch.start = now;
        else if (sub === 'end')
            patch.end = now;
        else {
            const name = i.options.getString('name'), description = i.options.getString('description'), start = i.options.getString('start'), end = i.options.getString('end'), channels = selectedChannels(i), minimum = i.options.getInteger('minimum');
            if (name !== null)
                patch.name = name;
            if (description !== null)
                patch.description = description;
            if (start)
                patch.start = when(start);
            if (end)
                patch.end = when(end);
            if (channels.length)
                patch.channels = channels;
            if (minimum !== null)
                patch.minimumMinutes = minimum;
        }
        return preview(i, `Update event #${id}? Reason: ${reason}\nExisting: ${old.name}; ${stamp(old.start_at)}–${stamp(old.end_at)}; channels ${JSON.parse(old.channels).join(', ')}; minimum ${old.min_ms / 60_000}m\nNew values: ${JSON.stringify(patch)}`, () => { const recalculated = updateEvent(store, g, id, i.user.id, patch, reason, Date.now()); return `Updated event #${id}. Attendance ${recalculated ? 'recalculated from stored voice intervals' : 'settings revised'}.`; });
    }
    if (sub === 'correct') {
        const id = i.options.getInteger('event', true), user = i.options.getUser('member', true).id, minutes = i.options.getInteger('minutes', true), reason = i.options.getString('reason', true);
        correctAttendance(store, g, id, user, minutes, i.user.id, reason, now);
        return respond(i, `Recorded ${minutes} minute manual adjustment for ${user} on event #${id}. Measured voice history is unchanged.`);
    }
    if (sub === 'report') {
        const id = i.options.getInteger('event', true), report = attendance(store, g, id, now), member = i.options.getUser('member'), role = i.options.getRole('role');
        if (role)
            await fetchMembers(i);
        const rows = report.rows.filter(x => (!member || x.user === member.id) && (!role || i.guild.members.cache.get(x.user)?.roles.cache.has(role.id)));
        const gaps = report.coverage.gaps.map(x => `${stamp(x.start_at)}–${stamp(x.end_at)}`).join(', ');
        const body = `Discord voice attendance — #${id} ${report.event.name}\n${rows.slice(0, 25).map(x => `${x.user}: measured ${ms(x.measuredMs)}; manual ${x.adjustmentMinutes}m; ${x.metMinimum ? 'met minimum' : 'below minimum'}; arrival ${stamp(x.arrival)}; departure ${stamp(x.departure)}`).join('\n') || 'No observed attendance'}\n${report.recalculated ? 'Recalculated after event settings changed. ' : ''}${report.coverage.incomplete ? 'Coverage incomplete from tracking start, retention, or gaps. ' : ''}${gaps ? `Known unobserved windows: ${gaps}. ` : ''}${report.event.source_url ?? ''}`;
        const files = i.options.getBoolean('csv') ? [new AttachmentBuilder(Buffer.from(csv([['member_id', 'arrival_utc', 'departure_utc', 'measured_ms', 'manual_minutes', 'met_minimum'], ...rows.map(x => [x.user, x.arrival ? new Date(x.arrival).toISOString() : '', x.departure ? new Date(x.departure).toISOString() : '', x.measuredMs, x.adjustmentMinutes, x.metMinimum])])), { name: `attendance-${id}.csv` })] : undefined;
        return respond(i, body, files);
    }
    if (sub === 'import') {
        if (process.env.APOLLO_IMPORT_ENABLED !== 'true')
            throw new Error('Apollo import requires Message Content intent and APOLLO_IMPORT_ENABLED=true');
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const url = i.options.getString('apollo_message_url', true), post = await fetchApollo(g, url), fields = messageFields(post);
        const channels = selectedChannels(i), minimumMinutes = i.options.getInteger('minimum', true);
        if (store.db.prepare('SELECT 1 FROM events WHERE guild_id=? AND source_message_id=?').get(g, post.id))
            throw new Error('This Apollo post has already been imported');
        if (!fields.name || !fields.start || !fields.end) {
            apolloPending.set(post.id, { guild: g, actor: i.user.id, url, channels, minimumMinutes, description: fields.description ?? '', eventId: fields.eventId, name: fields.name, start: fields.start, end: fields.end });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`form:${post.id}:${i.user.id}`).setLabel('Enter or correct fields').setStyle(ButtonStyle.Primary));
            await i.editReply({ content: 'Apollo post did not expose all required fields reliably. Enter or correct the title, start, and end before previewing.', components: [row], allowedMentions: safe });
            return;
        }
        const e = { name: fields.name, description: fields.description ?? '', start: fields.start, end: fields.end, channels, minimumMinutes, source: 'apollo', sourceUrl: url, sourceMessageId: post.id, sourceEventId: fields.eventId ?? undefined };
        return preview(i, `Apollo import preview (RSVP is not attendance):\n${eventPreview(e)}`, () => `Imported event #${createEvent(store, g, i.user.id, e, Date.now())}`);
    }
    if (sub === 'sync') {
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        const id = i.options.getInteger('event', true), old = eventRow(g, id);
        if (old.source !== 'apollo' || !old.source_url)
            throw new Error('Event has no Apollo source');
        let post;
        try {
            post = await fetchApollo(g, old.source_url);
        }
        catch (e) {
            return respond(i, `Apollo source removed or inaccessible: ${String(e)}`);
        }
        const f = messageFields(post), patch = {};
        if (f.name && f.name !== old.name)
            patch.name = f.name;
        if (f.description !== null && f.description !== old.description)
            patch.description = f.description;
        if (f.start && f.start !== old.start_at)
            patch.start = f.start;
        if (f.end && f.end !== old.end_at)
            patch.end = f.end;
        if (!Object.keys(patch).length)
            return respond(i, 'No reliably extractable Apollo changes detected. Local voice settings and corrections are unchanged.');
        const token = Math.random().toString(36).slice(2);
        pending.set(token, { guild: g, actor: i.user.id, expires: Date.now() + 900_000, label: 'Apollo sync', action: () => { const recalculated = updateEvent(store, g, id, i.user.id, patch, 'Confirmed Apollo sync', Date.now()); return `Synced event #${id}; ${recalculated ? 'attendance recalculated' : 'attendance unchanged'}.`; } });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ok:' + token).setLabel('Apply changes').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('no:' + token).setLabel('Cancel').setStyle(ButtonStyle.Secondary));
        return i.editReply({ content: `Apollo changes for #${id}: ${JSON.stringify(patch)}\nLocal channels, minimum, corrections, and audit stay in place.`, components: [row], allowedMentions: safe });
    }
}
const apolloPending = new Map();
async function configCommand(i, g) {
    const sub = i.options.getSubcommand(), now = Date.now();
    store.ensureGuild(g, now);
    const c = store.config(g);
    if (sub === 'view')
        return respond(i, 'Effective configuration:\n```json\n' + JSON.stringify(c, null, 2).slice(0, 1700) + '\n```');
    if (sub === 'set') {
        const key = i.options.getString('key', true), value = i.options.getString('value', true);
        if (key === 'timezone') {
            try {
                new Intl.DateTimeFormat('en', { timeZone: value });
            }
            catch {
                throw new Error('Invalid IANA timezone');
            }
            c[key] = value;
        }
        else if (key === 'apolloBotId') {
            if (!/^\d{17,20}$/.test(value))
                throw new Error('Expected Discord bot ID');
            c[key] = value;
        }
        else if (key === 'excludeSelfDeaf' || key === 'requireTwoHumans') {
            if (!['true', 'false'].includes(value))
                throw new Error('Use true or false');
            c[key] = value === 'true';
        }
        else {
            const n = Number(value);
            if (!Number.isSafeInteger(n) || n < 1 || n > 3650)
                throw new Error('Expected positive integer');
            c[key] = n;
        }
    }
    if (sub === 'add' || sub === 'remove') {
        const list = i.options.getString('list', true), id = i.options.getString('id', true);
        if (!/^\d{17,20}$/.test(id))
            throw new Error('Expected Discord ID');
        c[list] = sub === 'add' ? [...new Set([...c[list], id])] : c[list].filter(x => x !== id);
    }
    if (sub === 'alias') {
        c.aliases[i.options.getString('observed', true).toLowerCase()] = i.options.getString('canonical', true);
    }
    store.setConfig(g, c);
    return respond(i, 'Configuration updated.');
}
async function privacyCommand(i, g) { const sub = i.options.getSubcommand(); if (sub === 'delete-member') {
    const u = i.options.getUser('member', true);
    return preview(i, `Permanently delete stored activity, attendance corrections, and member metadata for ${u.id} in this server?`, () => { store.deleteMember(g, u.id); return `Deleted stored activity for ${u.id}.`; });
} return preview(i, `Permanently reset all activity, events, gaps, and corrections in server ${g}?`, () => { store.resetGuild(g, Date.now()); return 'Server activity reset; tracking starts now.'; }); }
function voiceObs(guild, user, channel, selfDeaf, bot, at) { const ch = channel ? guild.channels.cache.get(channel) : null; const member = guild.members.cache.get(user); return { guild: guild.id, user, channel, parent: ch?.parentId ?? null, selfDeaf, bot, afk: guild.afkChannelId, at, roleIds: member ? [...member.roles.cache.keys()] : [] }; }
function seed(now) { store.db.transaction(() => { for (const r of store.db.prepare('SELECT guild_id,user_id,kind FROM live').all())
    store.flushLive(r.guild_id, r.user_id, r.kind, now, true); })(); collector.clearMemory(); for (const guild of client.guilds.cache.values()) {
    store.ensureGuild(guild.id, now);
    for (const v of guild.voiceStates.cache.values())
        if (v.channelId) {
            const m = guild.members.cache.get(v.id);
            collector.voiceUpdate(voiceObs(guild, v.id, v.channelId, !!v.selfDeaf, !!(m?.user.bot ?? client.users.cache.get(v.id)?.bot), now));
        }
    for (const p of guild.presences.cache.values()) {
        const m = guild.members.cache.get(p.userId);
        collector.presence({ guild: guild.id, user: p.userId, games: p.activities.filter(a => a.type === 0).map(a => a.name), bot: !!(m?.user.bot ?? client.users.cache.get(p.userId)?.bot), roleIds: m ? [...m.roles.cache.keys()] : [], at: now });
    }
} }
let connected = false;
client.once('ready', () => { const now = Date.now(); store.recover(now); seed(now); connected = true; console.log(`HWK Activity connected to ${client.guilds.cache.size} guild(s)`); });
client.on('shardDisconnect', () => { if (connected) {
    store.recover(Date.now());
    collector.clearMemory();
    connected = false;
} });
client.on('shardResume', () => { if (!connected) {
    const now = Date.now();
    store.recover(now);
    seed(now);
    connected = true;
} });
client.on('messageCreate', m => { gatewayEvents.messages++; if (!m.guildId || !m.guild || m.author.bot || m.webhookId)
    return; const ch = m.channel, thread = ch.isThread() ? ch : null; const parent = thread?.parentId ?? null; const category = thread?.parent?.parentId ?? ('parentId' in ch ? ch.parentId : null); collector.message({ guild: m.guildId, id: m.id, user: m.author.id, channel: ch.id, parent, category: category ?? null, at: m.createdTimestamp, bot: m.author.bot, webhook: !!m.webhookId, roleIds: m.member ? [...m.member.roles.cache.keys()] : [] }); store.member(m.guildId, m.author.id, m.member?.joinedTimestamp ?? null); });
client.on('voiceStateUpdate', (oldState, newState) => { gatewayEvents.voice++; const guild = newState.guild, member = newState.member ?? oldState.member; collector.voiceUpdate(voiceObs(guild, newState.id, newState.channelId, !!newState.selfDeaf, !!(member?.user.bot ?? client.users.cache.get(newState.id)?.bot), Date.now())); if (member && !member.user.bot)
    store.member(guild.id, member.id, member.joinedTimestamp); });
client.on('guildMemberUpdate', (_old, m) => { const now = Date.now(), v = m.voice; if (v.channelId)
    collector.voiceUpdate(voiceObs(m.guild, m.id, v.channelId, !!v.selfDeaf, m.user.bot, now)); if (m.presence)
    collector.presence({ guild: m.guild.id, user: m.id, games: m.presence.activities.filter(a => a.type === 0).map(a => a.name), bot: m.user.bot, roleIds: [...m.roles.cache.keys()], at: now }); });
client.on('presenceUpdate', (_old, newP) => { gatewayEvents.presence++; const guild = newP.guild; if (!guild)
    return; const member = newP.member ?? guild.members.cache.get(newP.userId); collector.presence({ guild: guild.id, user: newP.userId, games: newP.activities.filter(a => a.type === 0).map(a => a.name), bot: !!(member?.user.bot ?? client.users.cache.get(newP.userId)?.bot), roleIds: member ? [...member.roles.cache.keys()] : [], at: Date.now() }); });
client.on('guildCreate', g => { const now = Date.now(); store.ensureGuild(g.id, now); seed(now); });
client.on('interactionCreate', async (i) => {
    try {
        const g = requireAdmin(i);
        if (i.isChatInputCommand()) {
            if (i.commandName === 'activity')
                await activityCommand(i, g);
            else if (i.commandName === 'attendance')
                await attendanceCommand(i, g);
            else if (i.commandName === 'activity-config')
                await configCommand(i, g);
            else if (i.commandName === 'activity-data')
                await privacyCommand(i, g);
            return;
        }
        if (i.isButton()) {
            const [verb, id, actor] = i.customId.split(':');
            if (verb === 'form') {
                const p = apolloPending.get(id ?? '');
                if (!p || p.guild !== g || p.actor !== i.user.id || actor !== i.user.id)
                    throw new Error('Import form expired or belongs to another administrator');
                const modal = new ModalBuilder().setCustomId(`apollo:${id}:${actor}`).setTitle('Complete Apollo event fields');
                modal.addComponents(...[['name', 'Title', p.name ?? ''], ['start', 'Start ISO time with offset', p.start ? new Date(p.start).toISOString() : ''], ['end', 'End ISO time with offset', p.end ? new Date(p.end).toISOString() : '']].map(([key, label, value]) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(key).setLabel(label).setStyle(TextInputStyle.Short).setValue(value).setRequired(true))));
                await i.showModal(modal);
                return;
            }
            const p = pending.get(id ?? '');
            if (!p || p.expires < Date.now())
                throw new Error('Confirmation expired');
            if (p.guild !== g || p.actor !== i.user.id)
                throw new Error('Only the requesting administrator can use this control');
            pending.delete(id);
            const result = verb === 'ok' ? p.action() : 'Cancelled.';
            await i.update({ content: result, components: [], allowedMentions: safe });
            return;
        }
        if (i.isModalSubmit() && i.customId.startsWith('apollo:')) {
            const [, postId, actor] = i.customId.split(':');
            const p = apolloPending.get(postId ?? '');
            if (!p || p.guild !== g || p.actor !== i.user.id || actor !== i.user.id)
                throw new Error('Import form expired');
            apolloPending.delete(postId);
            const e = { name: i.fields.getTextInputValue('name'), description: p.description, start: when(i.fields.getTextInputValue('start')), end: when(i.fields.getTextInputValue('end')), channels: p.channels, minimumMinutes: p.minimumMinutes, source: 'apollo', sourceUrl: p.url, sourceMessageId: postId, sourceEventId: p.eventId ?? undefined };
            await preview(i, `Apollo import preview (manually completed fields):\n${eventPreview(e)}`, () => `Imported event #${createEvent(store, g, i.user.id, e, Date.now())}`);
            return;
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('Interaction error:', msg);
        if (i.isRepliable()) {
            try {
                if (i.deferred || i.replied)
                    await i.editReply({ content: `Error: ${msg}`.slice(0, 1900), components: [], allowedMentions: safe });
                else
                    await i.reply({ content: `Error: ${msg}`.slice(0, 1900), flags: MessageFlags.Ephemeral, allowedMentions: safe });
            }
            catch { }
        }
    }
});
const checkpoint = setInterval(() => { try {
    store.checkpoint(Date.now());
    for (const g of client.guilds.cache.keys())
        store.prune(g, Date.now());
}
catch (e) {
    console.error('Checkpoint failed', e);
} }, 30_000);
function shutdown() { clearInterval(checkpoint); clearInterval(lockBeat); try {
    store.checkpoint(Date.now());
}
catch { } client.destroy(); store.close(); closeSync(lockFd); try {
    unlinkSync(lockPath);
}
catch { } process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
if (process.env.AUTO_REGISTER_COMMANDS === 'true') {
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!clientId)
        throw new Error('AUTO_REGISTER_COMMANDS requires DISCORD_CLIENT_ID');
    await register(token, clientId, process.env.DISCORD_GUILD_ID);
    console.log('Slash commands registered');
}
await client.login(token);
