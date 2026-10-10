"""Spreadsheet import/export. No personal data is written to logs or temporary files."""
import csv
import io
import json
import re
import sys
import zipfile
from datetime import datetime, time
from openpyxl import Workbook, load_workbook

DAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag']

def clean(value):
    if value is None:
        return ''
    if isinstance(value, time):
        return value.strftime('%H:%M')
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()

def normalize(value):
    return re.sub(r'[^a-z0-9äöüß]', '', clean(value).lower())

def time_value(value):
    if isinstance(value, time):
        return value.strftime('%H:%M')
    if isinstance(value, (float, int)) and 0 < value < 1:
        total = round(value * 24 * 60)
        return f'{total // 60:02d}:{total % 60:02d}'
    match = re.fullmatch(r'(\d{1,2})[:.](\d{2})(?:\s*(?:Uhr|uhr))?', clean(value))
    if match and int(match[1]) < 24 and int(match[2]) < 60:
        return f'{int(match[1]):02d}:{int(match[2]):02d}'
    return None

def is_end(value):
    return value is not None and '11:20' <= value <= '18:00'

def address(street, postal, town):
    return ', '.join(v for v in [clean(street), ' '.join(v for v in [clean(postal),clean(town)] if v)] if v)

def safe_cell(value):
    value = clean(value)
    # Prevent spreadsheet formula injection on files opened outside this application.
    return "'" + value if value.startswith(('=', '+', '-', '@')) else value

def imported_record(name, addr, district, contact, notes, schoolkey, endings, stops=None, source=None, pickup=''):
    warnings=[]
    schedule=[]
    for d,value in enumerate(endings):
        parsed=time_value(value)
        enabled=is_end(parsed)
        raw=clean(value)
        if not enabled and raw not in ['', '-', '–', 'x', 'X', 'nein', 'Nein', 'keine', 'Keine']:
            warnings.append(f'{DAYS[d]}: Zeit „{raw}“ prüfen.')
        morning=time_value(pickup)
        schedule.append({'enabled':enabled,'start':'08:00','end':parsed if enabled else '13:00','pickupTime':morning if morning and '05:00'<=morning<'08:00' else '', 'pickupAddress':'','sourceTime':raw,'returnAddress':clean((stops or ['']*5)[d])})
    if not addr: warnings.append('Wohnadresse fehlt.')
    if not any(s['enabled'] for s in schedule):warnings.append('Keine eindeutigen Rückfahrzeiten erkannt.')
    return {'name':name,'address':addr,'district':district or 'Nicht zugeordnet','contact':contact,'notes':notes,'schoolKey':schoolkey,'schedule':schedule,'wheelchair':False,'companion':False,'active':True,'outboundEnabled':False,'needsReview':bool(warnings),'importWarnings':warnings,'source':source or {},'morningPickup':clean(pickup)}

def preview_workbook(data, selection):
    # A compressed file must not inflate beyond a bounded size.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(z.file_size for z in archive.infolist()) > 50*1024*1024:
            raise ValueError('Uncompressed workbook too large')
    book=load_workbook(io.BytesIO(data),read_only=True,data_only=True)
    template=next((s for s in book.worksheets if s.title=='Schüler'),None)
    if template and clean(next(template.iter_rows(values_only=True))[0])=='Name':
        schools_sheet=next((s for s in book.worksheets if s.title=='Schulen'),None)
        schools=[{'key':clean(r[0]),'name':clean(r[0]),'address':clean(r[1])} for r in schools_sheet.iter_rows(min_row=2,values_only=True) if r[0]] if schools_sheet else []
        records=[dict(zip([clean(h) for h in next(template.iter_rows(values_only=True))],r)) for r in template.iter_rows(min_row=2,values_only=True) if r[0]]
        return preview_template(records,schools)
    student_sheets=[]
    for index,sheet in enumerate(book.worksheets):
        header=next(sheet.iter_rows(min_row=3,max_row=3,values_only=True),())
        if len(header)>36 and normalize(header[2])=='nachname' and normalize(header[3])=='vorname':student_sheets.append((index,sheet))
    if not student_sheets:raise ValueError('Unsupported workbook')
    selected=student_sheets if selection==50 else [(i,s) for i,s in student_sheets if i==selection]
    if not selected:raise ValueError('Not a student sheet')
    schools=[]
    lookup={}
    for sheet in book.worksheets:
        header=next(sheet.iter_rows(max_row=1,values_only=True),())
        if len(header)>4 and normalize(header[1])=='name' and normalize(header[2]) in ['straße','strasse']:
            for row in sheet.iter_rows(min_row=2,values_only=True):
                if not row[1] or not row[2] or not row[4]:continue
                key=clean(row[1]); school={'key':key,'name':key,'address':address(row[2],row[3],row[4]),'code':clean(row[0])}
                schools.append(school)
                lookup[normalize(row[1])]=key
                lookup[normalize(clean(row[1]).split('(')[0])]=key
                if row[0] and not time_value(row[0]):lookup[normalize(row[0])]=key
    students=[]
    missing=set()
    for index,sheet in selected:
        for n,row in enumerate(sheet.iter_rows(min_row=4,values_only=True),4):
            if len(row)<38 or not row[2] or not row[3]:continue
            schoolcode=clean(row[1]);key=lookup.get(normalize(schoolcode),schoolcode or 'Schule ungeklärt')
            if not any(s['key']==key for s in schools):
                schools.append({'key':key,'name':key,'address':''});missing.add(key)
            stops=[clean(row[c]) for c in [17,22,27,32,37]]
            stops=['' if normalize(v) in ['adresse',''] else v for v in stops]
            pupil=imported_record(f'{clean(row[3])} {clean(row[2])}',address(row[4],row[5],row[6]),clean(row[6]),clean(row[7]),clean(row[38]) if len(row)>38 else '',key,[row[c] for c in [16,21,26,31,36]],stops,{'sheet':index+1,'row':n,'schoolCode':schoolcode},row[11])
            morning_stop=clean(row[12])
            if normalize(morning_stop) not in ['', 'adresse']:
                for day in pupil['schedule']:day['pickupAddress']=morning_stop
                pupil['importWarnings'].append('Abweichende Morgenhaltestelle vorhanden. Vor Freigabe prüfen.')
                pupil['needsReview']=True
            if key in missing:
                pupil['importWarnings'].append('Schule nicht eindeutig im Schulverzeichnis zugeordnet. Schuladresse prüfen.')
                pupil['needsReview']=True
            if any(stops):
                pupil['importWarnings'].append('Abweichende Tageshaltestellen vorhanden. Im Wochenplan vor Freigabe prüfen.')
                pupil['needsReview']=True
            students.append(pupil)
    return summarize(students,schools,[{'index':i,'label':f'Schülerblatt {i+1}'} for i,_ in student_sheets])

