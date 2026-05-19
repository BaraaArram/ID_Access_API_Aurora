#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git ufw

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
fi

sudo usermod -aG docker "$USER"

if ! docker compose version >/dev/null 2>&1; then
  sudo apt-get install -y docker-compose-plugin
fi

# Open API port and SSH
sudo ufw allow 22/tcp || true
sudo ufw allow 5085/tcp || true
sudo ufw --force enable || true

echo "Bootstrap complete. Log out and back in so docker group applies."
