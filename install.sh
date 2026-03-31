#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Monitoring POC - Automatischer Installer
# ============================================================

REPO_URL="https://github.com/<user>/monitoring-poc.git"
INSTALL_DIR="monitoring-poc"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

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
    # 24 Zeichen, alphanumerisch + Sonderzeichen
    if command -v openssl &>/dev/null; then
        openssl rand -base64 18
    else
        head -c 18 /dev/urandom | base64
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

# --- .env erstellen ---
setup_env() {
    if [ ! -f ".env" ]; then
        cp .env.example .env
        info ".env aus .env.example erstellt."
    fi

    # Passwort generieren falls leer oder nicht gesetzt
    source .env
    if [ -z "${GF_ADMIN_PASSWORD:-}" ]; then
        GF_GENERATED_PW=$(generate_password)
        sed_inplace "s/^GF_ADMIN_PASSWORD=.*/GF_ADMIN_PASSWORD=${GF_GENERATED_PW}/" .env
        info "Grafana-Passwort wurde automatisch generiert."
    fi
}

# --- Services starten ---
start_services() {
    info "Services werden gebaut und gestartet..."
    docker compose up -d --build

    echo ""
    info "========================================"
    info " Monitoring POC erfolgreich installiert!"
    info "========================================"
    echo ""
    info "Erreichbare Services:"
    info "  Web-UI:     http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${APP_PORT:-8000}/ui"
    info "  REST-API:   http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${APP_PORT:-8000}/docs"
    info "  Prometheus: http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${PROMETHEUS_PORT:-9090}"
    info "  Grafana:    http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'localhost'):${GRAFANA_PORT:-3000}"
    echo ""
    info "Grafana Login:"
    info "  User:     ${GF_ADMIN_USER:-admin}"
    info "  Passwort: ${GF_ADMIN_PASSWORD}"
    warn "Bitte Passwort notieren! Es wird nur einmalig angezeigt."
    warn "Zum Aendern: GF_ADMIN_PASSWORD in .env anpassen und 'docker compose up -d' ausfuehren."
    echo ""
}

# --- Hauptprogramm ---
main() {
    echo ""
    info "Monitoring POC Installer"
    info "========================"
    echo ""

    check_docker
    setup_repo
    setup_env

    # .env laden fuer Port-Ausgabe
    if [ -f ".env" ]; then
        set -a
        source .env
        set +a
    fi

    start_services
}

main
