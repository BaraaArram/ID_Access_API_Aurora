#!/usr/bin/env bash
set -euo pipefail

CSV_PATH="${1:-./Sgaza.csv}"
TABLE_NAME="${2:-Sgaza}"

if [[ ! -f .env.vm ]]; then
  echo "Missing .env.vm file. Copy .env.vm.example to .env.vm and edit values."
  exit 1
fi

if [[ ! -f "$CSV_PATH" ]]; then
  echo "CSV not found: $CSV_PATH"
  exit 1
fi

set -a
source .env.vm
set +a

export DATABASE_URL="postgresql://access_api:${POSTGRES_PASSWORD}@localhost:5432/access_api"
export PG_SCHEMA="public"
export PG_TABLE="$TABLE_NAME"
export PG_SSL="false"
export CSV_PATH="$CSV_PATH"

npm run migrate:csv:postgres

echo "Import complete for table $TABLE_NAME"
