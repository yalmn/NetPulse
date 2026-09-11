# NetPulse

Monitoring für URLs und IP-Adressen: Analysten tragen Ziele über ein Dashboard auf GitHub Pages ein, ein Server (VPS) misst HTTP, HTTPS und Ping und zeigt die Verläufe in Grafana. URLs werden ausschließlich per HTTP/HTTPS geprüft, Ping (ICMP) gibt es nur für IP-Adressen. Zusätzlich wird die Ladezeit aus Deutschland, Frankreich und Japan minütlich gemessen und als Liniendiagramm dargestellt.

## Architektur

```
Analyst ─► GitHub Pages (docs/, statisch)
              │ fetch mit Login                 iframe
              ▼                                  ▼
        https://<PUBLIC_HOST>  ── Caddy (TLS, Basic Auth) ──
              │ /api/*                          │ /grafana/*
              ▼                                  ▼
        FastAPI ──reload──► Prometheus ◄──── Grafana
          │ /metrics ◄─scrape─┘    └─scrape─► Blackbox Exporter (HTTP/HTTPS/ICMP)
          └─ Geo-Collector ──► Globalping (DE, FR, JP)
```

| Service           | Aufgabe                                                        |
|-------------------|----------------------------------------------------------------|
| Caddy             | HTTPS mit Let's-Encrypt-Zertifikat, Basic Auth, einziger offener Dienst (Ports 80/443) |
| FastAPI App       | JSON-API für das Dashboard, alte Web-UI, Geo-Collector         |
| Prometheus        | Speichert alle Messwerte (Standard 30 Tage)                    |
| Blackbox Exporter | HTTP-, HTTPS- und ICMP-Checks vom Server aus                   |
| Grafana           | Diagramme, eingebettet ins Dashboard unter `/grafana`          |

Das Dashboard hat zwei Bereiche:

1. **Monitoring (Grafana):** Zielliste mit Status sowie das Grafana-Dashboard mit Phasenverlauf (DNS, Connect, TLS, Processing, Transfer), Probe-Dauer, WHOIS und DNS.
2. **Länder-Erreichbarkeit:** pro Ziel ein Liniendiagramm (x = Zeit, y = Ladezeit in ms) mit einer Linie je Land, der Durchschnitt ist gestrichelt eingezeichnet. Webseiten werden per HTTP(S) geladen, reine IP-Adressen gepingt.

