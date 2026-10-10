import http from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID, randomBytes, scryptSync, timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {fail, text, validDate, validateSchedule, eligible, planTours, makeSeed, reconcileStudent, assertAssignment, seats, wheels, minutes, weekday, updateTourTiming} from './domain.js';

const root=path.dirname(fileURLToPath(import.meta.url));
const dataDir=process.env.DATA_DIR || path.join(root,'data');
const pythonBinary=process.env.PYTHON_BIN || (existsSync(path.join(root,'.venv/bin/python'))?path.join(root,'.venv/bin/python'):'python');
await mkdir(dataDir,{recursive:true,mode:0o700});
const db=new DatabaseSync(path.join(dataDir,'schulweg.sqlite'));
db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
let state;
const saved=db.prepare('SELECT body FROM app_state WHERE id=1').get();
function dateNow() {return new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Berlin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function persist(next) { db.prepare('INSERT INTO app_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(next)); state=next; }
if(saved) state=JSON.parse(saved.body);
else { let d=dateNow(); while(weekday(d)>4) d=new Date(new Date(d+'T12:00:00Z').getTime()+86400000).toISOString().slice(0,10); const seed=makeSeed(randomUUID,d);planTours(seed,d,'return',randomUUID);persist(seed); }
const adminPassword=process.env.ADMIN_PASSWORD || 'Schulweg-Demo!';
const driverPassword=process.env.DRIVER_PASSWORD || 'Fahrer-Demo!';
db.exec('CREATE TABLE IF NOT EXISTS credentials (role TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL);');
let secureConfig=Boolean(process.env.ADMIN_PASSWORD&&process.env.DRIVER_PASSWORD&&adminPassword.length>=12&&driverPassword.length>=12);
const credentials={};
for(const role of ['admin','driver']) {
  const saved=db.prepare('SELECT salt,hash FROM credentials WHERE role=?').get(role);
  if(saved)credentials[role]={salt:Buffer.from(saved.salt,'hex'),hash:Buffer.from(saved.hash,'hex')};
  else {const salt=randomBytes(16);credentials[role]={salt,hash:scryptSync(role==='admin'?adminPassword:driverPassword,salt,32)};}
}
if(db.prepare('SELECT count(*) AS n FROM credentials').get().n===2)secureConfig=true;
if(!state.demo&&!secureConfig) throw new Error('Echtdaten erfordern eigene Zugangspasswörter.');
const sessions=new Map(), previews=new Map(), attempts=new Map();
function json(res,status,body) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));}
async function body(req,raw=false) {const chunks=[];let size=0;for await(const c of req) {size+=c.length;if(size>8*1024*1024)fail('Datei zu groß. Maximal 8 MB.',413);chunks.push(c);}const b=Buffer.concat(chunks);if(raw)return b;try{return JSON.parse(b.toString('utf8')||'{}');}catch{fail('Ungültiges JSON.');}}
function auth(req) {const sid=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('schulweg='))?.slice(9);const s=sessions.get(sid);if(!s||s.expires<Date.now()||(s.role==='driver'&&!state.drivers.some(d=>d.id===s.driverId&&d.active)))fail('Bitte anmelden.',401);return s;}
function admin(s) {if(s.role!=='admin')fail('Nur für die Disposition verfügbar.',403);}
function mutate(fn) {const next=structuredClone(state);const result=fn(next);next.revision++;persist(next);return result;}
function studentRecord(s,input,existing) {
  if(!s.schools.some(v=>v.id===input.schoolId))fail('Bitte eine vorhandene Schule wählen.');
  return {...existing,id:existing?.id||randomUUID(),name:text(input.name,'Name'),address:text(input.address,'Adresse',240),district:text(input.district,'Wohngebiet',80),schoolId:input.schoolId,contact:typeof input.contact==='string'?input.contact.slice(0,200):'',notes:typeof input.notes==='string'?input.notes.slice(0,1000):'',morningPickup:typeof input.morningPickup==='string'?input.morningPickup.slice(0,150):existing?.morningPickup||'',active:input.active!==false,wheelchair:input.wheelchair===true,companion:input.companion===true,outboundEnabled:input.outboundEnabled!==false,needsReview:input.needsReview===true,schedule:validateSchedule(input.schedule)};
}
function requireRevision(req) {const rev=Number(req.headers['if-match']);if(!Number.isFinite(rev)||rev!==state.revision) fail('Daten wurden inzwischen geändert. Bitte aktualisieren und erneut versuchen.',409);}
function runPython(args,input) {return new Promise((resolve,reject)=>{const p=spawn(pythonBinary,['./spreadsheet.py',...args],{cwd:root,stdio:['pipe','pipe','pipe']});const out=[],err=[];const timer=setTimeout(()=>{p.kill();reject(new Error('Dateiverarbeitung hat zu lange gedauert.'));},30000);p.stdout.on('data',d=>out.push(d));p.stderr.on('data',d=>err.push(d));p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);if(code)reject(new Error('Datei konnte nicht verarbeitet werden. Bitte Excel-/CSV-Struktur prüfen.'));else resolve(Buffer.concat(out));});p.stdin.on('error',()=>{});p.stdin.end(input);});}
function driverState(s) {
  const tours=state.tours.filter(t=>t.driverId===s.driverId), ids=new Set(tours.flatMap(t=>t.studentIds)), schoolIds=new Set(tours.map(t=>t.schoolId));
  return {revision:state.revision,demo:state.demo,tours,students:state.students.filter(v=>ids.has(v.id)).map(({contact,source,importWarnings,...v})=>v),schools:state.schools.filter(v=>schoolIds.has(v.id)),buses:state.buses.filter(v=>tours.some(t=>t.busId===v.id)),drivers:state.drivers.filter(d=>d.id===s.driverId),absences:[]};
}
function syncImport(s,preview) {
  if(!secureConfig)fail('Für Echtdaten zuerst eigene ADMIN_PASSWORD und DRIVER_PASSWORD (mindestens 12 Zeichen) setzen und den Server neu starten.');
  if(s.demo) {s.students=[];s.schools=[];s.absences=[];s.tours=[];s.demo=false;}
  const schoolMap=new Map();
  for(const school of preview.schools) {
    let current=s.schools.find(v=>v.name.toLowerCase()===school.name.toLowerCase());
    if(!current){current={id:randomUUID(),name:school.name,address:school.address||'',sourceCode:school.code||''};s.schools.push(current);}
    schoolMap.set(school.key,current.id);
  }
  let added=0,updated=0,duplicate=0;
  const seen=new Set();
  for(const row of preview.students) {
    const key=`${row.name.toLowerCase()}|${row.address.toLowerCase()}`;
    if(seen.has(key)){duplicate++;continue;}seen.add(key);
    const existing=s.students.find(v=>`${v.name.toLowerCase()}|${v.address.toLowerCase()}`===key);
    if(!existing&&s.students.length>=250)fail('Maximal 250 Schüler. Import wurde vollständig abgebrochen.');
    if(existing&&s.tours.some(t=>t.studentIds.includes(existing.id)&&Object.values(t.progress).some(p=>p!=='waiting')&&!Object.values(t.progress).every(p=>p==='done'||p==='skipped')))fail('Import würde einen Schüler einer begonnenen Tour ändern. Bitte nach Abschluss importieren.');
    const record={...row,id:existing?.id||randomUUID(),schoolId:schoolMap.get(row.schoolKey),active:row.active!==false};delete record.schoolKey;
    record.name=text(record.name,'Name');record.address=typeof record.address==='string'?record.address.slice(0,240):'';record.district=text(record.district,'Wohngebiet',80);record.schedule=validateSchedule(record.schedule);
    if(!record.schoolId)fail('Schulzuordnung fehlt.');
    if(existing){s.students[s.students.indexOf(existing)]=record;reconcileStudent(s,record.id);updated++;}else{s.students.push(record);added++;}
  }
  return {added,updated,duplicate};
}

