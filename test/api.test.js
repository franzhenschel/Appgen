import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
let proc,dir,base,cookie,driverCookie,revision;
before(async()=>{
  dir=await mkdtemp(path.join(os.tmpdir(),'schulweg-test-'));
  proc=spawn(process.execPath,['server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',DATA_DIR:dir,ADMIN_PASSWORD:'TestAdmin-Only-123!',DRIVER_PASSWORD:'TestDriver-Only-123!'},stdio:['ignore','pipe','pipe']});
  base=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Startup timed out')),10000);proc.stdout.on('data',data=>{const match=data.toString().match(/Port (\d+)/);if(match){clearTimeout(timeout);resolve('http://127.0.0.1:'+match[1]);}});proc.once('exit',()=>{clearTimeout(timeout);reject(new Error('Server failed'));});});
  const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:'TestAdmin-Only-123!'})});assert.equal(login.status,200);cookie=login.headers.get('set-cookie').split(';')[0];
  const d=await fetch(base+'/api/login',{method:'POST',body:JSON.stringify({username:'fahrer1',password:'TestDriver-Only-123!'})});driverCookie=d.headers.get('set-cookie').split(';')[0];
});
after(async()=>{proc?.kill();if(proc)await new Promise(resolve=>proc.once('exit',resolve));await rm(dir,{recursive:true,force:true});});
async function req(p,method='GET',data,who=cookie){return fetch(base+'/api'+p,{method,headers:{Cookie:who||'','Content-Type':'application/json',...(method==='GET'?{}:{'If-Match':String(revision)})},body:data===undefined?undefined:JSON.stringify(data)});}
async function current(){const r=await req('/state');const s=await r.json();revision=s.revision;return s;}

test('Authentifizierung und Fahrer-Datentrennung',async()=>{
  assert.equal((await req('/state','GET',undefined,'')).status,401);const full=await current(), own=await (await req('/state','GET',undefined,driverCookie)).json();assert.ok(own.students.length<full.students.length);assert.ok(own.tours.every(t=>t.driverId===full.drivers[0].id));assert.equal((await req('/export','GET',undefined,driverCookie)).status,403);assert.equal((await req('/plan','POST',{date:'2026-10-12',direction:'return'},driverCookie)).status,403);
});
test('Krankmeldung wird persistiert und erreicht das Fahrerportal',async()=>{
  const s=await current(),tour=s.tours.find(t=>t.driverId===s.drivers[0].id),id=tour.studentIds[0];
  const r=await req('/absences','POST',{studentId:id,from:tour.date,to:tour.date,direction:'return',reason:'Krankmeldung'});assert.equal(r.status,201);
  const own=await (await req('/state','GET',undefined,driverCookie)).json();assert.ok(!own.tours.some(t=>t.studentIds.includes(id)));assert.equal(own.revision,s.revision+1);
  assert.equal((await req('/plan','POST',{date:tour.date,direction:'return'})).status,409);await current();
});
test('Fahrer kann Status ändern; Krankmeldung an Bord wird atomar abgelehnt',async()=>{
  const s=await current(),tour=s.tours.find(t=>t.driverId===s.drivers[0].id),id=tour.studentIds[0];
  assert.equal((await req('/tours/progress','POST',{tourId:tour.id,studentId:id,status:'onboard'},driverCookie)).status,200);await current();
  assert.equal((await req('/absences','POST',{studentId:id,from:tour.date,to:tour.date,direction:'return',reason:'Krankmeldung'})).status,400);
  const updated=await current();assert.equal(updated.absences.length,s.absences.length);assert.equal(updated.tours.find(t=>t.id===tour.id).progress[id],'onboard');
  assert.equal((await req('/tours/progress','POST',{tourId:tour.id,studentId:id,status:'done'},driverCookie)).status,200);
});
test('Eigene Touren verschieben Schüler ohne doppelte Beförderung',async()=>{
  const s=await current(),source=s.tours.find(t=>Object.values(t.progress).every(p=>p==='waiting')),id=source.studentIds[0];
  const r=await req('/tours','POST',{date:source.date,direction:source.direction,time:source.time,schoolId:source.schoolId,studentIds:[id]});assert.equal(r.status,201);
  const next=await current(),members=next.tours.filter(t=>t.date===source.date&&t.direction===source.direction&&t.studentIds.includes(id));assert.equal(members.length,1);assert.notEqual(members[0].id,source.id);assert.equal(members[0].busId,null);
  assert.equal((await req('/tours','POST',{date:source.date,direction:source.direction,time:'18:00',schoolId:source.schoolId,studentIds:[id]})).status,400);
});
test('Excel-Export kann wieder eingelesen werden; JSON-Backup bleibt vollständig',async()=>{
  await current();const x=await req('/export?format=xlsx');assert.equal(x.status,200);const bytes=await x.arrayBuffer();assert.ok(bytes.byteLength>5000);
  const p=await fetch(base+'/api/import/preview?format=xlsx',{method:'POST',headers:{Cookie:cookie},body:bytes});assert.equal(p.status,200);const preview=await p.json();assert.equal(preview.students.length,36);assert.equal(preview.schools.length,6);
  const backup=await (await req('/export?format=json')).json();assert.equal(backup.format,'schulweg-backup-v1');assert.ok(backup.tours.length);assert.ok(backup.absences.length);assert.equal(backup.drivers.length,6);
});
test('CSV-Import zeigt Vorschau und speichert Daten erst nach bestätigter Übernahme',async()=>{
  await current();const csv='Name;Schule;Schuladresse;Adresse;Wohngebiet;Montag Ende;Dienstag Ende;Mittwoch Ende;Donnerstag Ende;Freitag Ende\nTest Kind;Testschule;Schulstraße 1, 12345 Teststadt;Testweg 2, 12345 Teststadt;Mitte;11:20;12:30;14:00;16:00;18:00\n';
  const r=await fetch(base+'/api/import/preview?format=csv',{method:'POST',headers:{Cookie:cookie},body:csv});assert.equal(r.status,200);const p=await r.json();assert.equal(p.students.length,1);assert.equal((await current()).students.length,36);
  assert.equal((await req('/import/commit','POST',{token:p.token,confirm:false})).status,400);assert.equal((await req('/import/commit','POST',{token:p.token,confirm:true})).status,200);
  const s=await current();assert.equal(s.demo,false);assert.equal(s.students.length,1);assert.equal(s.students[0].schedule[4].end,'18:00');assert.equal(s.tours.length,0);
  assert.equal((await req('/plan','POST',{date:'2026-10-12',direction:'return'})).status,200);assert.equal((await current()).tours.length,1);
});
test('Deaktivierte Fahrzeuge verlieren geplante Zuweisungen; inaktive Fahrerzugänge werden gesperrt',async()=>{
  const s=await current(),b=s.buses.find(b=>s.tours.some(t=>t.busId===b.id));assert.ok(b);
  assert.equal((await req('/buses/'+b.id,'PUT',{...b,active:false})).status,200);const next=await current();assert.ok(next.tours.every(t=>t.busId!==b.id));
  const d=next.drivers[0];assert.equal((await req('/drivers/'+d.id,'PUT',{...d,active:false})).status,200);assert.equal((await req('/state','GET',undefined,driverCookie)).status,401);
});