Die Länder-Checks laufen über [Globalping](https://globalping.io) vom Server aus, also auch dann, wenn kein Browser offen ist. Pro Ziel und Runde kostet das drei Tests (ein Test je Land). Mit kostenlosem Globalping-Token stehen 500 Tests pro Stunde zur Verfügung: bis zu zwei Ziele werden minütlich gemessen, bei mehr Zielen verlängert sich der Takt automatisch. Das Dashboard zeigt den aktuellen Takt an.

## Setup auf dem VPS

Voraussetzung: Linux-VPS (z. B. Ionos) mit öffentlicher IP, Ports 80 und 443 erreichbar.

```bash
apt update && apt install -y curl git
curl -fsSL https://raw.githubusercontent.com/yalmn/NetPulse/master/install.sh | bash
```

Der Installer:
1. Prüft/installiert Docker
2. Erstellt `.env` mit sicherem Passwort
3. Fragt den Hostnamen ab. Ohne eigene Domain den Vorschlag `<ip-mit-bindestrichen>.sslip.io` übernehmen, das Zertifikat funktioniert trotzdem.
4. Fragt optional nach einem Globalping-Token (kostenlos auf [dash.globalping.io](https://dash.globalping.io))
5. Baut und startet alle Container

Login-Daten (User + Passwort) und die Server-Adresse werden einmalig in der Konsole ausgegeben.

**Ionos:** Im Cloud Panel unter *Netzwerk, Firewall-Richtlinien* die Ports 80 und 443 (TCP) freigeben. Die alten Ports 3000, 8000, 9090 und 9115 werden nicht mehr gebraucht.

## Dashboard auf GitHub Pages

In den Repo-Einstellungen unter *Settings, Pages* als Quelle Branch `master`, Ordner `/docs` wählen. Danach ist das Dashboard unter `https://yalmn.github.io/NetPulse/` erreichbar.

Beim Login die Server-Adresse (z. B. `https://203-0-113-10.sslip.io`), Benutzer und Passwort angeben. Die Server-Adresse lässt sich auch fest als `apiBase` in `docs/config.json` hinterlegen.

Die Grafana-Diagramme werden per iframe eingebettet. Beim ersten Öffnen fragt der Browser dort nach denselben Zugangsdaten. Falls ein Browser das im iframe nicht zulässt, öffnet der Button *In neuem Tab öffnen* Grafana direkt.

Läuft das Dashboard unter einer anderen Adresse als `https://yalmn.github.io`, diese in `.env` bei `ALLOWED_ORIGINS` ergänzen (kommagetrennt) und `docker compose up -d` ausführen.

## Konfiguration

Alle Einstellungen liegen in `.env` (wird beim Setup automatisch erzeugt):

| Variable               | Default                   | Zweck                                         |
|------------------------|---------------------------|-----------------------------------------------|
| `PUBLIC_HOST`          | *Abfrage beim Setup*      | Hostname für HTTPS (Domain oder sslip.io)     |
| `GF_ADMIN_USER`        | admin                     | Login-User (Dashboard, API, Grafana)          |
| `GF_ADMIN_PASSWORD`    | *generiert*               | Login-Passwort                                |
| `ALLOWED_ORIGINS`      | https://yalmn.github.io   | Wer die API aus dem Browser aufrufen darf     |
| `GLOBALPING_TOKEN`     | leer                      | Höheres Limit für die Länder-Checks           |
| `GEO_COUNTRIES`        | DE,FR,JP                  | Länder für die Länder-Checks                  |
| `PROMETHEUS_RETENTION` | 30d                       | Aufbewahrung der Messdaten                    |
| `HTTP_PORT` / `HTTPS_PORT` | 80 / 443              | Ports von Caddy                               |
| `DASHBOARD_TITLE`      | Monitoring Dashboard      | Titel des Grafana-Dashboards                  |

## API

Alle Aufrufe unter `/api` brauchen Basic Auth:

```bash
# Ziel mit mehreren Checks anlegen (http, https, icmp, geo)
curl -u admin:PASSWORT -X POST https://HOST/api/targets \
  -H "Content-Type: application/json" \
  -d '{"target": "https://example.com", "types": ["https", "geo"]}'

# IP-Adresse pingen (icmp nur für IPs)
curl -u admin:PASSWORT -X POST https://HOST/api/targets \
  -H "Content-Type: application/json" \
  -d '{"target": "1.1.1.1", "types": ["icmp", "geo"]}'

# Status aller Ziele
curl -u admin:PASSWORT https://HOST/api/targets/status

# Ladezeit je Land (Zeitraum 1h, 6h, 24h oder 7d)
curl -u admin:PASSWORT "https://HOST/api/geo/series?target=https://example.com&range=6h"

# Ziel entfernen
curl -u admin:PASSWORT -X DELETE "https://HOST/api/targets?type=geo&target=https://example.com"
```

Interaktive API-Doku: `https://HOST/docs`, die alte Web-UI liegt unter `https://HOST/ui`.

## Lokal testen

```bash
# in .env: PUBLIC_HOST=localhost und ALLOWED_ORIGINS=https://yalmn.github.io,http://localhost:8080
docker compose up -d --build
python3 -m http.server -d docs 8080      # Dashboard auf http://localhost:8080
```

Bei `PUBLIC_HOST=localhost` nutzt Caddy ein lokales Zertifikat, dem der Browser erst vertrauen muss.

## Reinstall / Deinstallation

`install.sh` erneut ausführen setzt alles zurück (Volumes, Targets, Passwort bleibt aus `.env`).

Komplett entfernen:

```bash
bash uninstall.sh
```

## Lizenz

[MIT](./LICENSE)
