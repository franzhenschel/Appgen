# Schulweg

Web-App zur Disposition des freigestellten Schülerverkehrs: bis zu 250 Schüler, fünf individuelle Tagespläne, Hin- und Rückfahrten, Krankmeldungen und Kleinbusse mit höchstens acht Fahrgästen. Die Oberfläche ist auf Deutsch und passt sich an Smartphones an.

Für einen Start auf dem eigenen Rechner siehe [START-HIER.md](START-HIER.md). Vorschaubilder mit fiktiven Daten: [Disposition](docs/disposition.png) und [Fahreransicht](docs/fahrer.png).

## Start

Voraussetzungen: Node.js 24 oder neuer und Python 3.12 mit `venv`.

```bash
cd /workspace/Appgen
python -m venv --system-site-packages .venv
.venv/bin/python -m pip install --no-cache-dir -r requirements.txt
npm ci --cache /tmp/schulweg-npm-cache --no-audit --no-fund
npm start
```

Die Anwendung läuft standardmäßig auf Port 3000. Das Fahrerportal verwendet den Pfad `/fahrer`. `npm run dev` startet mit automatischem Server-Neustart bei Änderungen. Es gibt keine externen JavaScript-Laufzeitabhängigkeiten und keinen zusätzlichen Build-Schritt.

Beim ersten Start werden **36 fiktive Schüler**, sechs Schulen, sechs Fahrer und sechs Fahrzeuge angelegt. Die initialen Rückfahrten liegen am nächsten regulären Schultag. Demo-Zugang: `admin` / `Schulweg-Demo!`, Fahrer: `fahrer1` bis `fahrer6` / `Fahrer-Demo!`.

## Arbeitsablauf

1. Schulen mit vollständigen Adressen anlegen oder importieren.
2. Schüler mit Wohnadresse, Kontakt, Hinweisen, Rollstuhl- und Begleitbedarf pflegen.
3. Pro Schultag Abholzeit morgens, Schulbeginn, Rückfahrtzeit und abweichende Morgen- oder Rückfahrthaltestelle hinterlegen. Rückfahrten unterstützen 11:20 bis 18:00 Uhr. Einzelne Tage und Hinfahrten können deaktiviert werden.
4. Planungsdatum und Fahrtrichtung wählen, dann **Touren zusammenstellen**. Die App gruppiert gleiche Schulen und Zeiten und sortiert nach Wohngebiet. Begleitpersonen zählen gegen die Grenze von acht Fahrgästen. Rollstuhlplätze und geschätzte Belegungszeitfenster einschließlich zehn Minuten Puffer werden geprüft.
5. Tourdetails öffnen, Fahrzeug/Fahrer zuweisen und passende Schüler zwischen Touren verschieben. Unter **Tourenplanung → Eigene Tour** lassen sich Touren mit ausgewählten Schülern selbst anlegen oder aufteilen. Bei fehlenden Fahrzeugen oder Fahrern bleiben Touren sichtbar als offene Zuweisung.
6. Krankmeldungen tageweise oder als Zeitraum für eine oder beide Richtungen erfassen. Wartende Fahrgäste werden unmittelbar aus Touren entfernt. Änderungen eines bereits eingestiegenen Kindes werden abgelehnt. Nach Rücknahme einer Abwesenheit ist eine neue Tourenzuordnung nötig.
7. Fahrer melden sich mit ihrem eigenen Benutzernamen an und sehen ausschließlich eigene Touren. Datenabgleich erfolgt alle fünf Sekunden bei aktiver Verbindung. Fahrgaststatus: wartet, an Bord, angekommen oder nicht erschienen. Google Maps öffnet die nächsten bis zu vier Halte; nach dem Halt die Navigation neu starten.

Die Tourenplanung ist eine **Dispositionshilfe ohne Berechnung realer Straßenfahrzeiten oder globale Routenoptimierung**. Wohngebiete, feste Abholzeiten und geschätzte Zeitfenster ersetzen keine Prüfung der Fahrzeiten vor dem Einsatz. Die externe Navigation berücksichtigt die Straßenführung. Es gibt kein GPS-Tracking oder Offline-Synchronisierung.

## Import und Export

Unter **Import & Export** sind Excel (`.xlsx`), CSV und JSON verfügbar. Maximale Uploadgröße: 8 MB. Vor jeder Übernahme erscheinen Vorschau, Hinweise und offene Schulzuordnungen. Schüler mit ungeklärten Angaben bleiben von automatischer Planung ausgeschlossen, bis die Disposition den Wochenplan geprüft und freigegeben hat.

Die bereitgestellte Datei „Übersicht gesamt aller Schüler_ab 15.09.2026.xlsx“ wird unterstützt:

- Beide Schülerblätter werden eingelesen. Leere Zeilen werden ausgelassen, gleiche Namen und Wohnadressen auf Dubletten geprüft. Abweichende Dubletten werden zur Prüfung gesperrt.
- Spalte L enthält die morgendliche Abholung. Q, V, AA, AF und AK enthalten die Rückfahrt ab Schule. M und die Haltestellenspalten in den Tagesblöcken werden erhalten.
- Das Schulverzeichnis liefert Adressen. Eindeutige Namen einschließlich Varianten ohne erläuternde Klammern werden zugeordnet. Ungeklärte Kennungen lassen sich in der Vorschau manuell verbinden.
- Unlesbare Zeiten werden erhalten und markiert. Die App erfindet daraus keine Fahrten. Hinfahrten bleiben nach diesem Import deaktiviert, bis Schulbeginn und Morgenhaltestellen geprüft wurden.
- Rollstuhl- und Begleitbedarf müssen ausdrücklich gepflegt werden; Freitext wird nicht als sichere Bedarfsermittlung verwendet.

