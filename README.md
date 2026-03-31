# NetPulse

Ein leichtgewichtiges Monitoring-System zur Ueberwachung von HTTP-, HTTPS- und ICMP-Zielen. Targets werden ueber eine Web-UI oder REST-API verwaltet; Prometheus sammelt die Metriken via Blackbox Exporter und Grafana visualisiert die Ergebnisse.

## Architektur

```
┌──────────────┐    ┌──────────────────┐    ┌───────────────┐
│   FastAPI     │    │   Prometheus     │    │   Grafana     │
│   (Web-UI +  │───>│   (Metriken)     │───>│  (Dashboards) │
│    REST-API) │    │                  │    │               │
└──────────────┘    └───────┬──────────┘    └───────────────┘
                            │
                    ┌───────▼──────────┐
                    │ Blackbox Exporter│
                    │  (HTTP/HTTPS/    │
                    │   ICMP Probes)   │
                    └──────────────────┘
```

**Services:**

| Service            | Beschreibung                              | Standard-Port |
|--------------------|-------------------------------------------|---------------|
| FastAPI App        | Web-UI und REST-API fuer Target-Verwaltung | 8000          |
| Prometheus         | Metrik-Sammlung und -Speicherung          | 9090          |
| Blackbox Exporter  | HTTP/HTTPS/ICMP Probing                   | 9115          |
| Grafana            | Dashboard-Visualisierung                  | 3000          |

## Features

- Targets hinzufuegen und entfernen ueber Web-UI oder REST-API
- HTTP, HTTPS und ICMP Monitoring
- Live-Status (Up/Down), Antwortzeiten und Verfuegbarkeit (5 Min.)
- WHOIS- und DNS-Lookup fuer alle Targets
- Konfigurierbarer Dashboard-Name bei Installation
- Automatisches Prometheus-Reload bei Target-Aenderungen
- Sicheres Grafana-Passwort wird automatisch generiert

## Quick Start

### Voraussetzungen

- Docker und Docker Compose

### Installation

```bash
git clone https://github.com/<user>/netpulse.git
cd netpulse
bash install.sh
```

Der Installer:
1. Prueft ob Docker installiert ist (installiert es bei Bedarf)
2. Erstellt `.env` mit automatisch generiertem Grafana-Passwort
3. Fragt den gewuenschten Dashboard-Namen ab
4. Startet alle Services via Docker Compose

### Automatischer Installer (VM)

```bash
# Privates Repo (SSH-Zugang noetig)
git clone git@github.com:<user>/netpulse.git && cd netpulse && bash install.sh

# Oeffentliches Repo (Einzeiler)
curl -fsSL https://raw.githubusercontent.com/<user>/netpulse/main/install.sh | bash
```

## Konfiguration

Die Konfiguration erfolgt ueber `.env` (wird bei `install.sh` automatisch erstellt).

| Variable              | Standard            | Beschreibung                        |
|-----------------------|---------------------|-------------------------------------|
| `COMPOSE_PROJECT_NAME`| netpulse            | Projektname in Docker               |
| `APP_PORT`            | 8000                | Port der FastAPI App                |
| `PROMETHEUS_PORT`     | 9090                | Port von Prometheus                 |
| `GRAFANA_PORT`        | 3000                | Port von Grafana                    |
| `BLACKBOX_PORT`       | 9115                | Port des Blackbox Exporter          |
| `GF_ADMIN_USER`       | admin               | Grafana Admin-Benutzername          |
| `GF_ADMIN_PASSWORD`   | *automatisch generiert* | Grafana Admin-Passwort          |
| `DASHBOARD_TITLE`     | Monitoring Dashboard| Name des Grafana-Dashboards         |

## Nutzung

Nach dem Start sind folgende Oberflaechen erreichbar:

- **Web-UI:** http://localhost:8000/ui
- **REST-API:** http://localhost:8000/docs
- **Prometheus:** http://localhost:9090
- **Grafana:** http://localhost:3000 (Passwort siehe `.env` oder Installer-Ausgabe)

### REST-API Beispiele

```bash
# Target hinzufuegen
curl -X POST http://localhost:8000/targets/add \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'

# Alle Targets abrufen
curl http://localhost:8000/targets

# Target entfernen
curl -X DELETE http://localhost:8000/targets/remove \
  -H "Content-Type: application/json" \
  -d '{"type": "http", "target": "http://example.com"}'
```

## Reinstallation

Bei erneuter Ausfuehrung von `install.sh` werden alle Services zurueckgesetzt:
- Grafana-Volume wird entfernt (neues Passwort greift)
- Alle Targets werden geleert
- Dashboard-Name kann neu gewaehlt werden

## Deinstallation

```bash
bash uninstall.sh
```

## Lizenz

MIT
