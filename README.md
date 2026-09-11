# NetPulse

Monitoring-Tool für URLs und IPs. Die Oberfläche läuft über GitHub Pages, gemessen wird auf einem eigenen VPS mit Prometheus, Blackbox Exporter und Grafana.

Das Dashboard hat zwei Bereiche:

- Monitoring: HTTP, HTTPS und Ping vom VPS aus, Diagramme über Grafana
- Länder-Erreichbarkeit: Ladezeit aus Deutschland, Frankreich und Japan, minütlich als Liniendiagramm

URLs werden nur per HTTP/HTTPS geprüft, Ping gibt es nur für IPs.

## Stack

| Service           | Aufgabe                                          |
|-------------------|--------------------------------------------------|
| Caddy             | Reverse Proxy, HTTPS über Let's Encrypt, Login   |
| FastAPI           | API fürs Dashboard, Länder-Checks                |
| Prometheus        | Speichert die Messwerte (30 Tage)                |
| Blackbox Exporter | HTTP/HTTPS/ICMP-Checks vom VPS                   |
| Grafana           | Diagramme, erreichbar unter `/grafana`           |

Nach außen sind nur Port 80 und 443 offen.

Deutschland misst der VPS selbst, Frankreich und Japan laufen über [Globalping](https://globalping.io). Mit einem kostenlosen Token (500 Tests pro Stunde) gehen 3 Targets im Minutentakt, bei mehr Targets wird automatisch langsamer gemessen. Fällt eine Messung aus, sieht man das als Lücke im Diagramm.

## Setup

Voraussetzung: VPS mit Debian oder Ubuntu, Port 80 und 443 offen. Bei Ionos geht das im Cloud Panel unter Netzwerk > Firewall-Richtlinien.

```bash
apt update && apt install -y curl git sudo
curl -fsSL https://raw.githubusercontent.com/yalmn/NetPulse/master/install.sh | bash
```

Der Installer fragt nach Hostname, Globalping-Token und Dashboard-Name. Ohne eigene Domain einfach den sslip.io-Vorschlag übernehmen. Am Ende werden Server-Adresse und Login-Daten ausgegeben. Das Passwort wird nur einmal angezeigt, also direkt notieren.

Den Globalping-Token gibt es kostenlos auf [dash.globalping.io](https://dash.globalping.io).

### Update

```bash
cd ~/netpulse && git pull && docker compose up -d --build
```

Nicht `install.sh` erneut ausführen, das setzt alles zurück, auch die Messdaten.

## Dashboard

In den Repo-Einstellungen unter Settings > Pages als Quelle Branch `master` und Ordner `/docs` wählen. Danach auf https://yalmn.github.io/NetPulse/ mit Server-Adresse, User und Passwort anmelden.

Die Server-Adresse kann man auch fest als `apiBase` in `docs/config.json` eintragen, dann muss man sie beim Login nicht jedes Mal angeben.

Grafana ist im Dashboard eingebettet. Falls der Browser dort nicht nach dem Login fragt, einfach über "In neuem Tab öffnen" gehen.

## Konfiguration

Alles steht in der `.env`, die der Installer anlegt:

| Variable               | Default                 | Zweck                                      |
|------------------------|-------------------------|--------------------------------------------|
| `PUBLIC_HOST`          | wird abgefragt          | Domain oder sslip.io-Hostname              |
| `GF_ADMIN_USER`        | admin                   | Login für Dashboard, API und Grafana       |
| `GF_ADMIN_PASSWORD`    | wird generiert          | Passwort dazu                              |
| `GLOBALPING_TOKEN`     | leer                    | Token für die Länder-Checks                |
| `GEO_COUNTRIES`        | FR,JP                   | Länder über Globalping                     |
| `VPS_COUNTRY`          | DE                      | Land des VPS                               |
| `ALLOWED_ORIGINS`      | https://yalmn.github.io | Von wo die API aufgerufen werden darf      |
| `PROMETHEUS_RETENTION` | 30d                     | Wie lange Messdaten gespeichert werden     |
| `DASHBOARD_TITLE`      | Monitoring Dashboard    | Titel in Grafana                           |

## API

Alles unter `/api` braucht Basic Auth:

```bash
# URL mit HTTPS- und Länder-Check
curl -u admin:PASSWORT -X POST https://HOST/api/targets \
  -H "Content-Type: application/json" \
  -d '{"target": "https://example.com", "types": ["https", "geo"]}'

# IP pingen
curl -u admin:PASSWORT -X POST https://HOST/api/targets \
  -H "Content-Type: application/json" \
  -d '{"target": "1.1.1.1", "types": ["icmp", "geo"]}'

# Status aller Targets
curl -u admin:PASSWORT https://HOST/api/targets/status

# Target löschen
curl -u admin:PASSWORT -X DELETE "https://HOST/api/targets?type=https&target=https://example.com"
```

API-Doku gibt es unter `https://HOST/docs`, die alte Web-UI unter `https://HOST/ui`.

## Lokal testen

In der `.env` `PUBLIC_HOST=localhost` und `ALLOWED_ORIGINS=https://yalmn.github.io,http://localhost:8080` setzen, dann:

```bash
docker compose up -d --build
python3 -m http.server -d docs 8080
```

Das Dashboard läuft dann auf http://localhost:8080. Caddy nutzt lokal ein eigenes Zertifikat, das man im Browser einmal akzeptieren muss.

## Deinstallation

```bash
bash uninstall.sh
```

## Lizenz

[MIT](./LICENSE)