Der **Excel-Export** enthält Schüler samt fünf Wochenplänen, Schulen, Abwesenheiten, Touren, Fahrzeuge und Fahrer. Ein erneuter Excel-/CSV-Import übernimmt Schüler und Wochenpläne; **nur JSON** stellt alle Daten samt Zuordnungen wieder her. CSV verwendet Semikolon und UTF-8 mit BOM. Excel- und CSV-Ausgabe schützt Text vor Formel-Injektion.

Beim ersten Echtdatenimport werden Demo-Schüler, -Schulen, -Abwesenheiten und -Touren ersetzt. Fahrzeuge und Fahrer bleiben erhalten und müssen auf den tatsächlichen Betrieb angepasst werden. Spätere Schülerimporte gleichen anhand von Name und Wohnadresse ab; geänderte Adressen sind als mögliche neue Datensätze zu prüfen. Ein JSON-Backup ersetzt nach Bestätigung alle aktuellen fachlichen Daten. Zugangspasswörter sind nicht Bestandteil des Exports.

## Zugang und Speicherung

Vor dem Speichern von Echtdaten unter **Import & Export → Zugänge einrichten** eigene, unterschiedliche Passwörter mit mindestens zwölf Zeichen setzen. Die App speichert gesalzene Scrypt-Hashes und deaktiviert Demo-Anmeldung. Fahrer verwenden eigene Benutzernamen mit einem **gemeinsamen Fahrerpasswort**; individuelle Fahrerpasswörter sind in dieser ersten Version noch nicht enthalten.

Alternativ können vor dem ersten Start `ADMIN_PASSWORD` und `DRIVER_PASSWORD` gesetzt werden. Bereits über die Oberfläche gespeicherte Passwörter haben Vorrang. `PORT`, `HOST`, `DATA_DIR`, `PYTHON_BIN` und `COOKIE_SECURE=true` konfigurieren den Betrieb. `DATA_DIR` enthält SQLite-Datenbank, lokale Zugangshashes und optional eine private `import-source.xlsx`. Diese Dateien sind von Git ausgeschlossen. Eine vorliegende Importquelle ist erst nach Einrichtung eigener Passwörter abrufbar.

Sitzungen verwenden HttpOnly- und SameSite-Cookies, zwölf Stunden Gültigkeit, Schreibzugriff prüft den Ursprung und die Datenrevision. Parallele Änderungen erzeugen einen Konflikthinweis statt unbemerktem Überschreiben. SQLite-Änderungen werden atomar gespeichert.

Für einen echten Mehrbenutzerbetrieb sind ein HTTPS-Zugang, geregelte Berechtigungen, eigene Fahrerpasswörter, Datensicherung und die betriebliche Freigabe noch erforderlich. Die laufende Cloud-Instanz und ein gespeicherter Konfigurationsentwurf sind kein veröffentlichtes Produktionssystem. Lokale Dateispeicherung erfolgt unverschlüsselt; Zugriff und Backups entsprechend schützen.

## Prüfungen

```bash
npm run check
npm test
npm run test:ui
```

Die Tests prüfen unter anderem 250 Schüler, individuelle Tageszeiten, Rollstuhl- und Begleitkapazität, Konflikte, Krankmeldungen, Fahrerberechtigungen, Excel-Rückimport und bestätigten CSV-Import. API-Tests nutzen eigene temporäre Datenbanken und verändern die laufenden App-Daten nicht.

Der Browsertest benötigt Chromium. In dieser Cloud-Umgebung ist Chromium vorhanden; auf anderen Rechnern einmalig `npx playwright install chromium` ausführen. Der Browsertest erzeugt eine fiktive Excel-Datei und prüft Desktop, mobile Fahreransicht, Krankmeldung, Datenabgleich, Fahrgaststatus, Formularspeicherung, Passworteinrichtung und bestätigten Import. Temporäre Datenbanken und Dateien werden nach Abschluss entfernt.

## Cloud-Umgebung

Den bestehenden Checkout `/workspace/Appgen` verwenden. Cloud-Aufgaben sind bereits isoliert; keinen zusätzlichen Git-Worktree anlegen. Abhängigkeiten und Datenbank bleiben auf dem Dateisystem erhalten. Der Serverprozess muss nach einem Neustart der Umgebung neu gestartet werden. Starten und anschließend Anmeldung, API-Daten und Fahrerportal prüfen. Die wiederverwendbaren Installations- und Startanweisungen sind als Cloud-Konfigurationsentwurf gespeichert; Veröffentlichung erfolgt separat über die Umgebungseinstellungen.

Die Cloud-Einrichtung stellt keinen Web-Vorschauzugang für den internen App-Port bereit. Ein laufender Server ist deshalb vom eigenen Computer aus nicht automatisch erreichbar. Die Veröffentlichung der Entwicklungsumgebung speichert deren Konfiguration und Dateisystem; sie veröffentlicht die App nicht als Website. Eine interaktive Nutzung erfordert einen lokalen Start auf dem eigenen Rechner oder eine gesonderte Bereitstellung mit einer erreichbaren Adresse.
