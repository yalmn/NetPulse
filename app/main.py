from fastapi import FastAPI, HTTPException, Request, Form
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator
from typing import List, Literal
from pathlib import Path
from urllib.parse import urlparse, quote_plus
import ipaddress
import json
import re
import httpx
import whois
import dns.resolver

app = FastAPI(title="Monitoring Target API")

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

PROMETHEUS_RELOAD_URL = "http://prometheus:9090/-/reload"
PROMETHEUS_QUERY_URL = "http://prometheus:9090/api/v1/query"

TARGET_FILES = {
    "http": Path("/data/urls.json"),
    "https": Path("/data/https_urls.json"),
    "icmp": Path("/data/icmp_targets.json"),
}

LABEL_MAP = {
    "http": "web-check",
    "https": "tls-check",
    "icmp": "ping-check",
}

JOB_MAP = {
    "http": "blackbox_http",
    "https": "blackbox_https",
    "icmp": "blackbox_icmp",
}

HOSTNAME_REGEX = re.compile(
    r"^(?=.{1,253}$)(?!-)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$"
)


class TargetListRequest(BaseModel):
    type: Literal["http", "https", "icmp"]
    targets: List[str] = Field(default_factory=list, min_length=1)

    @field_validator("targets")
    @classmethod
    def validate_targets(cls, values: List[str]) -> List[str]:
        cleaned = []
        for value in values:
            item = value.strip()
            if item:
                cleaned.append(item)

        if not cleaned:
            raise ValueError("At least one target is required")

        return cleaned


class SingleTargetRequest(BaseModel):
    type: Literal["http", "https", "icmp"]
    target: str = Field(..., min_length=1)

    @field_validator("target")
    @classmethod
    def validate_target(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Target must not be empty")
        return cleaned


def validate_http_target(target: str, expected_scheme: str | None = None) -> None:
    parsed = urlparse(target)

    if parsed.scheme not in {"http", "https"}:
        raise HTTPException(
            status_code=400,
            detail="HTTP/HTTPS targets must start with http:// or https://",
        )

    if expected_scheme and parsed.scheme != expected_scheme:
        raise HTTPException(
            status_code=400,
            detail=f"Target must use scheme {expected_scheme}://",
        )

    if not parsed.netloc:
        raise HTTPException(status_code=400, detail="Invalid URL")


def validate_icmp_target(target: str) -> None:
    try:
        ipaddress.ip_address(target)
        return
    except ValueError:
        pass

    if not HOSTNAME_REGEX.match(target):
        raise HTTPException(
            status_code=400,
            detail="ICMP target must be a valid IP address or hostname",
        )


def validate_by_type(target_type: str, target: str) -> None:
    if target_type == "http":
        validate_http_target(target)
    elif target_type == "https":
        validate_http_target(target, expected_scheme="https")
    elif target_type == "icmp":
        validate_icmp_target(target)
    else:
        raise HTTPException(status_code=400, detail="Invalid target type")


def load_targets(file_path: Path) -> dict:
    if not file_path.exists():
        return {"labels": {}, "targets": []}

    try:
        with open(file_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        if isinstance(data, list) and data:
            entry = data[0]
            return {
                "labels": entry.get("labels", {}),
                "targets": entry.get("targets", []),
            }

        return {"labels": {}, "targets": []}
    except Exception:
        return {"labels": {}, "targets": []}


def save_targets(file_path: Path, label_value: str, targets: List[str]) -> None:
    payload = [
        {
            "labels": {
                "service": label_value
            },
            "targets": targets
        }
    ]

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)


def unique_preserve_order(items: List[str]) -> List[str]:
    return list(dict.fromkeys(items))


def get_all_targets_data() -> dict:
    result = {}
    for target_type, file_path in TARGET_FILES.items():
        result[target_type] = load_targets(file_path)
    return result


async def reload_prometheus() -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(PROMETHEUS_RELOAD_URL)

        if response.status_code not in (200, 204):
            raise HTTPException(
                status_code=500,
                detail=f"Prometheus reload failed with status {response.status_code}",
            )
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Could not reach Prometheus for reload: {str(exc)}",
        ) from exc


async def query_prometheus(query: str) -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(PROMETHEUS_QUERY_URL, params={"query": query})
            response.raise_for_status()
            payload = response.json()

        if payload.get("status") != "success":
            return []

        data = payload.get("data", {})
        return data.get("result", [])
    except Exception:
        return []


