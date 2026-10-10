# Schulweg lokal öffnen

Dieses Paket enthält die Anwendung und ausschließlich fiktive Beispieldaten. Die hochgeladene Schülerdatei, Datenbanken und gespeicherte Zugänge sind nicht enthalten.

Voraussetzungen: Node.js 24 oder neuer und Python 3.12 oder neuer. Das ZIP zuerst vollständig entpacken. Die folgenden Befehle in einem Terminal im entpackten Projektordner ausführen, in dem die Datei `package.json` liegt.

## Windows (PowerShell)

    py -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
    npm ci
    $env:PYTHON_BIN = (Resolve-Path .\.venv\Scripts\python.exe).Path
    npm start

## macOS / Linux

    python3 -m venv .venv
    .venv/bin/python -m pip install -r requirements.txt
    npm ci
    npm start

## Anwendung ansehen

Nach der Meldung „Schulweg gestartet auf Port 3000“ im Browser auf deinem eigenen Rechner die Adresse localhost:3000 eingeben. Über „Demo öffnen“ zur Verwaltung wechseln. Für die Fahreransicht lautet der Pfad /fahrer.

Das Terminal während der Nutzung geöffnet lassen. Mit Strg+C beenden; gespeicherte Daten bleiben für den nächsten Start erhalten. Vor einem Echtdatenimport eigene Zugangspasswörter in der App einrichten. Weitere Hinweise stehen in README.md.

## Vorschaubilder

Die PNG-Dateien im Ordner `docs` lassen sich direkt öffnen und zeigen ausschließlich Demodaten:

- [Disposition](docs/disposition.png)
- [Fahreransicht](docs/fahrer.png)

Dies ist ein Paket zum lokalen Betrieb, keine öffentlich erreichbare Website.
