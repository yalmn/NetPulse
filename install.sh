#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# NetPulse - Automatischer Installer
# ============================================================

REPO_URL="https://github.com/yalmn/netpulse.git"
INSTALL_DIR="netpulse"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# --- Eingabe auch bei curl | bash ueber /dev/tty lesen ---
ask() {
    local prompt="$1" answer=""
    if [ -t 0 ]; then
        read -rp "$prompt" answer
    else
        read -rp "$prompt" answer < /dev/tty || answer=""
    fi
    echo "$answer"
}

# --- Docker pruefen / installieren ---
check_docker() {
    if command -v docker &>/dev/null; then
        info "Docker ist bereits installiert: $(docker --version)"
    else
        warn "Docker nicht gefunden. Wird installiert..."
        curl -fsSL https://get.docker.com | sh
        sudo systemctl enable --now docker
        info "Docker wurde installiert."
    fi

    if ! docker compose version &>/dev/null; then
        error "Docker Compose Plugin nicht gefunden. Bitte manuell installieren."
    fi

    info "Docker Compose verfuegbar: $(docker compose version --short)"
}

# --- Repo klonen (falls nicht bereits im Verzeichnis) ---
setup_repo() {
    if [ -f "docker-compose.yml" ]; then
        info "Bereits im Projektverzeichnis."
        return
    fi

    if [ -d "$INSTALL_DIR" ]; then
        info "Verzeichnis '$INSTALL_DIR' existiert bereits. Wird verwendet."
        cd "$INSTALL_DIR"
        return
    fi

    info "Repository wird geklont..."
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
}

# --- Sicheres Passwort generieren ---
generate_password() {
    # 24 Zeichen, nur alphanumerisch (sed-sicher, keine Sonderzeichen)
    if command -v openssl &>/dev/null; then
        openssl rand -hex 12
    else
        head -c 12 /dev/urandom | xxd -p
    fi
}

# --- sed plattformunabhaengig ---
sed_inplace() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
    else
        sed -i "$@"
    fi
}

# --- Variable in .env setzen (ersetzen oder anhaengen) ---
set_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" .env; then
        sed_inplace "s|^${key}=.*|${key}=${value}|" .env
    else
        echo "${key}=${value}" >> .env
    fi
}

# --- Oeffentliche IP als sslip.io-Hostname vorschlagen ---
suggest_host() {
    local ip
    ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "${ip//./-}.sslip.io"
    fi
}

# --- .env erstellen ---
setup_env() {
    if [ ! -f ".env" ]; then
        cp .env.example .env
        info ".env aus .env.example erstellt."
    fi

    # Passwort generieren falls leer oder nicht gesetzt
    source .env
    if [ -z "${GF_ADMIN_PASSWORD:-}" ]; then
        set_env GF_ADMIN_PASSWORD "$(generate_password)"
        info "Passwort wurde automatisch generiert."
    fi

    # Oeffentlicher Hostname fuer HTTPS (Let's Encrypt)
    source .env
    if [ -z "${PUBLIC_HOST:-}" ]; then
        local suggestion custom_host
        suggestion=$(suggest_host)
        echo ""
        info "Hostname fuer HTTPS. Ohne eigene Domain den sslip.io-Vorschlag uebernehmen."
        custom_host=$(ask "Hostname [${suggestion:-z. B. netpulse.example.de}]: ")
        custom_host="${custom_host:-$suggestion}"
        [ -z "$custom_host" ] && error "Kein Hostname angegeben."
        set_env PUBLIC_HOST "$custom_host"
        info "Hostname: ${custom_host}"
    fi

    # Globalping-Token fuer die Laender-Checks (optional)
    source .env
    if [ -z "${GLOBALPING_TOKEN:-}" ]; then
        echo ""
        info "Globalping-Token (kostenlos auf https://dash.globalping.io) erhoeht das Limit fuer die Laender-Checks."
        local token
        token=$(ask "Globalping-Token [leer lassen = ohne Token]: ")
        set_env GLOBALPING_TOKEN "$token"
    fi

    # Dashboard-Name abfragen falls noch Default
    source .env
    if [ "${DASHBOARD_TITLE:-}" = "Monitoring Dashboard" ] || [ -z "${DASHBOARD_TITLE:-}" ]; then
        echo ""
        local custom_title
        custom_title=$(ask "Dashboard-Name [Monitoring Dashboard]: ")
        custom_title="${custom_title:-Monitoring Dashboard}"
        set_env DASHBOARD_TITLE "\"${custom_title}\""
        info "Dashboard-Name: ${custom_title}"
    fi
}

# --- Target-Dateien zuruecksetzen ---
reset_targets() {
    for f in prometheus/targets/urls.json prometheus/targets/https_urls.json prometheus/targets/icmp_targets.json prometheus/targets/geo_targets.json; do
        echo '[]' > "$f"
    done
    info "Target-Dateien zurueckgesetzt (leer)."
}

# --- Dashboard-Titel setzen ---
apply_dashboard_title() {
    source .env
    local title="${DASHBOARD_TITLE:-Monitoring Dashboard}"
    local dashboard="grafana/provisioning/dashboards/monitor-dashboard.json"
    # Dashboard-JSON aus Git zuruecksetzen, damit der Platzhalter wieder da ist
    if git rev-parse --git-dir &>/dev/null; then
        git checkout HEAD -- "$dashboard" 2>/dev/null || true
    fi
    # Nur den Platzhalter __DASHBOARD_TITLE__ ersetzen
    sed_inplace "s/__DASHBOARD_TITLE__/${title}/g" "$dashboard"
    info "Dashboard-Titel gesetzt: ${title}"
}

# --- Services starten ---
start_services() {
    info "Bestehende Container und Volumes werden entfernt..."
    docker compose down -v --remove-orphans 2>/dev/null || true

    info "Services werden gebaut und gestartet..."
    docker compose up -d --build

    local base="https://${PUBLIC_HOST}"
    echo ""
    info "========================================"
    info " NetPulse erfolgreich installiert!"
    info "========================================"
    echo ""
    info "Server (im Dashboard beim Login eintragen): ${base}"
    info "  Grafana:   ${base}/grafana/"
    info "  Web-UI:    ${base}/ui"
    info "  API-Doku:  ${base}/docs"
    echo ""
    info "Login-Daten (Dashboard, API und Grafana):"
    info "  User:     ${GF_ADMIN_USER:-admin}"
    info "  Passwort: ${GF_ADMIN_PASSWORD}"
    warn "Bitte Passwort notieren! Es wird nur einmalig angezeigt."
    echo ""
    warn "Ports 80 und 443 muessen offen sein (bei Ionos: Cloud Panel, Netzwerk, Firewall-Richtlinien)."
    warn "Das Zertifikat holt Caddy beim ersten Aufruf automatisch, das kann bis zu einer Minute dauern."
    info "Dashboard: https://yalmn.github.io/NetPulse/ (Server-Adresse oben beim Login angeben,"
    info "oder dauerhaft als \"apiBase\" in docs/config.json eintragen)."
    echo ""
}

# --- Hauptprogramm ---
main() {
    echo ""
    info "NetPulse Installer"
    info "========================"
    echo ""

    check_docker
    setup_repo
    setup_env
    reset_targets
    apply_dashboard_title

    # .env laden fuer die Ausgabe
    if [ -f ".env" ]; then
        set -a
        source .env
        set +a
    fi

    start_services
}

main