async def get_status_map(metric_name: str, job_name: str) -> dict[str, str]:
    query = f'{metric_name}{{job="{job_name}"}}'
    results = await query_prometheus(query)

    status_map = {}
    for item in results:
        metric = item.get("metric", {})
        instance = metric.get("instance")
        value = item.get("value", [])

        if instance and len(value) >= 2:
            status_map[instance] = value[1]

    return status_map


async def build_ui_targets_data() -> dict:
    base_data = get_all_targets_data()

    success_maps = {}
    duration_maps = {}
    availability_maps = {}

    for target_type, job_name in JOB_MAP.items():
        success_maps[target_type] = await get_status_map("probe_success", job_name)
        duration_maps[target_type] = await get_status_map("probe_duration_seconds", job_name)
        availability_maps[target_type] = await get_status_map(
            "avg_over_time(probe_success[5m])",
            job_name,
        )

    result = {}

    for target_type, data in base_data.items():
        enriched_targets = []

        for target in data.get("targets", []):
            success_value = success_maps.get(target_type, {}).get(target)
            duration_value = duration_maps.get(target_type, {}).get(target)
            availability_value = availability_maps.get(target_type, {}).get(target)

            if success_value is None:
                status = "unknown"
            elif success_value == "1":
                status = "up"
            else:
                status = "down"

            prom_expr = f'probe_success{{instance="{target}"}}'
            enriched_targets.append(
                {
                    "value": target,
                    "status": status,
                    "probe_success": success_value,
                    "probe_duration_seconds": (
                        round(float(duration_value), 3)
                        if duration_value is not None
                        else None
                    ),
                    "availability_5m": (
                        round(float(availability_value) * 100, 1)
                        if availability_value is not None
                        else None
                    ),
                    "prometheus_link": (
                        f"http://localhost:9090/graph?g0.expr="
                        f"{quote_plus(prom_expr)}"
                        f"&g0.tab=1"
                    ),
                }
            )

        result[target_type] = {
            "labels": data.get("labels", {}),
            "targets": enriched_targets,
        }

    return result


@app.get("/")
def root():
    return {"message": "Monitoring Target API is running"}


@app.get("/targets")
def get_all_targets():
    return get_all_targets_data()


@app.get("/targets/{target_type}")
def get_targets_by_type(target_type: str):
    if target_type not in TARGET_FILES:
        raise HTTPException(status_code=400, detail="Invalid target type")

    return load_targets(TARGET_FILES[target_type])


@app.post("/targets")
async def set_targets(request: TargetListRequest):
    for target in request.targets:
        validate_by_type(request.type, target)

    cleaned_targets = unique_preserve_order(request.targets)
    save_targets(TARGET_FILES[request.type], LABEL_MAP[request.type], cleaned_targets)

    await reload_prometheus()

    return {
        "message": f"{request.type} targets replaced successfully",
        "count": len(cleaned_targets),
        "targets": cleaned_targets,
        "prometheus_reloaded": True,
    }


@app.post("/targets/add")
async def add_target(request: SingleTargetRequest):
    validate_by_type(request.type, request.target)

    current_data = load_targets(TARGET_FILES[request.type])
    current_targets = current_data.get("targets", [])

    if request.target in current_targets:
        return {
            "message": "Target already exists",
            "count": len(current_targets),
            "targets": current_targets,
            "prometheus_reloaded": False,
        }

    updated_targets = unique_preserve_order(current_targets + [request.target])
    save_targets(TARGET_FILES[request.type], LABEL_MAP[request.type], updated_targets)

    await reload_prometheus()

    return {
        "message": "Target added successfully",
        "count": len(updated_targets),
        "targets": updated_targets,
        "prometheus_reloaded": True,
    }


@app.delete("/targets/remove")
async def remove_target(request: SingleTargetRequest):
    current_data = load_targets(TARGET_FILES[request.type])
    current_targets = current_data.get("targets", [])

    if request.target not in current_targets:
        raise HTTPException(status_code=404, detail="Target not found")

    updated_targets = [target for target in current_targets if target != request.target]
    save_targets(TARGET_FILES[request.type], LABEL_MAP[request.type], updated_targets)

    await reload_prometheus()

    return {
        "message": "Target removed successfully",
        "count": len(updated_targets),
        "targets": updated_targets,
        "prometheus_reloaded": True,
    }


@app.post("/prometheus/reload")
async def manual_reload():
    await reload_prometheus()
    return {
        "message": "Prometheus reloaded successfully",
        "prometheus_reloaded": True,
    }


