import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Config = {
  timezone: string; excludedChannels: string[]; excludedCategories: string[];
  excludedRoles: string[]; loaRoles: string[]; excludeSelfDeaf: boolean;
  requireTwoHumans: boolean; participationCap: number; aliases: Record<string,string>;
  apolloBotId: string; retentionDays: number; newcomerGraceDays: number;
};
export const defaults: Config = { timezone:'America/New_York', excludedChannels:[], excludedCategories:[], excludedRoles:[], loaRoles:[], excludeSelfDeaf:false, requireTwoHumans:false, participationCap:5, aliases:{'arma reforger':'Arma Reforger'}, apolloBotId:'', retentionDays:365, newcomerGraceDays:7 };

export class Store {
  readonly db: Database.Database;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive:true});
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
  }
  migrate() {
    this.db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY)');
    if(this.db.prepare('SELECT 1 FROM migrations WHERE version=1').get())return;
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
  ensureGuild(guild: string, now: number) { this.db.prepare('INSERT OR IGNORE INTO guilds VALUES(?,?,?)').run(guild,now,JSON.stringify(defaults));this.db.prepare('INSERT OR IGNORE INTO heartbeats VALUES(?,?)').run(guild,now); }
  config(guild:string): Config { const row=this.db.prepare('SELECT config FROM guilds WHERE guild_id=?').get(guild) as {config:string}|undefined; return {...defaults,...(row?JSON.parse(row.config):{})}; }
  setConfig(guild:string, value:Config) { this.db.prepare('UPDATE guilds SET config=? WHERE guild_id=?').run(JSON.stringify(value),guild); }
  member(guild:string,user:string,joined:number|null) { this.db.prepare('INSERT INTO members VALUES(?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET joined_at=COALESCE(excluded.joined_at,members.joined_at)').run(guild,user,joined); }
  message(guild:string,id:string,user:string,channel:string,parent:string|null,at:number): boolean {
    const cap=this.config(guild).participationCap;
    const window=at-60_000;
    const count=(this.db.prepare('SELECT COUNT(*) n FROM messages WHERE guild_id=? AND user_id=? AND at>? AND at<=?').get(guild,user,window,at) as {n:number}).n;
    return this.db.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,?)').run(guild,id,user,channel,parent,at,count<cap?1:0).changes>0;
  }
  segment(guild:string,user:string,kind:'voice'|'game',start:number,end:number,qualifies:boolean,channel?:string|null,game?:string|null) {
    if(end<=start)return;
    this.db.prepare('INSERT INTO intervals(guild_id,user_id,kind,channel_id,game,start_at,end_at,qualifies) VALUES(?,?,?,?,?,?,?,?)').run(guild,user,kind,channel??null,game??null,start,end,qualifies?1:0);
  }
  live(guild:string,user:string,kind:'voice'|'game') {return this.db.prepare('SELECT * FROM live WHERE guild_id=? AND user_id=? AND kind=?').get(guild,user,kind) as Live|undefined;}
  startLive(guild:string,user:string,kind:'voice'|'game',at:number,qualifies:boolean,channel?:string|null,game?:string|null) {this.db.prepare('INSERT INTO live VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(guild_id,user_id,kind) DO UPDATE SET channel_id=excluded.channel_id,game=excluded.game,since_at=excluded.since_at,checkpoint_at=excluded.checkpoint_at,qualifies=excluded.qualifies').run(guild,user,kind,channel??null,game??null,at,at,qualifies?1:0);}
  flushLive(guild:string,user:string,kind:'voice'|'game',at:number,remove=false) {
    const old=this.live(guild,user,kind); if(!old)return;
    const end=Math.max(at,old.since_at);
    this.segment(guild,user,kind,old.since_at,end,!!old.qualifies,old.channel_id,old.game);
    if(remove)this.db.prepare('DELETE FROM live WHERE guild_id=? AND user_id=? AND kind=?').run(guild,user,kind);
    else this.db.prepare('UPDATE live SET since_at=?,checkpoint_at=? WHERE guild_id=? AND user_id=? AND kind=?').run(end,end,guild,user,kind);
  }
  checkpoint(at:number) {this.db.transaction(()=>{const rows=this.db.prepare('SELECT * FROM live').all() as Live[];for(const r of rows)this.flushLive(r.guild_id,r.user_id,r.kind,at);this.db.prepare('UPDATE heartbeats SET last_at=?').run(at);})();}
  recover(at:number) {
    this.db.transaction(()=>{const rows=this.db.prepare('SELECT * FROM live').all() as Live[];
      for(const r of rows)this.flushLive(r.guild_id,r.user_id,r.kind,r.checkpoint_at,true);
      for(const hb of this.db.prepare('SELECT guild_id,last_at FROM heartbeats').all() as {guild_id:string;last_at:number}[])if(at>hb.last_at)this.gap(hb.guild_id,hb.last_at,at,'Bot disconnected or restarted');
      this.db.prepare('UPDATE heartbeats SET last_at=?').run(at);
    })();
  }
  gap(guild:string,start:number,end:number,reason:string) {if(end>start)this.db.prepare('INSERT INTO gaps(guild_id,start_at,end_at,reason) VALUES(?,?,?,?)').run(guild,start,end,reason);}
  prune(guild:string,now:number) {const cutoff=now-this.config(guild).retentionDays*86_400_000;this.db.transaction(()=>{this.db.prepare('DELETE FROM messages WHERE guild_id=? AND at<?').run(guild,cutoff);this.db.prepare('DELETE FROM voice_sessions WHERE guild_id=? AND at<?').run(guild,cutoff);this.db.prepare('DELETE FROM intervals WHERE guild_id=? AND end_at<?').run(guild,cutoff);this.db.prepare('UPDATE intervals SET start_at=? WHERE guild_id=? AND start_at<? AND end_at>?').run(cutoff,guild,cutoff,cutoff);})();}
  deleteMember(guild:string,user:string) {this.db.transaction(()=>{for(const table of ['messages','intervals','live','voice_sessions','corrections','members'])this.db.prepare(`DELETE FROM ${table} WHERE guild_id=? AND user_id=?`).run(guild,user);})();}
  resetGuild(guild:string,now:number) {this.db.transaction(()=>{for(const table of ['messages','intervals','live','voice_sessions','gaps','events','event_audit','corrections','members'])this.db.prepare(`DELETE FROM ${table} WHERE guild_id=?`).run(guild);this.db.prepare('UPDATE guilds SET started_at=? WHERE guild_id=?').run(now,guild);this.db.prepare('UPDATE heartbeats SET last_at=? WHERE guild_id=?').run(now,guild);})();}
  close(){this.db.close();}
}
export type Live={guild_id:string;user_id:string;kind:'voice'|'game';channel_id:string|null;game:string|null;since_at:number;checkpoint_at:number;qualifies:number};