const server=http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'), p=url.pathname;
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    if(req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`${req.socket.encrypted?'https':'http'}://${req.headers.host}`)fail('Unerlaubter Ursprung.',403);
    if(p==='/api/login'&&req.method==='POST') {
      const input=await body(req), key=req.socket.remoteAddress;let limit=attempts.get(key);if(!limit||limit.until<Date.now())limit={count:0,until:Date.now()+300000};if(limit.count>=15)fail('Zu viele Anmeldeversuche. In fünf Minuten erneut versuchen.',429);limit.count++;attempts.set(key,limit);
      const role=input.username==='admin'?'admin':'driver';const driver=state.drivers.find(d=>d.username===input.username&&d.active);
      if((role==='driver'&&!driver)||typeof input.password!=='string'||input.password.length>200||!timingSafeEqual(scryptSync(input.password||'',credentials[role].salt,32),credentials[role].hash))fail('Benutzername oder Passwort stimmt nicht.',401);
      attempts.delete(key);const sid=randomBytes(32).toString('hex'), session={id:sid,role,driverId:driver?.id,name:driver?.name||'Disposition',expires:Date.now()+12*3600000};sessions.set(sid,session);
      res.setHeader('Set-Cookie',`schulweg=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);return json(res,200,{role:session.role,name:session.name,driverId:session.driverId});
    }
    if(p==='/api/config'&&req.method==='GET')return json(res,200,{demo:state.demo,demoLogin:state.demo&&!secureConfig&&!process.env.ADMIN_PASSWORD&&!process.env.DRIVER_PASSWORD,secureConfig,providedImport:existsSync(path.join(dataDir,'import-source.xlsx')), today:dateNow()});
    if(p.startsWith('/api/')) {
      const session=auth(req);
      if(p==='/api/me'&&req.method==='GET')return json(res,200,{role:session.role,name:session.name,driverId:session.driverId});
      if(p==='/api/logout'&&req.method==='POST'){sessions.delete(session.id);res.setHeader('Set-Cookie','schulweg=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{ok:true});}
      if(p==='/api/state'&&req.method==='GET')return json(res,200,session.role==='admin'?state:driverState(session));
      if(p==='/api/import/provided'&&req.method==='GET') {
        admin(session);if(!secureConfig)fail('Vor dem Zugriff auf die bereitgestellte Schülerübersicht bitte eigene Zugangspasswörter einrichten.');
        if(!existsSync(path.join(dataDir,'import-source.xlsx')))fail('Keine Schülerübersicht bereitgestellt.',404);
        const preview=JSON.parse((await runPython(['preview','xlsx','50'],await readFile(path.join(dataDir,'import-source.xlsx')))).toString('utf8'));
        const token=randomUUID();previews.set(token,{preview,sessionId:session.id,expires:Date.now()+600000});return json(res,200,{...preview,token});
      }
      if(p==='/api/export'&&req.method==='GET') {
        admin(session);const format=url.searchParams.get('format')||'xlsx';if(!['xlsx','csv','json'].includes(format))fail('Ungültiges Exportformat.');
        const bytes=format==='json'?Buffer.from(JSON.stringify({format:'schulweg-backup-v1',...state},null,2)):await runPython(['export',format],Buffer.from(JSON.stringify(state)));
        res.writeHead(200,{'Content-Type':format==='xlsx'?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':format==='csv'?'text/csv; charset=utf-8':'application/json','Content-Disposition':`attachment; filename="schulweg-${dateNow()}.${format}"`,'Cache-Control':'no-store'});return res.end(bytes);
      }
      if(p==='/api/import/preview'&&req.method==='POST') {
        admin(session);const format=url.searchParams.get('format');if(!['xlsx','csv','json'].includes(format))fail('Excel (.xlsx), CSV oder JSON wählen.');
        const sheet=Number(url.searchParams.get('sheet')||0);if(!Number.isInteger(sheet)||sheet<0||sheet>50)fail('Ungültiges Tabellenblatt.');
        const buffer=await body(req,true);let preview;
        if(format==='json') {let parsed;try{parsed=JSON.parse(buffer.toString('utf8'));}catch{fail('Ungültige JSON-Datei.');}if(parsed.format!=='schulweg-backup-v1')fail('JSON muss ein Schulweg-Backup sein.');preview={backup:parsed,students:parsed.students||[],schools:parsed.schools||[],warnings:['Vollständige Wiederherstellung ersetzt alle aktuellen Daten einschließlich Touren und Abwesenheiten.'],type:'backup'};}
        else preview=JSON.parse((await runPython(['preview',format,String(sheet)],buffer)).toString('utf8'));
        if(!preview.students.length)fail('Keine Schülerdaten gefunden. Tabellenblatt und Überschriften prüfen.');
        if(preview.students.length>250)fail('Import enthält mehr als 250 Schülerzeilen.');
        const token=randomUUID();previews.set(token,{preview,sessionId:session.id,expires:Date.now()+600000});return json(res,200,{...preview,backup:undefined,token});
      }
      if(p==='/api/tours/progress'&&req.method==='POST') {
        const input=await body(req);requireRevision(req);
        mutate(s=>{const t=s.tours.find(v=>v.id===input.tourId);if(!t)fail('Tour nicht gefunden.',404);if(session.role!=='admin'&&t.driverId!==session.driverId)fail('Tour gehört zu einem anderen Fahrer.',403);if(!t.studentIds.includes(input.studentId))fail('Fahrgast gehört nicht zur Tour.');if(!['waiting','onboard','done','skipped'].includes(input.status))fail('Ungültiger Fahrgaststatus.');const prev=t.progress[input.studentId];const allowed={waiting:['onboard','skipped'],onboard:['done'],done:[],skipped:['waiting']};if(!allowed[prev]?.includes(input.status))fail('Statuswechsel nicht zulässig.');t.progress[input.studentId]=input.status;});return json(res,200,{ok:true});
      }
      admin(session);
      if(req.method==='POST'||req.method==='PUT'||req.method==='DELETE')requireRevision(req);
      if(p==='/api/security/setup'&&req.method==='POST') {
        if(secureConfig)fail('Passwörter sind bereits eingerichtet.');
        const input=await body(req);for(const key of ['adminPassword','driverPassword'])if(typeof input[key]!=='string'||input[key].length<12||input[key].length>200)fail('Beide Passwörter müssen 12 bis 200 Zeichen haben.');
        if(input.adminPassword===input.driverPassword)fail('Bitte unterschiedliche Passwörter für Disposition und Fahrer wählen.');
        db.exec('BEGIN');try {for(const role of ['admin','driver']){const salt=randomBytes(16),hash=scryptSync(input[role+'Password'],salt,32);db.prepare('INSERT OR REPLACE INTO credentials(role,salt,hash) VALUES(?,?,?)').run(role,salt.toString('hex'),hash.toString('hex'));credentials[role]={salt,hash};}db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
        secureConfig=true;for(const [id] of sessions)if(id!==session.id)sessions.delete(id);return json(res,200,{ok:true});
      }
      if(p==='/api/students'&&req.method==='POST') {const input=await body(req);const result=mutate(s=>{if(s.students.length>=250)fail('Maximal 250 Schüler möglich.');const record=studentRecord(s,input);s.students.push(record);return record;});return json(res,201,result);}
      if(p.startsWith('/api/students/')&&req.method==='PUT') {const input=await body(req),id=p.split('/').pop();mutate(s=>{const i=s.students.findIndex(v=>v.id===id);if(i<0)fail('Schüler nicht gefunden.',404);if(s.tours.some(t=>t.studentIds.includes(id)&&Object.values(t.progress).some(p=>p!=='waiting')&&!Object.values(t.progress).every(p=>p==='done'||p==='skipped')))fail('Schüler einer begonnenen Tour können erst nach deren Abschluss bearbeitet werden.');s.students[i]=studentRecord(s,input,s.students[i]);reconcileStudent(s,id);});return json(res,200,{ok:true});}
      if(p==='/api/schools'&&req.method==='POST'){const input=await body(req);mutate(s=>{if(s.schools.length>=30)fail('Maximal 30 Schulstandorte möglich.');s.schools.push({id:randomUUID(),name:text(input.name,'Schulname'),address:text(input.address,'Adresse',240)});});return json(res,201,{ok:true});}
      if(p.startsWith('/api/schools/')&&req.method==='PUT'){const input=await body(req);mutate(s=>{const school=s.schools.find(v=>v.id===p.split('/').pop());if(!school)fail('Schule nicht gefunden.',404);Object.assign(school,{name:text(input.name,'Schulname'),address:text(input.address,'Adresse',240)});});return json(res,200,{ok:true});}
      if(p==='/api/absences'&&req.method==='POST') {const input=await body(req);mutate(s=>{if(!s.students.some(v=>v.id===input.studentId))fail('Schüler nicht gefunden.');validDate(input.from);validDate(input.to);if(input.from>input.to)fail('Enddatum liegt vor Beginn.');if(!['both','return','outbound'].includes(input.direction))fail('Fahrtrichtung wählen.');s.absences.push({id:randomUUID(),studentId:input.studentId,from:input.from,to:input.to,direction:input.direction,reason:text(input.reason,'Grund',150)});reconcileStudent(s,input.studentId);});return json(res,201,{ok:true});}
      if(p.startsWith('/api/absences/')&&req.method==='DELETE'){mutate(s=>{s.absences=s.absences.filter(a=>a.id!==p.split('/').pop());});return json(res,200,{ok:true,replan:true});}
      if(p==='/api/plan'&&req.method==='POST'){const input=await body(req);validDate(input.date);const result=mutate(s=>planTours(s,input.date,input.direction,randomUUID));return json(res,200,result);}
      if(p==='/api/tours'&&req.method==='POST') {
        const input=await body(req);validDate(input.date);minutes(input.time);
        mutate(s=>{
          if(!Array.isArray(input.studentIds)||!input.studentIds.length||new Set(input.studentIds).size!==input.studentIds.length)fail('Mindestens einen eindeutigen Schüler auswählen.');
          const day=weekday(input.date),candidates=eligible(s,input.date,input.direction);if(day>4)fail('Schultag auswählen.');
          for(const id of input.studentIds){const pupil=candidates.find(v=>v.id===id);if(!pupil||pupil.schoolId!==input.schoolId||(input.direction==='return'?pupil.schedule[day].end:pupil.schedule[day].start)!==input.time)fail('Alle Schüler müssen Schule, Fahrtrichtung und Zeit entsprechen.');}
          if(seats(s,input.studentIds)>8)fail('Maximal acht Fahrgäste einschließlich Begleitpersonen.');
          const sources=s.tours.filter(t=>t.date===input.date&&t.direction===input.direction&&t.studentIds.some(id=>input.studentIds.includes(id)));
          if(sources.some(t=>Object.values(t.progress).some(p=>p!=='waiting')))fail('Begonnene Touren können nicht verändert werden.');
          for(const source of sources){source.studentIds=source.studentIds.filter(id=>!input.studentIds.includes(id));for(const id of input.studentIds)delete source.progress[id];updateTourTiming(s,source);}
          s.tours=s.tours.filter(t=>t.studentIds.length);
          const t={id:randomUUID(),date:input.date,direction:input.direction,time:input.time,schoolId:input.schoolId,studentIds:input.studentIds,busId:null,driverId:null,progress:Object.fromEntries(input.studentIds.map(id=>[id,'waiting']))};updateTourTiming(s,t);s.tours.push(t);
        });return json(res,201,{ok:true});
      }
      if(p==='/api/tours/assignment'&&req.method==='POST'){const input=await body(req);mutate(s=>{const t=s.tours.find(v=>v.id===input.tourId);if(!t)fail('Tour nicht gefunden.');if(Object.values(t.progress).some(p=>p!=='waiting'))fail('Begonnene Tour kann nicht umgeplant werden.');assertAssignment(s,t,input.busId,input.driverId);t.busId=input.busId;t.driverId=input.driverId;});return json(res,200,{ok:true});}
      if(p==='/api/tours/move'&&req.method==='POST'){const input=await body(req);mutate(s=>{const t=s.tours.find(v=>v.id===input.tourId);if(!t)fail('Zieltour nicht gefunden.');const pupil=eligible(s,t.date,t.direction).find(v=>v.id===input.studentId);const day=weekday(t.date);if(!pupil||pupil.schoolId!==t.schoolId||(t.direction==='return'?pupil.schedule[day].end:pupil.schedule[day].start)!==t.time)fail('Schule, Tag oder individuelle Zeit passt nicht zur Tour.');const source=s.tours.find(v=>v.date===t.date&&v.direction===t.direction&&v.studentIds.includes(pupil.id));if(source?.id===t.id)fail('Schüler ist bereits in dieser Tour.');if([t,source].filter(Boolean).some(v=>Object.values(v.progress).some(p=>p!=='waiting')))fail('Begonnene Tour kann nicht verändert werden.');t.studentIds.push(pupil.id);t.progress[pupil.id]='waiting';updateTourTiming(s,t);if(seats(s,t.studentIds)>8)fail('Maximal acht Fahrgäste einschließlich Begleitpersonen.');if(t.busId&&t.driverId)assertAssignment(s,t,t.busId,t.driverId);if(source){source.studentIds=source.studentIds.filter(v=>v!==pupil.id);delete source.progress[pupil.id];updateTourTiming(s,source);}s.tours=s.tours.filter(v=>v.studentIds.length);});return json(res,200,{ok:true});}
      if(p==='/api/buses'&&req.method==='POST'){const input=await body(req);mutate(s=>{const capacity=Number(input.capacity),wc=Number(input.wheelchairSpaces);if(!Number.isInteger(capacity)||capacity<1||capacity>8||!Number.isInteger(wc)||wc<0||wc>capacity)fail('Fahrgäste: 1–8; Rollstuhlplätze dürfen die Kapazität nicht überschreiten.');s.buses.push({id:randomUUID(),name:text(input.name,'Fahrzeugname'),plate:text(input.plate,'Kennzeichen',30),capacity,wheelchairSpaces:wc,active:input.active!==false});});return json(res,201,{ok:true});}
      if(p.startsWith('/api/buses/')&&req.method==='PUT') {
        const input=await body(req);mutate(s=>{const b=s.buses.find(b=>b.id===p.split('/').pop());if(!b)fail('Fahrzeug nicht gefunden.',404);const capacity=Number(input.capacity),wc=Number(input.wheelchairSpaces);if(!Number.isInteger(capacity)||capacity<1||capacity>8||!Number.isInteger(wc)||wc<0||wc>capacity)fail('Fahrgäste: 1–8; Rollstuhlplätze dürfen die Kapazität nicht überschreiten.');
          const tours=s.tours.filter(t=>t.busId===b.id&&!Object.values(t.progress).every(p=>p==='done'||p==='skipped'));if(tours.some(t=>Object.values(t.progress).some(p=>p!=='waiting')))fail('Fahrzeug ist in einer begonnenen Tour. Nach Abschluss bearbeiten.');
          Object.assign(b,{name:text(input.name,'Fahrzeugname'),plate:text(input.plate,'Kennzeichen',30),capacity,wheelchairSpaces:wc,active:input.active!==false});for(const t of tours)if(!b.active||seats(s,t.studentIds)>capacity||wheels(s,t.studentIds)>wc){t.busId=null;t.driverId=null;}
        });return json(res,200,{ok:true});
      }
      if(p.startsWith('/api/drivers/')&&req.method==='PUT') {
        const input=await body(req);mutate(s=>{const d=s.drivers.find(d=>d.id===p.split('/').pop());if(!d)fail('Fahrer nicht gefunden.',404);const username=text(input.username,'Benutzername',50);if(!/^[a-z0-9._-]+$/.test(username)||username==='admin'||s.drivers.some(v=>v.id!==d.id&&v.username===username))fail('Eindeutigen Benutzernamen wählen.');const tours=s.tours.filter(t=>t.driverId===d.id&&!Object.values(t.progress).every(p=>p==='done'||p==='skipped'));if(tours.some(t=>Object.values(t.progress).some(p=>p!=='waiting')))fail('Fahrer ist in einer begonnenen Tour. Nach Abschluss bearbeiten.');Object.assign(d,{name:text(input.name,'Fahrername'),username,active:input.active!==false});if(!d.active)for(const t of tours){t.busId=null;t.driverId=null;}});return json(res,200,{ok:true});
      }
      if(p==='/api/drivers'&&req.method==='POST'){const input=await body(req);mutate(s=>{const username=text(input.username,'Benutzername',50);if(!/^[a-z0-9._-]+$/.test(username)||username==='admin'||s.drivers.some(d=>d.username===username))fail('Eindeutigen Benutzernamen aus Kleinbuchstaben und Ziffern wählen.');s.drivers.push({id:randomUUID(),name:text(input.name,'Fahrername'),username,active:input.active!==false});});return json(res,201,{ok:true});}
      if(p==='/api/import/commit'&&req.method==='POST'){const input=await body(req),entry=previews.get(input.token);if(!entry||entry.sessionId!==session.id||entry.expires<Date.now())fail('Importvorschau abgelaufen. Datei erneut wählen.');if(!input.confirm)fail('Import muss bestätigt werden.');const result=mutate(s=>{if(entry.preview.type==='backup'){if(!secureConfig)fail('Echtdaten erfordern eigene Serverpasswörter.');validateBackup(entry.preview.backup);const revision=s.revision;for(const key of ['schools','students','buses','drivers','absences','tours'])s[key]=entry.preview.backup[key];s.revision=revision;s.demo=false;return{restored:true};}const mapped=structuredClone(entry.preview);const mappings=input.schoolMappings||{};
        for(const [sourceKey,targetKey] of Object.entries(mappings)) {
          if(!targetKey)continue;const target=mapped.schoolDirectory?.find(s=>s.key===targetKey);if(!target)fail('Schulzuordnung nicht gefunden.');
          if(!mapped.schools.some(s=>s.key===targetKey))mapped.schools.push(target);
          for(const pupil of mapped.students.filter(v=>v.schoolKey===sourceKey)){pupil.schoolKey=targetKey;pupil.importWarnings=pupil.importWarnings.filter(w=>!w.startsWith('Schule nicht eindeutig'));pupil.needsReview=pupil.importWarnings.length>0;}
        }
        const used=new Set(mapped.students.map(v=>v.schoolKey));mapped.schools=mapped.schools.filter(v=>used.has(v.key));return syncImport(s,mapped);});previews.delete(input.token);return json(res,200,result);}
      fail('Aktion nicht gefunden.',404);
    }
    if(req.method!=='GET')fail('Methode nicht erlaubt.',405);
    const filename=p==='/'||p==='/fahrer'||p==='/login'?'index.html':p.slice(1);
    if(!['index.html','app.js','style.css'].includes(filename))fail('Nicht gefunden.',404);
    const content=await readFile(path.join(root,'public',filename));res.writeHead(200,{'Content-Type':filename.endsWith('.js')?'text/javascript; charset=utf-8':filename.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-cache','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"});res.end(content);
  } catch(error) {json(res,error.status||500,{error:error.status?error.message:'Die Aktion konnte nicht abgeschlossen werden. Bitte Serverkonfiguration und Datei prüfen.'});if(!error.status)console.error('Server error:',error.code||error.name);}
});
function validateBackup(b) {
  for(const k of ['schools','students','buses','drivers','absences','tours'])if(!Array.isArray(b[k]))fail('Unvollständiges Backup.');
  if(b.students.length>250||b.schools.length>30)fail('Backup überschreitet die unterstützten Grenzen.');
  const all=new Set();for(const collection of [b.students,b.schools,b.buses,b.drivers,b.absences,b.tours])for(const r of collection){if(typeof r.id!=='string'||all.has(r.id))fail('Fehlende oder doppelte Backup-ID.');all.add(r.id);}
  for(const s of b.students){studentRecord(b,s,s);}
  for(const school of b.schools){text(school.name,'Schule');if(school.address)text(school.address,'Schuladresse',240);else if(b.tours.some(t=>t.schoolId===school.id))fail('Schuladresse einer geplanten Tour fehlt.');}
  for(const bus of b.buses){if(!Number.isInteger(bus.capacity)||bus.capacity<1||bus.capacity>8||!Number.isInteger(bus.wheelchairSpaces)||bus.wheelchairSpaces<0||bus.wheelchairSpaces>bus.capacity)fail('Ungültige Fahrzeugkapazität.');}
  for(const d of b.drivers){text(d.name,'Fahrer');if(!/^[a-z0-9._-]+$/.test(d.username)||d.username==='admin'||b.drivers.filter(v=>v.username===d.username).length>1)fail('Ungültiger Fahrerbenutzername.');}
  for(const a of b.absences){validDate(a.from);validDate(a.to);if(a.from>a.to||!b.students.some(s=>s.id===a.studentId)||!['both','outbound','return'].includes(a.direction))fail('Ungültige Abwesenheit.');}
  const memberships=new Set();for(const t of b.tours){validDate(t.date);minutes(t.time);if(!['outbound','return'].includes(t.direction)||!Array.isArray(t.studentIds)||!t.studentIds.length||new Set(t.studentIds).size!==t.studentIds.length||seats(b,t.studentIds)>8||!b.schools.some(s=>s.id===t.schoolId))fail('Ungültige Tour.');for(const id of t.studentIds){const student=b.students.find(s=>s.id===id),key=`${t.date}|${t.direction}|${id}`;if(!student||student.schoolId!==t.schoolId||memberships.has(key)||!['waiting','onboard','done','skipped'].includes(t.progress?.[id]))fail('Ungültige Tourzuordnung.');memberships.add(key);}if(Boolean(t.busId)!==Boolean(t.driverId))fail('Unvollständige Fahrzeugzuordnung.');if(t.busId)assertAssignment(b,t,t.busId,t.driverId);}
}
const port=Number(process.env.PORT||3000);
server.listen(port,process.env.HOST||'0.0.0.0',()=>console.log(`Schulweg gestartet auf Port ${server.address().port}. ${state.demo?'Fiktive Demodaten.':'Echtdatenmodus.'}`));
