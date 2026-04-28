# SGC Gateway

This service sits between the GameMaker client and the SadGirlCoin API.

This directory is intended to be its own standalone git repo so you can deploy
it independently from the GameMaker project.

## What it does

- Verifies Steam-authenticated players
- Starts and completes SGC link OAuth
- Tracks match lifecycle for player-hosted games
- Validates reward events conservatively
- Calls `POST /v1/mint` with deterministic idempotency keys
- Retries transient SGC failures without double-paying

## Quick start

1. Copy `.env.example` to `.env`
2. Fill in the Steam and SadGirlCoin secrets
3. Install dependencies with `npm install`
4. Start the service with `npm start`

The GameMaker integration in this repo expects the default local URL:

`http://127.0.0.1:8787`

## Notes

- If `ALLOW_INSECURE_STEAM_AUTH=false`, the gateway requires a valid
  `STEAM_WEB_API_KEY` and verifies Web API tickets with Steam.
- The gateway fails fast on startup if the configured SGC app is missing
  `coins:mint` or `can_mint=true`.
- Persistence is JSON-file based to keep the repo light. If you outgrow this,
  replace `src/store.js` with a real database layer.

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
