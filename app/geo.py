"""Länder-Erreichbarkeit über Globalping.

Misst jedes Geo-Ziel aus mehreren Ländern (Standard DE, FR, JP) und stellt die
Ergebnisse als Prometheus-Metriken bereit. Das Globalping-Kontingent ist pro Stunde
begrenzt (mit Token 500 Tests, ohne 250). Deshalb richtet sich der Takt nach der
Anzahl der Ziele: bis zu zwei Ziele minütlich, darüber automatisch langsamer.
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
COUNTRIES = [c.strip().upper() for c in os.getenv("GEO_COUNTRIES", "DE,FR,JP").split(",") if c.strip()]

MIN_INTERVAL = 60      # Sekunden, schneller wird nie gemessen
SAFETY = 0.9           # Abstand zum Stundenlimit
POLL_TIMEOUT = 30      # Sekunden, bis eine Messung als unvollständig gilt
LOOP_TICK = 2

DURATION = Gauge(
    "netpulse_geo_duration_ms",
    "Ladezeit (HTTP) bzw. RTT (Ping) aus dem jeweiligen Land in ms",
    ["target", "country"],
)
SUCCESS = Gauge("netpulse_geo_success", "1 = erreichbar, 0 = nicht erreichbar", ["target", "country"])
STATUS_CODE = Gauge("netpulse_geo_status_code", "HTTP-Statuscode der letzten Messung", ["target", "country"])
LAST_RUN = Gauge("netpulse_geo_last_run_timestamp_seconds", "Zeitpunkt der letzten Messung", ["target"])


def is_ip(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def build_measurement(target: str) -> dict:
    """IP-Adressen werden gepingt, alles andere per HTTP(S) geladen."""
    locations = [{"country": c, "limit": 1} for c in COUNTRIES]

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


class GeoCollector:
    def __init__(self, get_targets: Callable[[], List[str]]):
        self._get_targets = get_targets
        self._attempted: dict[str, float] = {}
        self.latest: dict[str, dict] = {}
        self.limit = 500 if GLOBALPING_TOKEN else 250
        self.remaining: int | None = None
        self.credits: int | None = None
        self.reset_at = 0.0
        self.paused_until = 0.0
        self.last_error: str | None = None

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
        return {
            "countries": COUNTRIES,
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
        }

    def snapshot(self) -> list[dict]:
        return [
            {"target": t, **self.latest.get(t, {"t": None, "kind": None, "countries": {}})}
            for t in self.targets()
        ]

    async def run(self) -> None:
        headers = {"User-Agent": "NetPulse (https://github.com/yalmn/NetPulse)"}
        if GLOBALPING_TOKEN:
            headers["Authorization"] = f"Bearer {GLOBALPING_TOKEN}"

        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
            while True:
                targets = self.targets()
                self._forget_removed(targets)
                interval = self.interval(len(targets))

                for target in targets:
                    if time.time() < self.paused_until:
                        break
                    # Neue Ziele sofort, bekannte erst nach Ablauf des Intervalls
                    if time.time() - self._attempted.get(target, 0) < interval:
                        continue
                    self._attempted[target] = time.time()
                    try:
                        await self._measure(client, target)
                        self.last_error = None
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        self.last_error = f"{target}: {exc}"
                        log.warning("Geo-Messung fehlgeschlagen: %s", self.last_error)

                await asyncio.sleep(LOOP_TICK)

    def _sync_rate(self, headers: httpx.Headers) -> None:
        if headers.get("x-ratelimit-limit"):
            self.limit = int(headers["x-ratelimit-limit"])
        if headers.get("x-ratelimit-remaining") is not None:
            self.remaining = int(headers["x-ratelimit-remaining"])
        if headers.get("x-ratelimit-reset") is not None:
            self.reset_at = time.time() + int(headers["x-ratelimit-reset"])
        if headers.get("x-credits-remaining") is not None:
            self.credits = int(headers["x-credits-remaining"])

    async def _measure(self, client: httpx.AsyncClient, target: str) -> None:
        body = build_measurement(target)
        kind = body["type"]

        response = await client.post(GLOBALPING_URL, json=body)
        self._sync_rate(response.headers)

        if response.status_code == 429:
            wait = self.reset_at - time.time() if self.reset_at > time.time() else 60
            self.paused_until = time.time() + max(wait, 60)
            raise RuntimeError("Globalping-Limit erreicht, Pause bis zum Reset")

        if response.status_code >= 400:
            try:
                message = response.json().get("error", {}).get("message")
            except Exception:
                message = response.text[:200]
            raise RuntimeError(f"Globalping {response.status_code}: {message}")

        measurement_id = response.json()["id"]
        deadline = time.monotonic() + POLL_TIMEOUT
        data: dict = {}
        while time.monotonic() < deadline:
            await asyncio.sleep(1)
            poll = await client.get(f"{GLOBALPING_URL}/{measurement_id}")
            if poll.status_code == 200:
                data = poll.json()
                if data.get("status") != "in-progress":
                    break

        by_country: dict[str, dict | None] = {}
        for item in data.get("results") or []:
            code = ((item.get("probe") or {}).get("country") or "").upper()
            if code in COUNTRIES and code not in by_country:
                by_country[code] = parse_result(kind, item)

        now = time.time()
        for country in COUNTRIES:
            self._export(target, country, by_country.get(country))
        LAST_RUN.labels(target).set(now)
        self.latest[target] = {
            "t": round(now * 1000),
            "kind": kind,
            "countries": {c: by_country.get(c) for c in COUNTRIES},
        }

    @staticmethod
    def _export(target: str, country: str, result: dict | None) -> None:
        if result is None:
            for gauge in (DURATION, SUCCESS, STATUS_CODE):
                _drop(gauge, target, country)
            return

        SUCCESS.labels(target, country).set(1 if result["up"] else 0)
        # Ladezeit nur für erreichbare Antworten, Ausfälle erscheinen als Lücke im Diagramm
        if result["up"] and result["ms"] is not None:
            DURATION.labels(target, country).set(result["ms"])
        else:
            _drop(DURATION, target, country)
        if result["code"] is not None:
            STATUS_CODE.labels(target, country).set(result["code"])

    def _forget_removed(self, targets: List[str]) -> None:
        for target in set(self.latest) | set(self._attempted):
            if target in targets:
                continue
            for country in COUNTRIES:
                for gauge in (DURATION, SUCCESS, STATUS_CODE):
                    _drop(gauge, target, country)
            _drop(LAST_RUN, target)
            self.latest.pop(target, None)
            self._attempted.pop(target, None)
