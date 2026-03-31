#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Monitoring POC - Deinstallation
# ============================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

main() {
    echo ""
    info "Monitoring POC Deinstallation"
    info "=============================="
    echo ""

    if [ ! -f "docker-compose.yml" ]; then
        error "docker-compose.yml nicht gefunden. Bitte aus dem Projektverzeichnis ausfuehren."
    fi

    read -rp "Alle Container und Volumes entfernen? (j/N): " confirm
    if [[ "$confirm" != "j" && "$confirm" != "J" ]]; then
        info "Abgebrochen."
        exit 0
    fi

    info "Container werden gestoppt und entfernt..."
    docker compose down -v

    info "========================================"
    info " Monitoring POC wurde deinstalliert."
    info "========================================"
    echo ""
    info "Das Projektverzeichnis wurde nicht geloescht."
    info "Zum vollstaendigen Entfernen: rm -rf $(pwd)"
    echo ""
}

main
