"""Länder-Erreichbarkeit über Globalping.

Deutschland (VPS_COUNTRY) misst der VPS selbst über den Blackbox Exporter, Globalping
misst nur die übrigen Länder (Standard FR, JP). Jedes Land wird einzeln gemessen, damit
ein Problem in einem Land die anderen nicht mitreißt. Ergebnisse gehen als
Prometheus-Metriken raus.

Konsistenz: Eine gescheiterte Messung wird als Lücke gespeichert, nie als alter Wert.
Ein Wächter startet die Messschleife neu, falls sie abbricht oder hängt.

Das Globalping-Kontingent ist pro Stunde begrenzt (mit Token 500 Tests, ohne 250).
Der Takt richtet sich nach der Anzahl der Ziele: so viele wie möglich minütlich,
darüber automatisch langsamer.
"""

import asyncio
import ipaddress
import logging
import math
import os
import time
from typing import Callable, List
from urllib.parse import urlparse

import httpx
from prometheus_client import Gauge

log = logging.getLogger("netpulse.geo")

GLOBALPING_URL = "https://api.globalping.io/v1/measurements"
GLOBALPING_TOKEN = os.getenv("GLOBALPING_TOKEN", "").strip()
VPS_COUNTRY = os.getenv("VPS_COUNTRY", "DE").strip().upper()
COUNTRIES = [
    code
    for code in (c.strip().upper() for c in os.getenv("GEO_COUNTRIES", "FR,JP").split(","))
    if code and code != VPS_COUNTRY
]

MIN_INTERVAL = 60        # Sekunden, schneller wird nie gemessen
SAFETY = 0.9             # Abstand zum Stundenlimit
POLL_TIMEOUT = 30        # Sekunden, bis eine Messung als unvollständig gilt
LOOP_TICK = 2
RETRY_DELAY = 5          # Sekunden bis zum Wiederholungsversuch bei Netzwerkfehlern
STALE_FACTOR = 3         # Werte älter als 3 Intervalle werden verworfen (Lücke statt altem Wert)
HEARTBEAT_TIMEOUT = 180  # Sekunden ohne Lebenszeichen, danach startet der Wächter die Schleife neu

DURATION = Gauge(
    "netpulse_geo_duration_ms",
    "Ladezeit (HTTP) bzw. RTT (Ping) aus dem jeweiligen Land in ms",
    ["target", "country"],
)
SUCCESS = Gauge("netpulse_geo_success", "1 = erreichbar, 0 = nicht erreichbar", ["target", "country"])
STATUS_CODE = Gauge("netpulse_geo_status_code", "HTTP-Statuscode der letzten Messung", ["target", "country"])
LAST_RUN = Gauge("netpulse_geo_last_run_timestamp_seconds", "Zeitpunkt der letzten Messung", ["target"])
RESTARTS = Gauge("netpulse_geo_collector_restarts", "Neustarts der Messschleife durch den Wächter")


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def build_measurement(target: str, countries: List[str]) -> dict:
    """IP-Adressen werden gepingt, alles andere per HTTP(S) geladen."""
    locations = [{"country": c, "limit": 1} for c in countries]

    if is_ip(target):
        return {
            "type": "ping",
            "target": target,
            "locations": locations,
            "measurementOptions": {"packets": 3},
        }

    parsed = urlparse(target if "://" in target else f"https://{target}")
    request = {"method": "GET", "path": parsed.path or "/"}
    if parsed.query:
        request["query"] = parsed.query

    options = {"protocol": "HTTP" if parsed.scheme == "http" else "HTTPS", "request": request}
    if parsed.port:
        options["port"] = parsed.port

    return {"type": "http", "target": parsed.hostname, "locations": locations, "measurementOptions": options}


def parse_result(kind: str, item: dict) -> dict | None:
    result = item.get("result") or {}
    status = result.get("status")
    if status == "in-progress":
        return None

    if kind == "http":
        code = result.get("statusCode")
        total = (result.get("timings") or {}).get("total")
        return {
            "up": status == "finished" and isinstance(code, int) and code < 400,
            "ms": total if isinstance(total, (int, float)) else None,
            "code": code if isinstance(code, int) else None,
        }

    stats = result.get("stats") or {}
    loss = stats.get("loss")
    avg = stats.get("avg")
    return {
        "up": status == "finished" and isinstance(loss, (int, float)) and loss < 100,
        "ms": avg if isinstance(avg, (int, float)) else None,
        "code": None,
    }


def _drop(gauge: Gauge, *labels: str) -> None:
    try:
        gauge.remove(*labels)
    except KeyError:
        pass


def _drop_country(target: str, country: str) -> None:
    for gauge in (DURATION, SUCCESS, STATUS_CODE):
        _drop(gauge, target, country)


