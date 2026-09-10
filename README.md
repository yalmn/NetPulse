# NetPulse

HTTP-, HTTPS- und ICMP-Monitoring mit Web-UI, REST-API und Grafana-Dashboards.

Targets lassen sich per Browser oder API verwalten. Prometheus übernimmt die Metrik-Erfassung via Blackbox Exporter, Grafana die Visualisierung. Alles läuft containerisiert und ist in unter einer Minute einsatzbereit.

## Stack

| Service           | Port | Aufgabe                          |
|-------------------|------|----------------------------------|
| FastAPI App       | 8000 | Web-UI + REST-API                |
| Prometheus        | 9090 | Metrik-Erfassung                 |
| Blackbox Exporter | 9115 | HTTP/HTTPS/ICMP Probes           |
| Grafana           | 3000 | Dashboards                       |
| nginx             |      | Reverse Proxy mit Basic Auth     |

Alle Services ausser Grafana (eigener Login) sind per HTTP Basic Auth geschützt. Die Credentials werden beim Setup automatisch generiert und gelten einheitlich für Web-UI, API, Prometheus und Blackbox Exporter.

## Setup

Voraussetzung: Docker + Docker Compose.

**Wichtig:** Immer `install.sh` verwenden, nicht `docker compose up` direkt. Der Installer generiert Credentials, setzt den Dashboard-Titel und konfiguriert alles korrekt.

```bash
git clone https://github.com/yalmn/NetPulse.git
cd NetPulse
bash install.sh
```

Der Installer:
1. Prüft/installiert Docker
2. Erstellt `.env` mit sicherem Passwort
3. Fragt den gewünschten Dashboard-Namen ab
4. Baut und startet alle Container

Login-Daten (User + Passwort) werden einmalig in der Konsole ausgegeben.

Auf einer frischen VM (Debian/Ubuntu):

```bash
apt update && apt install -y curl git
curl -fsSL https://raw.githubusercontent.com/yalmn/NetPulse/master/install.sh | bash
```

Docker wird vom Installer automatisch installiert, falls nicht vorhanden. Python ist nicht nötig, da alles im Container läuft.

## Konfiguration

Alle Einstellungen liegen in `.env` (wird beim Setup automatisch erzeugt):

| Variable              | Default             | Zweck                              |
|-----------------------|---------------------|------------------------------------|
| `COMPOSE_PROJECT_NAME`| netpulse            | Docker-Projektname                 |
| `APP_PORT`            | 8000                | FastAPI                            |
| `PROMETHEUS_PORT`     | 9090                | Prometheus                         |
| `GRAFANA_PORT`        | 3000                | Grafana                            |
| `BLACKBOX_PORT`       | 9115                | Blackbox Exporter                  |
| `GF_ADMIN_USER`       | admin               | Login-User (Basic Auth + Grafana)  |
| `GF_ADMIN_PASSWORD`   | *generiert*         | Login-Passwort (Basic Auth + Grafana) |
| `DASHBOARD_TITLE`     | Monitoring Dashboard| Dashboard-Name                     |

## API

Alle API-Aufrufe erfordern Basic Auth (`-u user:passwort`):

```bash
# Target anlegen
curl -u admin:PASSWORT -X POST http://localhost:8000/targets/add \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'

# Alle Targets abfragen
curl -u admin:PASSWORT http://localhost:8000/targets

# Target löschen
curl -u admin:PASSWORT -X DELETE http://localhost:8000/targets/remove \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'
```

Interaktive API-Docs: http://localhost:8000/docs (Login im Browser-Dialog)

## Monitoring Dashboard (GitHub Pages)

Unter `docs/` liegt ein statisches Monitoring-Dashboard, das ueber GitHub Pages weltweit erreichbar ist. Der Nutzer gibt IP-Adressen und URLs ein, darauf laufen Healthchecks fuer HTTP, HTTPS und Ping mit Status, Antwortzeit, Sparkline und Uptime. Ein zweites Widget zeigt die Erreichbarkeit aus mehreren Laendern (Kanada, Japan, Australien, USA).

Alle Checks laufen direkt im Browser ueber [Globalping](https://globalping.io), ein kostenloses globales Mess-Netzwerk. Es wird kein Server und kein Konto benoetigt. Das kostenlose Limit liegt bei 250 Checks pro Stunde und IP, daher liegt das Intervall standardmaessig bei 60 Sekunden. Das Dashboard zeigt oben eine Schaetzung der Checks pro Stunde und warnt, wenn das Limit ueberschritten wird.

Aufbau: reines Frontend in `docs/` (`index.html`, `dashboard.js`, `chart.js`, `style.css`, `config.json`), kein Build noetig.

### GitHub Pages aktivieren

In den Repo-Einstellungen unter *Settings, Pages* als Quelle Branch `master`, Ordner `/docs` waehlen. Danach ist das Dashboard unter `https://<user>.github.io/<repo>/` erreichbar.

### Lokal testen

```bash
python3 -m http.server -d docs 8080          # Dashboard auf http://localhost:8080
```

### Standardwerte anpassen

In `docs/config.json` lassen sich Standardziele, Laenderliste, Intervalle und der Standort fuer die Haupt-Checks vorbelegen:

```json
{
  "checkIntervalSec": 60,
  "countryIntervalSec": 300,
  "primaryCountry": "DE",
  "defaultTargets": ["example.com", "1.1.1.1"],
  "countries": [{ "code": "CA", "name": "Kanada" }]
}
```

## Reinstall / Deinstallation

`install.sh` erneut ausführen setzt alles zurück (Volumes, Targets, Passwort).

Komplett entfernen:

```bash
bash uninstall.sh
```

## Lizenz

[MIT](./LICENSE)
