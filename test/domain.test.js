import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeSeed,planTours,seats,wheels,eligible,reconcileStudent,assertAssignment,overlaps,validateSchedule,validDate} from '../domain.js';
const date='2026-10-12';
const seed=()=>makeSeed(randomUUID,date);

test('250 Schüler werden in eindeutige Touren mit höchstens acht Fahrgästen verteilt',()=>{
  const s=seed(), template=s.students[0];s.absences=[];s.students=Array.from({length:250},(_,i)=>({...structuredClone(template),id:randomUUID(),name:`Kind ${i}`,district:`Bezirk ${i%7}`}));
  const r=planTours(s,date,'return',randomUUID);
  assert.equal(r.planned,32);assert.equal(s.tours.flatMap(t=>t.studentIds).length,250);assert.equal(new Set(s.tours.flatMap(t=>t.studentIds)).size,250);
  assert.ok(s.tours.every(t=>seats(s,t.studentIds)<=8));assert.ok(r.unassigned>0);
});
test('Individuelle Unterrichtsenden und alle fünf Schultage bestimmen die Tourzeit',()=>{
  const s=seed();s.absences=[];s.students[0].schedule[0].end='11:20';s.students[1].schedule[0].end='18:00';
  for(let i=0;i<5;i++){const d=`2026-10-${12+i}`;planTours(s,d,'return',randomUUID);for(const t of s.tours.filter(t=>t.date===d))for(const id of t.studentIds)assert.equal(s.students.find(v=>v.id===id).schedule[i].end,t.time);}
});
test('Begleitpersonen und Rollstühle benötigen passende Kapazität',()=>{
  const s=seed();s.absences=[];s.students=s.students.slice(0,6);s.students.forEach(p=>{p.companion=true;p.wheelchair=true;});planTours(s,date,'return',randomUUID);
  assert.ok(s.tours.every(t=>seats(s,t.studentIds)<=8));assert.ok(s.tours.every(t=>wheels(s,t.studentIds)<=1));
  for(const t of s.tours.filter(t=>t.busId)){const b=s.buses.find(b=>b.id===t.busId);assert.ok(wheels(s,t.studentIds)<=b.wheelchairSpaces);}
});
test('Krankmeldungen entfernen Schüler unmittelbar und verhindern Neuplanung',()=>{
  const s=seed();s.absences=[];planTours(s,date,'return',randomUUID);const pupil=s.students[0];s.absences.push({studentId:pupil.id,from:date,to:date,direction:'return'});reconcileStudent(s,pupil.id);
  assert.ok(!s.tours.some(t=>t.studentIds.includes(pupil.id)));assert.ok(!eligible(s,date,'return').includes(pupil));assert.ok(eligible(s,date,'outbound').includes(pupil));
});
test('Ein Schüler an Bord kann nicht durch eine Krankmeldung aus der Fahrt gelöscht werden',()=>{
  const s=seed();s.absences=[];planTours(s,date,'return',randomUUID);const t=s.tours[0],id=t.studentIds[0];t.progress[id]='onboard';s.absences.push({studentId:id,from:date,to:date,direction:'both'});assert.throws(()=>reconcileStudent(s,id),/bereits an Bord/);
});
test('Begonnene Touren sind gegen automatische Neuplanung geschützt',()=>{
  const s=seed();planTours(s,date,'return',randomUUID);s.tours[0].progress[s.tours[0].studentIds[0]]='onboard';assert.throws(()=>planTours(s,date,'return',randomUUID),/begonnene Touren/);
});
test('Zuweisungen verhindern Fahrzeug- und Fahrerüberschneidungen',()=>{
  const s=seed();planTours(s,date,'return',randomUUID);const [a,b]=s.tours;assert.ok(overlaps(a,b));assert.throws(()=>assertAssignment(s,b,a.busId,a.driverId),/bereits eingeplant/);
});
test('Nicht geprüfte Daten, deaktivierte Hinfahrten und Wochenenden werden nicht geplant',()=>{
  const s=seed();s.absences=[];s.students[0].needsReview=true;s.students[1].outboundEnabled=false;
  assert.ok(!eligible(s,date,'return').includes(s.students[0]));assert.ok(!eligible(s,date,'outbound').includes(s.students[1]));assert.throws(()=>planTours(s,'2026-10-17','return',randomUUID),/Wochenende/);
});
test('Wochenpläne behalten individuelle Tageshaltestellen',()=>{
  const s=seed().students[0].schedule;s[0].returnAddress='Andere Haltestelle';assert.equal(validateSchedule(s)[0].returnAddress,'Andere Haltestelle');s[1].end='18:01';assert.throws(()=>validateSchedule(s),/11:20/);
});
test('Ungültige Datumswerte werden als Eingabefehler erkannt',()=>{
  assert.throws(()=>validDate('2026-02-30'),/gültiges Datum/);assert.throws(()=>validDate('2026-99-01'),/gültiges Datum/);
});
test('Morgendliche Abholzeiten werden für Reihenfolge und Fahrzeugbelegung übernommen',()=>{
  const s=seed();s.absences=[];s.students=s.students.slice(0,3);s.students[0].schedule[0].pickupTime='06:30';s.students[1].schedule[0].pickupTime='07:10';s.students[2].schedule[0].pickupTime='06:50';planTours(s,date,'outbound',randomUUID);
  assert.equal(s.tours[0].pickupStart,'06:30');assert.deepEqual(s.tours[0].studentIds,[s.students[0].id,s.students[2].id,s.students[1].id]);
});
test('Geänderter Begleitbedarf führt bei Überkapazität zu erneuter Tourenzuordnung',()=>{
  const s=seed();s.absences=[];const base=structuredClone(s.students[0]);s.students=Array.from({length:8},(_,i)=>({...structuredClone(base),id:randomUUID(),name:`Kind ${i}`}));planTours(s,date,'return',randomUUID);s.students[0].companion=true;reconcileStudent(s,s.students[0].id);assert.ok(s.tours.every(t=>seats(s,t.studentIds)<=8));assert.ok(!s.tours.some(t=>t.studentIds.includes(s.students[0].id)));
});