def extract_domain(target: str) -> str:
    parsed = urlparse(target)
    hostname = parsed.hostname if parsed.hostname else target
    return hostname


def do_whois(domain: str) -> dict:
    try:
        w = whois.whois(domain)
        created = w.creation_date
        if isinstance(created, list):
            created = created[0]
        expiry = w.expiration_date
        if isinstance(expiry, list):
            expiry = expiry[0]
        return {
            "domain": domain,
            "registrar": w.registrar or "-",
            "created": str(created) if created else "-",
            "expires": str(expiry) if expiry else "-",
            "name_servers": ", ".join(sorted(set(s.lower() for s in w.name_servers))) if w.name_servers else "-",
            "status": w.status[0] if isinstance(w.status, list) and w.status else (w.status or "-"),
        }
    except Exception as e:
        return {
            "domain": domain,
            "registrar": "-",
            "created": "-",
            "expires": "-",
            "name_servers": "-",
            "status": f"Error: {e}",
        }


def do_nslookup(domain: str) -> list[dict]:
    results = []
    for rdtype in ["A", "AAAA", "MX", "NS", "CNAME", "TXT"]:
        try:
            answers = dns.resolver.resolve(domain, rdtype)
            for rdata in answers:
                value = str(rdata)
                if rdtype == "MX":
                    value = f"{rdata.preference} {rdata.exchange}"
                results.append({"domain": domain, "type": rdtype, "value": value})
        except Exception:
            pass
    if not results:
        results.append({"domain": domain, "type": "-", "value": "No records found"})
    return results


def collect_all_domains() -> list[str]:
    domains = []
    seen = set()
    for target_type, file_path in TARGET_FILES.items():
        data = load_targets(file_path)
        for target in data.get("targets", []):
            domain = extract_domain(target)
            if domain not in seen:
                seen.add(domain)
                domains.append(domain)
    return domains


@app.get("/api/whois")
def api_whois_all():
    domains = collect_all_domains()
    return [do_whois(d) for d in domains]


@app.get("/api/nslookup")
def api_nslookup_all():
    domains = collect_all_domains()
    results = []
    for d in domains:
        results.extend(do_nslookup(d))
    return results


@app.get("/ui")
async def ui_home(request: Request, message: str = "", error: str = ""):
    targets_data = await build_ui_targets_data()

    return templates.TemplateResponse(
        request=request,
        name="index.html",
        context={
            "targets_data": targets_data,
            "message": message,
            "error": error,
        },
    )


@app.post("/ui/add")
async def ui_add_target(
    target_type: str = Form(...),
    target: str = Form(...),
):
    try:
        actual_type = target_type
        if target_type == "http" and target.strip().startswith("https://"):
            actual_type = "https"

        request_data = SingleTargetRequest(type=actual_type, target=target)
        validate_by_type(request_data.type, request_data.target)

        current_data = load_targets(TARGET_FILES[request_data.type])
        current_targets = current_data.get("targets", [])

        if request_data.target not in current_targets:
            updated_targets = unique_preserve_order(current_targets + [request_data.target])
            save_targets(
                TARGET_FILES[request_data.type],
                LABEL_MAP[request_data.type],
                updated_targets,
            )
            await reload_prometheus()
            message = f"Target '{request_data.target}' wurde hinzugefügt."
        else:
            message = f"Target '{request_data.target}' existiert bereits."

        return RedirectResponse(url=f"/ui?message={quote_plus(message)}", status_code=303)

    except HTTPException as exc:
        return RedirectResponse(url=f"/ui?error={quote_plus(str(exc.detail))}", status_code=303)


@app.post("/ui/remove")
async def ui_remove_target(
    target_type: str = Form(...),
    target: str = Form(...),
):
    try:
        request_data = SingleTargetRequest(type=target_type, target=target)

        current_data = load_targets(TARGET_FILES[request_data.type])
        current_targets = current_data.get("targets", [])

        if request_data.target not in current_targets:
            return RedirectResponse(
                url="/ui?error=Target+nicht+gefunden",
                status_code=303,
            )

        updated_targets = [item for item in current_targets if item != request_data.target]
        save_targets(
            TARGET_FILES[request_data.type],
            LABEL_MAP[request_data.type],
            updated_targets,
        )

        await reload_prometheus()

        message = f"Target '{request_data.target}' wurde entfernt."
        return RedirectResponse(url=f"/ui?message={quote_plus(message)}", status_code=303)

    except HTTPException as exc:
        return RedirectResponse(url=f"/ui?error={quote_plus(str(exc.detail))}", status_code=303)