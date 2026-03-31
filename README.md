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

## Reinstall / Deinstallation

`install.sh` erneut ausführen setzt alles zurück (Volumes, Targets, Passwort).

Komplett entfernen:

```bash
bash uninstall.sh
```

## Lizenz

[MIT](./LICENSE)
