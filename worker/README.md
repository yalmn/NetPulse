# NetPulse Check Worker

Kleiner Cloudflare-Worker, der die Healthchecks fuer das Dashboard ausfuehrt:

- **HTTP** und **HTTPS**: echter Request mit Statuscode und Antwortzeit.
- **Ping**: TCP-Connect auf Port 443 mit Fallback auf 80 und Antwortzeit. Cloudflare Workers koennen kein ICMP, daher wird die Erreichbarkeit per TCP-Verbindung gemessen.

Der Worker macht nur ausgehende Checks, speichert nichts und braucht keine Secrets.

## Lokal testen

```bash
cd worker
npm install
npm run dev
```

Danach laeuft der Worker auf `http://127.0.0.1:8787`. Testabfrage:

```bash
curl -X POST http://127.0.0.1:8787 \
  -H "Content-Type: application/json" \
  -d '{"targets":["example.com","1.1.1.1"],"types":["http","https","ping"]}'
```

## Deploy zu Cloudflare

Einmalig Cloudflare-Login noetig (kostenloser Tarif reicht):

```bash
cd worker
npx wrangler login
npm run deploy
```

Nach dem Deploy zeigt wrangler die URL an, etwa `https://netpulse-checks.DEIN-SUBDOMAIN.workers.dev`.
Diese URL im Dashboard oben im Feld "Worker-URL" eintragen und speichern.

## API

`POST /` mit JSON `{ "targets": ["..."], "types": ["http","https","ping"] }`
liefert:

```json
{
  "checkedAt": "2026-01-01T00:00:00.000Z",
  "results": [
    { "target": "example.com", "type": "https", "status": "up", "code": 200, "ms": 80 }
  ]
}
```

CORS ist offen, damit die GitHub-Pages-Seite den Worker aufrufen kann.
