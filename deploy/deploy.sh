#!/usr/bin/env bash
#
# Deploys this repository to a VPS over SSH. No registry and no CI: the
# committed source is copied to the server and built there.
#
#   export PEBBLE_HOST=root@203.0.113.10     # who to SSH in as
#
#   ./deploy/deploy.sh setup                 # once: install Docker, create /opt/pebble
#   ./deploy/deploy.sh env production.env    # once, and whenever a secret changes
#   ./deploy/deploy.sh                       # every deploy
#
#   ./deploy/deploy.sh status                # containers, and the deployed commit
#   ./deploy/deploy.sh logs [service]        # follow logs (default: api)
#
# A deploy copies HEAD to /opt/pebble/app, builds both images, runs migrations to
# completion and only then replaces the API — the order `docs/migrations.md`
# requires. If migrations fail, the running API is left as it was.

set -euo pipefail

HOST="root@187.126.114.213"
DIR="${PEBBLE_DIR:-/opt/pebble}"
COMPOSE="docker compose -f $DIR/app/deploy/docker-compose.prod.yml --env-file $DIR/.env"

cd "$(git rev-parse --show-toplevel)"

case "${1:-deploy}" in
  setup)
    ssh "$HOST" "set -e
      command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
      mkdir -p $DIR"
    echo "Ready. Next: ./deploy/deploy.sh env <file>"
    ;;

  env)
    file="${2:?usage: deploy.sh env <file>}"
    scp "$file" "$HOST:$DIR/.env"
    ssh "$HOST" "chmod 600 $DIR/.env"
    echo "Uploaded. It takes effect on the next deploy."
    ;;

  deploy)
    # `git archive` sends the commit, not the working tree, so uncommitted
    # changes would silently not be deployed. Refuse instead.
    if [[ -n "$(git status --porcelain)" ]]; then
      echo "Uncommitted changes — commit or stash them first." >&2
      exit 1
    fi

    rev="$(git rev-parse --short HEAD)"
    echo "Deploying $rev to $HOST"

    git archive --format=tar HEAD | ssh "$HOST" "set -e
      test -f $DIR/.env || { echo 'No $DIR/.env — run: deploy.sh env <file>' >&2; exit 1; }
      rm -rf $DIR/app.new && mkdir $DIR/app.new
      tar -x -C $DIR/app.new
      echo $rev > $DIR/app.new/REVISION
      rm -rf $DIR/app && mv $DIR/app.new $DIR/app"

    ssh "$HOST" "set -e
      $COMPOSE up -d --build --wait --remove-orphans
      docker image prune -f >/dev/null"

    echo "Deployed $rev."
    ;;

  status)
    ssh "$HOST" "echo \"Deployed: \$(cat $DIR/app/REVISION)\"; $COMPOSE ps"
    ;;

  logs)
    ssh -t "$HOST" "$COMPOSE logs -f --tail=100 ${2:-api}"
    ;;

  *)
    echo "usage: deploy.sh [setup | env <file> | deploy | status | logs [service]]" >&2
    exit 1
    ;;
esac
