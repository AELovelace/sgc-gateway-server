# SGC Gateway

This service sits between the GameMaker client and the SadGirlCoin API.

This directory is intended to be its own standalone git repo so you can deploy
it independently from the GameMaker project.

Production is expected to be served behind:

`https://sadgirlsclub.wtf/gmlapi/`

## What it does

- Verifies Steam-authenticated players
- Starts and completes SGC link OAuth
- Tracks match lifecycle for player-hosted games
- Validates reward events conservatively
- Calls `POST /v1/mint` with deterministic idempotency keys
- Retries transient SGC failures without double-paying
- Optionally mirrors issued kill rewards into `POST /v1/bridge/company/payout`

## Quick start

1. Copy `.env.example` to `.env`
2. Fill in the Steam and SadGirlCoin secrets
3. Install dependencies with `npm install`
4. Start the service with `npm start`

The GameMaker integration in this repo expects the default local URL:

`http://127.0.0.1:8787`

For production behind the reverse proxy, point the game at:

`https://sadgirlsclub.wtf/gmlapi`

## Notes

- If `ALLOW_INSECURE_STEAM_AUTH=false`, the gateway requires a valid
  `STEAM_WEB_API_KEY` and verifies Web API tickets with Steam.
- `STEAM_APP_ID` may be a comma-separated list if you want to accept tickets
  from multiple Steam app IDs, for example `480,1234560`.
- The gateway fails fast on startup if the configured SGC app is missing
  `coins:mint` or `can_mint=true`.
- Persistence is JSON-file based to keep the repo light. If you outgrow this,
  replace `src/store.js` with a real database layer.
- If `SGC_BRIDGE_TOKEN` is configured, the gateway will post matched company
  payouts for `pve_kill` and `pvp_kill` after the primary SGC reward is issued.
  The default ticker is `BBI`, configurable via `SGC_MATCHED_COMPANY_STOCK`.
  It does not mirror collectibles or level-complete rewards.
- The Express app is path-prefix aware. Set `PUBLIC_BASE_PATH=/gmlapi` when the
  reverse proxy forwards requests as `/gmlapi/...`.

## Fedora install

On the target Fedora server:

1. Put this folder on the machine as its own repo or plain directory.
2. Edit `.env.example` if you want different defaults before install.
3. Run `sudo ./scripts/install-fedora.sh`
4. Fill in `/opt/sgc-gateway-server/.env` if the installer created it from the template.
5. Start or restart with `sudo systemctl restart sgc-gateway`

Useful commands:

- `sudo systemctl status sgc-gateway`
- `sudo journalctl -u sgc-gateway -f`
- `sudo systemctl enable sgc-gateway`

Network bind defaults:

- `HOST=0.0.0.0`
- `PORT=8787`

Default upstream SGC connection:

- `SGC_BASE_URL=http://127.0.0.1:7788/v1`
- `SGC_OAUTH_TOKEN_URL=http://127.0.0.1:7788/oauth/token`

## Reverse proxy

An nginx snippet is included at:

`deploy/nginx-gmlapi.conf`

Expected production settings:

- `PUBLIC_BASE_URL=https://sadgirlsclub.wtf/gmlapi`
- `PUBLIC_BASE_PATH=/gmlapi`
- `SGC_REDIRECT_URI=https://sadgirlsclub.wtf/gmlapi/sgc/link/callback`
- `SGC_BASE_URL=http://127.0.0.1:7788/v1`
- `SGC_OAUTH_TOKEN_URL=http://127.0.0.1:7788/oauth/token`
