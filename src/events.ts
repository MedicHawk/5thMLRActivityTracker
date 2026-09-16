import { Store } from './db.js';
import type { EventRow } from './reports.js';

export type EventInput={name:string;description?:string;start:number;end:number|null;channels:string[];minimumMinutes:number;source?:'manual'|'apollo';sourceUrl?:string;sourceMessageId?:string;sourceEventId?:string;sourceOccurrenceId?:string};
export function validate(e:EventInput){if(!e.name.trim()||e.name.length>100)throw new Error('Event name must be 1–100 characters');if(!Number.isFinite(e.start)||e.end!==null&&(!Number.isFinite(e.end)||e.end<=e.start))throw new Error('End time must be after start time');if(!e.channels.length||new Set(e.channels).size!==e.channels.length)throw new Error('Choose distinct voice channels');if(!Number.isSafeInteger(e.minimumMinutes)||e.minimumMinutes<0||e.minimumMinutes>10080)throw new Error('Invalid minimum attendance');}
export function createEvent(store:Store,guild:string,actor:string,e:EventInput,now:number){validate(e);return store.db.transaction(()=>{
  const result=store.db.prepare(`INSERT INTO events(guild_id,name,description,start_at,end_at,channels,min_ms,source,source_url,source_message_id,source_event_id,source_occurrence_id,created_at,updated_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(guild,e.name,e.description??'',e.start,e.end,JSON.stringify(e.channels),e.minimumMinutes*60_000,e.source??'manual',e.sourceUrl??null,e.sourceMessageId??null,e.sourceEventId??null,e.sourceOccurrenceId??null,now,now,actor);
  const id=Number(result.lastInsertRowid);store.db.prepare('INSERT INTO event_audit(guild_id,event_id,actor_id,at,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?)').run(guild,id,actor,now,'Created',null,JSON.stringify(e));return id;
})();}
export function updateEvent(store:Store,guild:string,id:number,actor:string,patch:Partial<EventInput>,reason:string,now:number){if(!reason.trim())throw new Error('Reason is required');return store.db.transaction(()=>{
  const old=store.db.prepare('SELECT * FROM events WHERE guild_id=? AND id=?').get(guild,id) as EventRow|undefined;if(!old)throw new Error('Event not found');
  const e:EventInput={name:patch.name??old.name,description:patch.description??old.description,start:patch.start??old.start_at,end:patch.end===undefined?old.end_at:patch.end,channels:patch.channels??JSON.parse(old.channels),minimumMinutes:patch.minimumMinutes??old.min_ms/60_000,source:old.source as 'manual'|'apollo',sourceUrl:old.source_url??undefined,sourceMessageId:old.source_message_id??undefined,sourceEventId:old.source_event_id??undefined,sourceOccurrenceId:old.source_occurrence_id??undefined};validate(e);
  const changed=old.start_at!==e.start||old.end_at!==e.end||old.channels!==JSON.stringify(e.channels)||old.min_ms!==e.minimumMinutes*60_000;
  store.db.prepare('UPDATE events SET name=?,description=?,start_at=?,end_at=?,channels=?,min_ms=?,revision=revision+?,updated_at=? WHERE guild_id=? AND id=?').run(e.name,e.description,e.start,e.end,JSON.stringify(e.channels),e.minimumMinutes*60_000,changed?1:0,now,guild,id);
  store.db.prepare('INSERT INTO event_audit(guild_id,event_id,actor_id,at,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?)').run(guild,id,actor,now,reason,JSON.stringify(old),JSON.stringify(e));return changed;
})();}
export function correctAttendance(store:Store,guild:string,event:number,user:string,minutes:number,actor:string,reason:string,now:number){if(!reason.trim()||!Number.isSafeInteger(minutes))throw new Error('A reason and integer minutes are required');const exists=store.db.prepare('SELECT 1 FROM events WHERE guild_id=? AND id=?').get(guild,event);if(!exists)throw new Error('Event not found');store.db.prepare('INSERT INTO corrections(guild_id,event_id,user_id,minutes,actor_id,at,reason) VALUES(?,?,?,?,?,?,?)').run(guild,event,user,minutes,actor,now,reason);}

export type ApolloFields={name:string|null;description:string|null;start:number|null;end:number|null;eventId:string|null;occurrenceId:string|null};
export function parseApollo(message:{content?:string;embeds?:Array<{title?:string|null;description?:string|null;fields?:Array<{name:string;value:string}>;url?:string|null}>}):ApolloFields{
  const embed=message.embeds?.[0];const text=[message.content??'',embed?.description??'',...(embed?.fields??[]).map(f=>`${f.name}: ${f.value}`)].join('\n');
  const time=(label:string)=>{const field=embed?.fields?.find(f=>new RegExp(label,'i').test(f.name));const source=field?.value??text.match(new RegExp(`${label}[^\n]*`, 'i'))?.[0]??'';const discord=source.match(/<t:(\d{9,12})(?::[tTdDfFR])?>/);if(discord)return Number(discord[1])*1000;const iso=source.match(/\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d)?(?:Z|[+-]\d\d:?\d\d)/);return iso?Date.parse(iso[0]):null;};
  const id=embed?.url?.match(/(?:event|events)\/(\d+)/)?.[1]??null;
  return {name:embed?.title?.trim()||null,description:embed?.description?.trim()||null,start:time('start'),end:time('end'),eventId:id,occurrenceId:null};
}
