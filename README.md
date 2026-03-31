# NetPulse

HTTP-, HTTPS- und ICMP-Monitoring mit Web-UI, REST-API und Grafana-Dashboards.

Targets lassen sich per Browser oder API verwalten. Prometheus uebernimmt die Metrik-Erfassung via Blackbox Exporter, Grafana die Visualisierung. Alles laeuft containerisiert und ist in unter einer Minute einsatzbereit.

## Stack

| Service           | Port | Aufgabe                          |
|-------------------|------|----------------------------------|
| FastAPI App       | 8000 | Web-UI + REST-API                |
| Prometheus        | 9090 | Metrik-Erfassung                 |
| Blackbox Exporter | 9115 | HTTP/HTTPS/ICMP Probes           |
| Grafana           | 3000 | Dashboards                       |

## Setup

Voraussetzung: Docker + Docker Compose.

```bash
git clone https://github.com/yalmn/NetPulse.git
cd NetPulse
bash install.sh
```

`install.sh` prueft Docker, generiert ein sicheres Grafana-Passwort, fragt den Dashboard-Namen ab und startet den Stack. Das Passwort wird einmalig in der Konsole ausgegeben und in `.env` gespeichert.

Auf einer frischen VM geht auch:

```bash
curl -fsSL https://raw.githubusercontent.com/yalmn/NetPulse/main/install.sh | bash
```

## Konfiguration

Alle Einstellungen liegen in `.env` (wird beim Setup automatisch erzeugt):

| Variable              | Default             | Zweck                    |
|-----------------------|---------------------|--------------------------|
| `COMPOSE_PROJECT_NAME`| netpulse            | Docker-Projektname       |
| `APP_PORT`            | 8000                | FastAPI                  |
| `PROMETHEUS_PORT`     | 9090                | Prometheus               |
| `GRAFANA_PORT`        | 3000                | Grafana                  |
| `BLACKBOX_PORT`       | 9115                | Blackbox Exporter        |
| `GF_ADMIN_USER`       | admin               | Grafana-User             |
| `GF_ADMIN_PASSWORD`   | *generiert*         | Grafana-Passwort         |
| `DASHBOARD_TITLE`     | Monitoring Dashboard| Dashboard-Name           |

## API

```bash
# Target anlegen
curl -X POST http://localhost:8000/targets/add \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'

# Alle Targets abfragen
curl http://localhost:8000/targets

# Target loeschen
curl -X DELETE http://localhost:8000/targets/remove \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'
```

Interaktive API-Docs: http://localhost:8000/docs

## Reinstall / Deinstallation

`install.sh` erneut ausfuehren setzt alles zurueck (Volumes, Targets, Passwort).

Komplett entfernen:

```bash
bash uninstall.sh
```

## Lizenz

MIT
