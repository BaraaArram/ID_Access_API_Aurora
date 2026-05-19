#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env.vm ]]; then
  echo "Missing .env.vm file. Copy .env.vm.example to .env.vm and edit values."
  exit 1
fi

set -a
source .env.vm
set +a

docker compose -f docker-compose.oracle.yml --env-file .env.vm up -d

echo "Deployed. Health check URL: http://<VM_PUBLIC_IP>:5085/health"