class GeoCollector:
    def __init__(self, get_targets: Callable[[], List[str]]):
        self._get_targets = get_targets
        self._attempted: dict[str, float] = {}
        self._updated: dict[tuple[str, str], float] = {}
        self.latest: dict[str, dict] = {}
        self.limit = 500 if GLOBALPING_TOKEN else 250
        self.remaining: int | None = None
        self.credits: int | None = None
        self.reset_at = 0.0
        self.paused_until = 0.0
        self.last_error: str | None = None
        self.started = time.time()
        self.heartbeat = time.time()
        self.last_success = 0.0
        self.restarts = 0

    def targets(self) -> List[str]:
        try:
            return list(self._get_targets())
        except Exception:
            return []

    def interval(self, count: int) -> int:
        if count == 0 or not COUNTRIES:
            return MIN_INTERVAL
        return max(MIN_INTERVAL, math.ceil(count * len(COUNTRIES) * 3600 / (self.limit * SAFETY)))

    def status(self) -> dict:
        now = time.time()
        count = len(self.targets())
        interval = self.interval(count)
        reference = self.last_success or self.started
        return {
            "countries": COUNTRIES,
            "vps_country": VPS_COUNTRY,
            "targets": count,
            "interval_s": interval,
            "tests_per_hour": round(count * len(COUNTRIES) * 3600 / interval),
            "max_minutely_targets": int(self.limit * SAFETY // (len(COUNTRIES) * 60)) if COUNTRIES else 0,
            "limit_per_hour": self.limit,
            "remaining": self.remaining,
            "credits": self.credits,
            "reset_in_s": max(0, round(self.reset_at - now)) if self.reset_at else None,
            "paused_for_s": max(0, round(self.paused_until - now)),
            "token": bool(GLOBALPING_TOKEN),
            "last_error": self.last_error,
            "last_success_age_s": round(now - self.last_success) if self.last_success else None,
            "healthy": count == 0 or not COUNTRIES or now - reference < STALE_FACTOR * interval,
            "restarts": self.restarts,
        }

    def snapshot(self) -> list[dict]:
        result = []
        for target in self.targets():
            entry = self.latest.get(target, {"t": None, "kind": None, "countries": {}})
            result.append({"target": target, "t": entry["t"], "kind": entry["kind"], "countries": dict(entry["countries"])})
        return result

    # ── Wächter und Messschleife ──

    async def supervise(self) -> None:
        """Startet die Messschleife und startet sie neu, wenn sie abbricht oder hängt."""
        task: asyncio.Task | None = None
        try:
            while True:
                if task is None or task.done():
                    if task is not None:
                        self._record_restart(f"Messschleife beendet: {task.exception() if not task.cancelled() else 'abgebrochen'}")
                    self.heartbeat = time.time()
                    task = asyncio.create_task(self.run())
                elif time.time() - self.heartbeat > HEARTBEAT_TIMEOUT:
                    self._record_restart("Messschleife hing, wird neu gestartet")
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    task = None
                    continue
                await asyncio.sleep(10)
        finally:
            if task is not None:
                task.cancel()

    def _record_restart(self, reason: str) -> None:
        self.restarts += 1
        RESTARTS.set(self.restarts)
        self.last_error = reason
        log.error(reason)

    async def run(self) -> None:
        headers = {"User-Agent": "NetPulse (https://github.com/yalmn/NetPulse)"}
        if GLOBALPING_TOKEN:
            headers["Authorization"] = f"Bearer {GLOBALPING_TOKEN}"

        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
            while True:
                self.heartbeat = time.time()
                try:
                    await self._tick(client)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.last_error = f"Messschleife: {exc}"
                    log.exception("Fehler in der Messschleife")
                await asyncio.sleep(LOOP_TICK)

    async def _tick(self, client: httpx.AsyncClient) -> None:
        targets = self.targets()
        self._forget_removed(targets)
        if not COUNTRIES:
            return

        interval = self.interval(len(targets))
        self._drop_stale(interval)

        for target in targets:
            if time.time() < self.paused_until:
                break
            # Neue Ziele sofort, bekannte erst nach Ablauf des Intervalls
            if time.time() - self._attempted.get(target, 0) < interval:
                continue
            self._attempted[target] = time.time()
            await self._measure_target(client, target)
            self.heartbeat = time.time()

    # ── Messung ──

    async def _measure_target(self, client: httpx.AsyncClient, target: str) -> None:
        results = await asyncio.gather(
            *(self._measure_country(client, target, country) for country in COUNTRIES),
            return_exceptions=True,
        )

        now = time.time()
        entry = self.latest.setdefault(target, {"t": None, "kind": None, "countries": {}})
        errors = []
        for country, result in zip(COUNTRIES, results):
            if isinstance(result, asyncio.CancelledError):
                raise result
            if isinstance(result, BaseException):
                errors.append(f"{country}: {result}")
                result = None
            # Kein Ergebnis = Lücke, nie den alten Wert weiterführen
            self._export(target, country, result)
            entry["countries"][country] = result
            if result is not None:
                self._updated[(target, country)] = now
                self.last_success = now

        entry["t"] = round(now * 1000)
        entry["kind"] = "ping" if is_ip(target) else "http"
        LAST_RUN.labels(target).set(now)
        self.last_error = f"{target}: {'; '.join(errors)}" if errors else None
        if errors:
            log.warning("Geo-Messung unvollständig: %s", self.last_error)

    async def _measure_country(self, client: httpx.AsyncClient, target: str, country: str) -> dict | None:
        body = build_measurement(target, [country])
        measurement_id = await self._create(client, body)

        deadline = time.monotonic() + POLL_TIMEOUT
        data: dict = {}
        while time.monotonic() < deadline:
            await asyncio.sleep(1)
            try:
                poll = await client.get(f"{GLOBALPING_URL}/{measurement_id}")
            except httpx.RequestError:
                continue
            if poll.status_code == 200:
                data = poll.json()
                if data.get("status") != "in-progress":
                    break

        results = data.get("results") or []
        if not results:
            return None
        return parse_result(body["type"], results[0])

    async def _create(self, client: httpx.AsyncClient, body: dict) -> str:
        """Legt eine Messung an. Netzwerk- und Serverfehler werden einmal wiederholt."""
        for attempt in (1, 2):
            try:
                response = await client.post(GLOBALPING_URL, json=body)
            except httpx.RequestError as exc:
                if attempt == 1:
                    await asyncio.sleep(RETRY_DELAY)
                    continue
                raise RuntimeError(f"Globalping nicht erreichbar ({exc.__class__.__name__})") from exc

            self._sync_rate(response.headers)

            if response.status_code == 429:
                wait = self.reset_at - time.time() if self.reset_at > time.time() else 60
                self.paused_until = time.time() + max(wait, 60)
                raise RuntimeError("Globalping-Limit erreicht, Pause bis zum Reset")

            if response.status_code >= 500 and attempt == 1:
                await asyncio.sleep(RETRY_DELAY)
                continue

            if response.status_code >= 400:
                try:
                    message = response.json().get("error", {}).get("message")
                except Exception:
                    message = response.text[:200]
                raise RuntimeError(f"Globalping {response.status_code}: {message}")

            return response.json()["id"]

        raise RuntimeError("Globalping antwortet nicht")

    def _sync_rate(self, headers: httpx.Headers) -> None:
        if headers.get("x-ratelimit-limit"):
            self.limit = int(headers["x-ratelimit-limit"])
        if headers.get("x-ratelimit-remaining") is not None:
            self.remaining = int(headers["x-ratelimit-remaining"])
        if headers.get("x-ratelimit-reset") is not None:
            self.reset_at = time.time() + int(headers["x-ratelimit-reset"])
        if headers.get("x-credits-remaining") is not None:
            self.credits = int(headers["x-credits-remaining"])

    # ── Metriken ──

    @staticmethod
    def _export(target: str, country: str, result: dict | None) -> None:
        if result is None:
            _drop_country(target, country)
            return

        SUCCESS.labels(target, country).set(1 if result["up"] else 0)
        # Ladezeit nur für erreichbare Antworten, Ausfälle erscheinen als Lücke im Diagramm
        if result["up"] and result["ms"] is not None:
            DURATION.labels(target, country).set(result["ms"])
        else:
            _drop(DURATION, target, country)
        if result["code"] is not None:
            STATUS_CODE.labels(target, country).set(result["code"])
        else:
            _drop(STATUS_CODE, target, country)

    def _drop_stale(self, interval: int) -> None:
        """Werte, die zu lange nicht erneuert wurden (z. B. Pause), verschwinden als Lücke."""
        limit = max(STALE_FACTOR * interval, 180)
        now = time.time()
        for (target, country), updated in list(self._updated.items()):
            if now - updated > limit:
                _drop_country(target, country)
                del self._updated[(target, country)]
                if target in self.latest:
                    self.latest[target]["countries"][country] = None

    def _forget_removed(self, targets: List[str]) -> None:
        for target in set(self.latest) | set(self._attempted):
            if target in targets:
                continue
            for country in COUNTRIES:
                _drop_country(target, country)
                self._updated.pop((target, country), None)
            _drop(LAST_RUN, target)
            self.latest.pop(target, None)
            self._attempted.pop(target, None)
