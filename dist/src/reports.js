import { dateParts, union } from './time.js';
export function segments(store, guild, kind, start, end, now) {
    const rows = store.db.prepare('SELECT user_id,channel_id,game,start_at,end_at,qualifies FROM intervals WHERE guild_id=? AND kind=? AND end_at>? AND start_at<?').all(guild, kind, start, end);
    const live = store.db.prepare('SELECT user_id,channel_id,game,since_at start_at,? end_at,qualifies FROM live WHERE guild_id=? AND kind=? AND since_at<?').all(now, guild, kind, end);
    return [...rows, ...live].map(r => ({ ...r, start_at: Math.max(start, r.start_at), end_at: Math.min(end, r.end_at) })).filter(r => r.end_at > r.start_at);
}
export function coverage(store, guild, start, end) {
    const row = store.db.prepare('SELECT started_at FROM guilds WHERE guild_id=?').get(guild);
    const gaps = store.db.prepare('SELECT start_at,end_at,reason FROM gaps WHERE guild_id=? AND end_at>? AND start_at<? ORDER BY start_at').all(guild, start, end);
    const retained = Date.now() - store.config(guild).retentionDays * 86_400_000;
    return { trackingStarted: row?.started_at ?? null, gaps, incomplete: !row || start < row.started_at || start < retained || gaps.length > 0 };
}
export function userReport(store, guild, user, start, end, now, channel) {
    const msgs = store.db.prepare('SELECT channel_id,parent_id,at,participation FROM messages WHERE guild_id=? AND user_id=? AND at>=? AND at<?').all(guild, user, start, end).filter(m => !channel || m.channel_id === channel || m.parent_id === channel);
    const v = segments(store, guild, 'voice', start, end, now).filter(s => s.user_id === user && (!channel || s.channel_id === channel));
    const g = channel ? [] : segments(store, guild, 'game', start, end, now).filter(s => s.user_id === user);
    const cfg = store.config(guild);
    const dates = new Set();
    for (const m of msgs)
        dates.add(dateParts(m.at, cfg.timezone).date);
    for (const s of [...v.filter(x => x.qualifies), ...g]) {
        let t = s.start_at;
        while (t < s.end_at) {
            dates.add(dateParts(t, cfg.timezone).date);
            t += 86_400_000;
        }
        dates.add(dateParts(s.end_at - 1, cfg.timezone).date);
    }
    const channelCounts = new Map();
    for (const m of msgs)
        channelCounts.set(m.parent_id ?? m.channel_id, (channelCounts.get(m.parent_id ?? m.channel_id) ?? 0) + 1);
    const voiceChannels = new Map();
    for (const s of v)
        if (s.channel_id)
            voiceChannels.set(s.channel_id, (voiceChannels.get(s.channel_id) ?? 0) + s.end_at - s.start_at);
    const games = new Map();
    for (const s of g)
        if (s.game)
            games.set(s.game, (games.get(s.game) ?? 0) + s.end_at - s.start_at);
    const max = (arr) => arr.length ? Math.max(...arr) : null;
    const lastMsg = store.db.prepare('SELECT MAX(at) n FROM messages WHERE guild_id=? AND user_id=?').get(guild, user);
    const last = (kind) => store.db.prepare('SELECT MAX(end_at) n FROM intervals WHERE guild_id=? AND user_id=? AND kind=?').get(guild, user, kind);
    const sort = (map) => [...map].sort((a, b) => b[1] - a[1]);
    const sessions = store.db.prepare('SELECT COUNT(*) n FROM voice_sessions WHERE guild_id=? AND user_id=? AND at>=? AND at<?').get(guild, user, start, end).n;
    return { user, messages: msgs.length, participation: msgs.reduce((a, m) => a + m.participation, 0), connectedMs: union(v.map(s => [s.start_at, s.end_at])), qualifyingMs: union(v.filter(s => s.qualifies).map(s => [s.start_at, s.end_at])), sessions, gameMs: union(g.map(s => [s.start_at, s.end_at])), games: sort(games), activeDays: dates.size, lastMessage: lastMsg.n, lastVoice: max([last('voice').n ?? 0, ...v.map(s => s.end_at)].filter(Boolean)), lastGame: max([last('game').n ?? 0, ...g.map(s => s.end_at)].filter(Boolean)), textChannels: sort(channelCounts), voiceChannels: sort(voiceChannels), coverage: coverage(store, guild, start, end) };
}
export function roleReport(store, guild, ids, start, end, now, channel) { const rows = ids.map(id => userReport(store, guild, id, start, end, now, channel)); return { rows, totals: { messages: rows.reduce((a, r) => a + r.messages, 0), participation: rows.reduce((a, r) => a + r.participation, 0), voiceMs: rows.reduce((a, r) => a + r.qualifyingMs, 0), gameMs: rows.reduce((a, r) => a + r.gameMs, 0), active: rows.filter(r => r.messages || r.qualifyingMs || r.gameMs).length } }; }
export function serverCalendar(store, guild, start, end, now) {
    const zone = store.config(guild).timezone;
    const daily = new Map(), hours = new Map();
    const add = (date, user) => { if (!daily.has(date))
        daily.set(date, new Set()); daily.get(date).add(user); };
    const msgs = store.db.prepare('SELECT user_id,at FROM messages WHERE guild_id=? AND at>=? AND at<?').all(guild, start, end);
    for (const m of msgs) {
        const p = dateParts(m.at, zone);
        add(p.date, m.user_id);
        hours.set(p.hour, (hours.get(p.hour) ?? 0) + 1);
    }
    for (const s of [...segments(store, guild, 'voice', start, end, now).filter(x => x.qualifies), ...segments(store, guild, 'game', start, end, now)]) {
        let t = s.start_at;
        while (t < s.end_at) {
            add(dateParts(t, zone).date, s.user_id);
            t += 3_600_000;
        }
        add(dateParts(s.end_at - 1, zone).date, s.user_id);
    }
    const weekly = new Map();
    for (const [date, users] of daily) {
        const d = new Date(date + 'T00:00:00Z'), weekday = (d.getUTCDay() + 6) % 7;
        d.setUTCDate(d.getUTCDate() - weekday);
        const key = d.toISOString().slice(0, 10);
        if (!weekly.has(key))
            weekly.set(key, new Set());
        users.forEach(u => weekly.get(key).add(u));
    }
    return { daily: [...daily].map(([date, users]) => ({ date, active: users.size })).sort((a, b) => a.date.localeCompare(b.date)), weekly: [...weekly].map(([week, users]) => ({ week, active: users.size })).sort((a, b) => a.week.localeCompare(b.week)), busiestMessageHours: [...hours].sort((a, b) => b[1] - a[1]) };
}
export function inactiveCandidates(store, guild, members, start, end, now) { const c = store.config(guild), cov = coverage(store, guild, start, end); const eligible = members.filter(m => !m.roles.some(r => c.loaRoles.includes(r) || c.excludedRoles.includes(r)) && m.joinedAt !== null && m.joinedAt <= now - c.newcomerGraceDays * 86_400_000); const ids = eligible.filter(m => { const r = userReport(store, guild, m.id, start, end, now); return !(r.messages || r.qualifyingMs); }).map(m => m.id); return { ids, coverage: cov }; }
export function attendance(store, guild, eventId, now) {
    const event = store.db.prepare('SELECT * FROM events WHERE guild_id=? AND id=?').get(guild, eventId);
    if (!event)
        throw new Error('Event not found in this server');
    const end = Math.min(event.end_at ?? now, now), channels = JSON.parse(event.channels);
    const all = segments(store, guild, 'voice', event.start_at, end, now).filter(s => s.qualifies && !!s.channel_id && channels.includes(s.channel_id));
    const users = new Set(all.map(s => s.user_id));
    const corrections = store.db.prepare('SELECT user_id,SUM(minutes) minutes FROM corrections WHERE guild_id=? AND event_id=? GROUP BY user_id').all(guild, eventId);
    corrections.forEach(c => users.add(c.user_id));
    const rows = [...users].map(user => { const mine = all.filter(s => s.user_id === user), measuredMs = union(mine.map(s => [s.start_at, s.end_at])); const adjustmentMinutes = corrections.find(c => c.user_id === user)?.minutes ?? 0; return { user, arrival: mine.length ? Math.min(...mine.map(x => x.start_at)) : null, departure: mine.length ? Math.max(...mine.map(x => x.end_at)) : null, measuredMs, adjustmentMinutes, metMinimum: measuredMs + adjustmentMinutes * 60_000 >= event.min_ms }; }).sort((a, b) => b.measuredMs - a.measuredMs);
    return { event, rows, coverage: coverage(store, guild, event.start_at, end), recalculated: event.revision > 1 };
}
export function csvCell(v) { let s = String(v ?? ''); if (/^[\s]*[=+\-@\t\r]/.test(s))
    s = "'" + s; return '"' + s.replaceAll('"', '""') + '"'; }
export function csv(rows) { return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