def preview_template(records,schools=None):
    schools=schools or []
    students=[]
    for n,row in enumerate(records,2):
        name=clean(row.get('Name'));school=clean(row.get('Schule'))
        if not name:continue
        if not school:school='Schule ungeklärt'
        if not any(s['key']==school for s in schools):schools.append({'key':school,'name':school,'address':clean(row.get('Schuladresse'))})
        record=imported_record(name,clean(row.get('Adresse')),clean(row.get('Wohngebiet')),clean(row.get('Kontakt')),clean(row.get('Hinweise')),school,[row.get(d+' Ende','') for d in DAYS],[row.get(d+' Haltestelle','') for d in DAYS],{'row':n},row.get('Morgen Abholung',''))
        for i,d in enumerate(DAYS):
            start=time_value(row.get(d+' Beginn'))
            if start and '06:00'<=start<='11:00':record['schedule'][i]['start']=start
            pickup=time_value(row.get(d+' Abholung'))
            if pickup and '05:00'<=pickup<record['schedule'][i]['start']:record['schedule'][i]['pickupTime']=pickup
            record['schedule'][i]['pickupAddress']=clean(row.get(d+' Morgenhaltestelle'))
        record['wheelchair']=normalize(row.get('Rollstuhl')) in ['ja','true','1']
        record['companion']=normalize(row.get('Begleitperson')) in ['ja','true','1']
        record['outboundEnabled']=normalize(row.get('Hinfahrt')) in ['ja','true','1']
        record['active']=normalize(row.get('Aktiv','ja')) not in ['nein','false','0']
        if normalize(row.get('Prüfbedarf')) in ['ja','true','1']:record['needsReview']=True;record['importWarnings'].append('Prüfbedarf aus Export übernommen.')
        if not any(s['key']==school and s['address'] for s in schools):record['needsReview']=True;record['importWarnings'].append('Schuladresse fehlt.')
        students.append(record)
    return summarize(students,schools,[])

def summarize(students,schools,sheets):
    directory=list({s['key']:s for s in schools if s['address']}.values())
    seen={};duplicates=[]
    for pupil in students:
        key=normalize(pupil['name'])+'|'+normalize(pupil['address'])
        if key in seen:
            duplicates.append({'first':seen[key]['source'],'second':pupil['source']})
            # Different schedules cannot silently overwrite the first record.
            if pupil['schedule']!=seen[key]['schedule'] or pupil['schoolKey']!=seen[key]['schoolKey']:
                seen[key]['needsReview']=True;seen[key]['importWarnings'].append('Abweichende Dublette in weiterem Tabellenblatt. Beide Quellzeilen prüfen.')
        else:seen[key]=pupil
    students=list(seen.values())
    used={s['schoolKey'] for s in students}
    schools=[s for s in schools if s['key'] in used]
    review=sum(bool(s['needsReview']) for s in students)
    warnings=['Morgen-Abholzeiten werden separat übernommen. Hinfahrten sind bis zur Prüfung des Schulbeginns deaktiviert.','Rollstuhl- und Begleitbedarf werden nicht aus Freitext erraten; bitte je Schüler prüfen.']
    if duplicates:warnings.append(f'{len(duplicates)} Dubletten zusammengeführt; bei abweichenden Angaben bleibt die erste Zeile zur Prüfung gesperrt.')
    if review:warnings.append(f'{review} Schüler benötigen Prüfung und werden noch nicht automatisch disponiert.')
    return {'type':'students','students':students,'schools':schools,'schoolDirectory':directory,'warnings':warnings,'duplicates':duplicates,'sheets':sheets,'reviewCount':review}

