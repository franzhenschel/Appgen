export const DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
export function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(value+'T12:00:00Z').getTime()) || new Date(value + 'T12:00:00Z').toISOString().slice(0,10) !== value) fail('Bitte ein gültiges Datum angeben.');
  return value;
}
export function weekday(date) { validDate(date); return (new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7; }
export function minutes(time) { if (typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail('Ungültige Uhrzeit.'); return Number(time.slice(0,2))*60 + Number(time.slice(3)); }
export function clock(value) { return `${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`; }
export function text(value, label, max=150) { if (typeof value !== 'string' || !value.trim() || value.trim().length>max) fail(`${label}: Bitte 1 bis ${max} Zeichen eingeben.`); return value.trim(); }
export function validateSchedule(schedule) {
  if (!Array.isArray(schedule) || schedule.length !== 5) fail('Für alle fünf Schultage Zeiten angeben.');
  return schedule.map(s => {
    if (!s || typeof s.enabled !== 'boolean') fail('Ungültiger Wochenplan.');
    const start=minutes(s.start), end=minutes(s.end);
    if(start < 360 || start > 660 || end < 680 || end > 1080 || end <= start) fail('Schulbeginn: 06:00–11:00. Unterrichtsende: 11:20–18:00.');
    if(s.pickupTime && (minutes(s.pickupTime)<300 || minutes(s.pickupTime)>=start))fail('Morgen-Abholung muss zwischen 05:00 Uhr und dem Schulbeginn liegen.');
    return {enabled:s.enabled,start:s.start,end:s.end,pickupTime:s.pickupTime||'',pickupAddress:typeof s.pickupAddress==='string'?s.pickupAddress.trim().slice(0,240):'',returnAddress:typeof s.returnAddress==='string'?s.returnAddress.trim().slice(0,240):'',sourceTime:typeof s.sourceTime==='string'?s.sourceTime.slice(0,150):''};
  });
}
export function isAbsent(state, studentId, date, direction) { return state.absences.some(a=>a.studentId===studentId && a.from<=date && a.to>=date && (a.direction==='both'||a.direction===direction)); }
export function seats(state, ids) { return ids.reduce((n,id)=>n+(state.students.find(s=>s.id===id)?.companion?2:1),0); }
export function wheels(state, ids) { return ids.filter(id=>state.students.find(s=>s.id===id)?.wheelchair).length; }
export function eligible(state, date, direction) {
  if(!['outbound','return'].includes(direction)) fail('Ungültige Fahrtrichtung.');
  const day=weekday(date); if(day>4) return [];
  return state.students.filter(s=>s.active && !s.needsReview && s.schedule[day].enabled && (direction!=='outbound'||s.outboundEnabled!==false) && state.schools.find(v=>v.id===s.schoolId)?.address && !isAbsent(state,s.id,date,direction));
}
export function endOfTour(tour) { return minutes(tour.time) + (tour.direction==='return'? 15 + tour.studentIds.length*5 : 10); }
export function startOfTour(tour) { return tour.direction==='outbound'&&tour.pickupStart?minutes(tour.pickupStart):minutes(tour.time) - (tour.direction==='outbound'?15 + tour.studentIds.length*5:0); }
export function updateTourTiming(state,tour) {
  if(tour.direction!=='outbound'||!tour.studentIds.length)return;
  const day=weekday(tour.date),fallback=minutes(tour.time)-15-tour.studentIds.length*5;
  const pickup=id=>state.students.find(s=>s.id===id)?.schedule[day]?.pickupTime;
  tour.studentIds.sort((a,b)=>(pickup(a)?minutes(pickup(a)):fallback)-(pickup(b)?minutes(pickup(b)):fallback));
  tour.pickupStart=clock(Math.min(...tour.studentIds.map(id=>pickup(id)?minutes(pickup(id)):fallback)));
}
export function overlaps(a,b) { return a.date===b.date && startOfTour(a)<endOfTour(b)+10 && startOfTour(b)<endOfTour(a)+10; }
export function assertAssignment(state, tour, busId, driverId) {
  const bus=state.buses.find(b=>b.id===busId&&b.active), driver=state.drivers.find(d=>d.id===driverId&&d.active);
  if(!bus || !driver) fail('Aktives Fahrzeug und aktiven Fahrer wählen.');
  if(bus.capacity<seats(state,tour.studentIds) || bus.wheelchairSpaces<wheels(state,tour.studentIds)) fail('Das Fahrzeug hat nicht genügend Fahrgast- oder Rollstuhlplätze.');
  if(state.tours.some(t=>t.id!==tour.id&&t.date===tour.date&&(t.busId===busId||t.driverId===driverId)&&overlaps(t,tour))) fail('Fahrzeug oder Fahrer ist im geschätzten Zeitfenster bereits eingeplant (inkl. 10 Minuten Puffer).');
}
export function planTours(state, date, direction, id) {
  if(weekday(date)>4) fail('Am Wochenende findet kein regulärer Schülerverkehr statt.');
  const existing=state.tours.filter(t=>t.date===date&&t.direction===direction);
  if(existing.some(t=>Object.values(t.progress).some(p=>p!=='waiting'))) fail('Bereits begonnene Touren können nicht neu zusammengestellt werden.');
  const day=weekday(date), groups=new Map();
  for(const s of eligible(state,date,direction)) {
    const time=direction==='outbound'?s.schedule[day].start:s.schedule[day].end;
    const key=`${s.schoolId}|${time}`;
    if(!groups.has(key)) groups.set(key,[]);
    groups.get(key).push(s);
  }
  state.tours=state.tours.filter(t=>!(t.date===date&&t.direction===direction));
  const batches=[];
  for(const group of groups.values()) {
    group.sort((a,b)=>Number(b.wheelchair)-Number(a.wheelchair)||a.district.localeCompare(b.district,'de')||a.address.localeCompare(b.address,'de'));
    const largest=Math.max(1,...state.buses.filter(b=>b.active).map(b=>b.capacity));
    const maxWheels=Math.max(1,...state.buses.filter(b=>b.active).map(b=>b.wheelchairSpaces));
    const chunks=[]; let chunk=[];
    for(const child of group) {
      if(chunk.length&&(seats(state,chunk.map(s=>s.id))+(child.companion?2:1)>largest || wheels(state,chunk.map(s=>s.id))+(child.wheelchair?1:0)>maxWheels)) {chunks.push(chunk);chunk=[];}
      chunk.push(child);
    }
    if(chunk.length) chunks.push(chunk);
    for(const children of chunks) {
      if(direction==='outbound')children.sort((a,b)=>(a.schedule[day].pickupTime||'00:00').localeCompare(b.schedule[day].pickupTime||'00:00'));
      batches.push({id:id(),date,direction,time:direction==='outbound'?children[0].schedule[day].start:children[0].schedule[day].end,schoolId:children[0].schoolId,studentIds:children.map(s=>s.id),busId:null,driverId:null,progress:Object.fromEntries(children.map(s=>[s.id,'waiting']))});
      updateTourTiming(state,batches.at(-1));
    }
  }
  batches.sort((a,b)=>startOfTour(a)-startOfTour(b));
  for(const t of batches) {
    for(const bus of state.buses.filter(b=>b.active&&b.capacity>=seats(state,t.studentIds)&&b.wheelchairSpaces>=wheels(state,t.studentIds))) {
      const driver=state.drivers.find(d=>d.active&&!state.tours.some(old=>old.driverId===d.id&&overlaps(old,t)));
      if(driver&&!state.tours.some(old=>old.busId===bus.id&&overlaps(old,t))) {t.busId=bus.id;t.driverId=driver.id;break;}
    }
    state.tours.push(t);
  }
  return {planned:batches.length,unassigned:batches.filter(t=>!t.busId).length};
}
export function reconcileStudent(state, studentId) {
  const student=state.students.find(s=>s.id===studentId);
  for(const t of state.tours.filter(t=>t.studentIds.includes(studentId))) {
    if(Object.values(t.progress).every(p=>p==='done'||p==='skipped'))continue;
    const day=weekday(t.date), bus=state.buses.find(b=>b.id===t.busId), correct=student&&student.active&&!student.needsReview&&day<5&&student.schedule[day].enabled&&(t.direction!=='outbound'||student.outboundEnabled!==false)&&student.schoolId===t.schoolId&&(t.direction==='return'?student.schedule[day].end:student.schedule[day].start)===t.time&&seats(state,t.studentIds)<=8&&(!bus||(seats(state,t.studentIds)<=bus.capacity&&wheels(state,t.studentIds)<=bus.wheelchairSpaces));
    if(!correct || isAbsent(state,studentId,t.date,t.direction)) {
      if(t.progress[studentId]==='onboard') fail('Das Kind ist bereits an Bord. Zuerst mit dem Fahrer klären und den Fahrgaststatus aktualisieren.');
      if(t.progress[studentId]==='done') continue;
      t.studentIds=t.studentIds.filter(s=>s!==studentId); delete t.progress[studentId];
    }
    updateTourTiming(state,t);
    if(t.studentIds.length&&t.busId&&t.driverId){try{assertAssignment(state,t,t.busId,t.driverId);}catch{t.busId=null;t.driverId=null;}}
  }
  state.tours=state.tours.filter(t=>t.studentIds.length);
}
export function makeSeed(id, date) {
  const schools=[['Grundschule Nord','Schulstraße 12, 30167 Hannover'],['IGS Linden','Am Lindener Berge 11, 30449 Hannover'],['Förderschule Mitte','Birkenstraße 8, 30161 Hannover'],['Grundschule Südstadt','Böhmerstraße 10, 30173 Hannover'],['Realschule List','Podbielskistraße 30, 30163 Hannover'],['Gymnasium West','Fössestraße 40, 30451 Hannover']].map(([name,address])=>({id:id(),name,address}));
  const drivers=['Martin Weber','Sarah Becker','Thomas Krüger','Julia Hartmann','Andreas Wolf','Nina Fischer'].map((name,i)=>({id:id(),name,active:true,username:`fahrer${i+1}`}));
  const buses=drivers.map((d,i)=>({id:id(),name:`Bus ${String(i+1).padStart(2,'0')}`,plate:`H · SV ${201+i}`,capacity:8,wheelchairSpaces:i<2?1:0,active:true}));
  const first=['Emma','Noah','Mia','Leon','Hannah','Finn','Lina','Paul','Luca','Emil','Ben','Clara','Ella','Jonas','Marie','Theo','Ida','Luis','Lea','Felix','Leni','Anton','Sophie','Max','Mila','Henry','Nele','Oskar','Anna','David','Lara','Jona','Amelie','Tom','Mathilda','Karl'];
  const last=['Müller','Schmidt','Schneider','Fischer','Weber','Meyer','Wagner','Becker','Hoffmann','Schulz','Koch','Richter'];
  const streets=[['Nordstadt','Engelbosteler Damm'],['Linden','Limmerstraße'],['List','Jakobistraße'],['Südstadt','Hildesheimer Straße'],['Ricklingen','Ricklinger Stadtweg'],['Vahrenwald','Vahrenwalder Straße']];
  const students=first.map((name,i)=>({id:id(),name:`${name} ${last[i%last.length]}`,schoolId:schools[Math.floor(i/6)].id,address:`${streets[Math.floor(i/6)][1]} ${20+i}, ${[30167,30451,30163,30173,30459,30165][Math.floor(i/6)]} Hannover`,district:streets[Math.floor(i/6)][0],contact:'',wheelchair:i===4,companion:i===4,notes:i===4?'Bitte an der Haustür abholen.':i===12?'Übergabe nur an die hinterlegte Bezugsperson.':'',active:true,schedule:DAYS.map((_,d)=>({enabled:true,start:'08:00',end:d===2?'15:30':d===4?'11:20': ['13:10','13:10','14:00','14:00','16:00','18:00'][Math.floor(i/6)]}))}));
  return {revision:1,demo:true,schools,drivers,buses,students,absences:[{id:id(),studentId:students[2].id,from:date,to:date,reason:'Krankmeldung',direction:'both'},{id:id(),studentId:students[8].id,from:date,to:date,reason:'Krankmeldung',direction:'both'}],tours:[]};
}
