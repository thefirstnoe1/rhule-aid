# CFBD scoreboard relay

Dockerized Node 22 singleton service. It subscribes to CFBD GraphQL using `graphql-transport-ws`, stores normalized batches in a SQLite outbox, signs the exact JSON bytes with HMAC-SHA256, and retries POST delivery with an idempotency key. Run exactly one replica against one persistent `/data` volume; this preserves revisions and `sourceEpoch` across normal restarts and prevents duplicate producers.

## Run

```sh
cp .env.example .env
# set CFBD_KEY, CFBD_SEASON, CFBD_SEASON_TYPE, CFBD_WEEK, RELAY_TARGET_URL, RELAY_HMAC_SECRET in .env
docker compose up -d --build
docker compose logs -f relay
```

## Deploy on ion

```sh
ssh noel@ion
sudo mkdir -p /opt/dockerconfigs/cfbdsub
sudo chown noel:noel /opt/dockerconfigs/cfbdsub
cd /opt/dockerconfigs/cfbdsub
git clone <repository-url> .
cp relay/.env.example relay/.env
${EDITOR:-vi} relay/.env
cd relay
docker compose up -d --build
docker compose ps
```

Set `RELAY_DATA_DIR=/data` (compose does this) so `relay-data` persists SQLite state. `RELAY_TARGET_URL` must be HTTPS with exact path `/api/internal/cfbd/events`, without query, hash, or credentials. Never commit `.env` or print secret environment values. Each batch has schema `cfbd-relay:v1` and persisted `sourceEpoch`; requests use `X-Relay-Key-Id` (optional), `X-Relay-Timestamp`, `X-Relay-Nonce`, `X-Relay-Delivery-Id`, and `X-Relay-Signature: v1=<base64url HMAC-SHA256>`.

A `409` removes an outbox row only when the receiver returns JSON with exact `error` value `replayed delivery` or `duplicate delivery`; other `409` conflicts remain queued for intervention.

Update `CFBD_SEASON`, `CFBD_SEASON_TYPE` (`regular`, `postseason`, or `spring`), and `CFBD_WEEK` weekly, then recreate the service: `docker compose up -d --build`.