def export_tables(state):
    schools={s['id']:s for s in state['schools']}
    pupils={s['id']:s for s in state['students']}
    buses={s['id']:s for s in state['buses']}
    drivers={s['id']:s for s in state['drivers']}
    header=['Name','Schule','Schuladresse','Adresse','Wohngebiet','Kontakt','Hinweise','Rollstuhl','Begleitperson','Hinfahrt','Morgen Abholung','Prüfbedarf','Aktiv']
    for d in DAYS:header.extend([d+' Beginn',d+' Ende',d+' Haltestelle',d+' Abholung',d+' Morgenhaltestelle'])
    rows=[]
    for s in state['students']:
        school=schools.get(s['schoolId'],{})
        row=[s['name'],school.get('name',''),school.get('address',''),s['address'],s['district'],s.get('contact',''),s.get('notes',''),'ja' if s.get('wheelchair') else 'nein','ja' if s.get('companion') else 'nein','ja' if s.get('outboundEnabled',True) else 'nein',s.get('morningPickup',''),'ja' if s.get('needsReview') else 'nein','ja' if s.get('active',True) else 'nein']
        for day in s['schedule']:row.extend([day['start'],day['end'] if day['enabled'] else '',day.get('returnAddress',''),day.get('pickupTime',''),day.get('pickupAddress','')])
        rows.append(row)
    tours=[]
    for t in state['tours']:
        for pid in t['studentIds']:
            tours.append([t['id'],t['date'],'Rückfahrt' if t['direction']=='return' else 'Hinfahrt',t['time'],schools.get(t['schoolId'],{}).get('name',''),buses.get(t['busId'],{}).get('name',''),drivers.get(t['driverId'],{}).get('name',''),pupils.get(pid,{}).get('name',''),t['progress'].get(pid,'waiting')])
    return {'Schüler':[header,*rows], 'Schulen':[['Name','Adresse'],*[[s['name'],s['address']] for s in state['schools']]],'Abwesenheiten':[['Schüler','Von','Bis','Richtung','Grund'],*[[pupils.get(a['studentId'],{}).get('name',''),a['from'],a['to'],a['direction'],a['reason']] for a in state['absences']]],'Touren':[['Tour-ID','Datum','Richtung','Zeit','Schule','Fahrzeug','Fahrer','Schüler','Status'],*tours],'Fahrzeuge':[['Name','Kennzeichen','Fahrgastplätze','Rollstuhlplätze'],*[[b['name'],b['plate'],b['capacity'],b['wheelchairSpaces']] for b in state['buses']]],'Fahrer':[['Name','Benutzername'],*[[d['name'],d['username']] for d in state['drivers']]]}

def main():
    action,fmt=sys.argv[1:3]
    data=sys.stdin.buffer.read(8*1024*1024+1)
    if len(data)>8*1024*1024:raise ValueError('Input limit')
    if action=='preview':
        if fmt=='xlsx':result=preview_workbook(data,int(sys.argv[3]))
        else:
            value=data.decode('utf-8-sig');dialect=csv.Sniffer().sniff(value[:4096],delimiters=';,\t')
            result=preview_template(list(csv.DictReader(io.StringIO(value),dialect=dialect)))
        sys.stdout.write(json.dumps(result,ensure_ascii=False))
    else:
        tables=export_tables(json.loads(data))
        if fmt=='csv':
            output=io.StringIO();writer=csv.writer(output,delimiter=';');writer.writerows([[safe_cell(v) for v in row] for row in tables['Schüler']]);sys.stdout.buffer.write(('\ufeff'+output.getvalue()).encode())
        else:
            from openpyxl.styles import Font, PatternFill, Alignment
            book=Workbook();book.remove(book.active)
            for title,rows in tables.items():
                sheet=book.create_sheet(title)
                for row in rows:sheet.append([safe_cell(v) for v in row])
                sheet.freeze_panes='A2';sheet.auto_filter.ref=sheet.dimensions
                for cell in sheet[1]:cell.font=Font(color='FFFFFF',bold=True);cell.fill=PatternFill('solid',fgColor='172C31')
                for column in sheet.columns:sheet.column_dimensions[column[0].column_letter].width=min(45,max(16,len(str(column[0].value))+3))
            output=io.BytesIO();book.save(output);sys.stdout.buffer.write(output.getvalue())

if __name__=='__main__':main()
