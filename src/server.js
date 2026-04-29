import crypto from "node:crypto";
import express from "express";

import { getConfig } from "./config.js";
import { JsonStore } from "./store.js";
import { SgcClient } from "./sgc-client.js";
import { verifySteamTicket } from "./steam.js";
import {
  summarizeEvent,
  validateRewardEvent,
  buildExternalId,
  countVerifiedPvpKills
} from "./validators.js";

const config = getConfig();
const store = new JsonStore(config.storePath);
const sgc = new SgcClient(config.sgc);
const app = express();
const router = express.Router();

app.use(express.json({ limit: "64kb" }));

function nowIso() {
  return new Date().toISOString();
}

function gatewayLog(scope, detail = {}) {
  console.log(
    `[${nowIso()}] [${scope}] ${JSON.stringify(detail)}`
  );
}

function randomToken(size = 24) {
  return crypto.randomBytes(size).toString("hex");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(value).digest("base64url");
}

function rewriteUrlOrigin(rawUrl, publicBase, loopbackOnly = false) {
  if (!rawUrl || !publicBase) return rawUrl;
  try {
    const target = new URL(rawUrl);
    const base = new URL(publicBase);
    if (loopbackOnly) {
      const isLoopback =
        target.hostname === "127.0.0.1" ||
        target.hostname === "localhost" ||
        target.hostname === "::1";
      if (!isLoopback) return rawUrl;
    }
    if (target.protocol === base.protocol && target.host === base.host) {
      return rawUrl;
    }
    target.protocol = base.protocol;
    target.hostname = base.hostname;
    target.port = base.port;
    return target.toString();
  } catch (_e) {
    return rawUrl;
  }
}

// Normalize OAuth URLs to the configured public origin. This covers both
// loopback URLs like http://127.0.0.1:7788/... and public-host URLs that still
// leak the internal port, like https://sadgirlsclub.wtf:7788/....
function rewriteOauthOrigin(rawUrl, publicBase) {
  const rewritten = rewriteUrlOrigin(rawUrl, publicBase);
  if (!rewritten || !publicBase) return rewritten;

  try {
    const target = new URL(rewritten);
    for (const [key, value] of target.searchParams.entries()) {
      const nested = rewriteUrlOrigin(value, publicBase);
      if (nested !== value) {
        target.searchParams.set(key, nested);
      }
    }
    return target.toString();
  } catch (_e) {
    return rewritten;
  }
}

function sanitizePlayer(player) {
  if (!player) return null;
  return {
    steam_id: player.steam_id,
    external_id: player.external_id,
    last_known_name: player.last_known_name,
    sgc_link_active: Boolean(player.sgc_link_active),
    linked_at: player.linked_at || null,
    trust_flags: player.trust_flags || []
  };
}

function appendAudit(type, detail) {
  store.appendAudit({ type, detail, created_at: nowIso() });
}

function isSyntheticSingleplayerMatchId(matchId) {
  return String(matchId || "").startsWith("sp_match_");
}

function ensureSyntheticSingleplayerMatch(event, session) {
  if (!isSyntheticSingleplayerMatchId(event.match_id)) {
    return store.getMatch(event.match_id);
  }

  let match = store.getMatch(event.match_id);
  if (match) {
    return match;
  }

  if (session.steam_id !== event.reporter_steam_id) {
    return null;
  }

  const createdAt = Number.isFinite(Date.parse(event.occurred_at))
    ? String(event.occurred_at)
    : nowIso();
  const baseMs = Number.isFinite(Date.parse(createdAt))
    ? Date.parse(createdAt)
    : Date.now();

  match = store.createMatch({
    match_id: event.match_id,
    match_token: String(event.match_token || ""),
    host_steam_id: event.reporter_steam_id,
    server_instance_id: event.server_instance_id,
    created_at: createdAt,
    expires_at: new Date(
      baseMs + config.security.matchTokenTtlMs
    ).toISOString(),
    participants: {
      [event.reporter_steam_id]: { joined_at: nowIso(), role: "host" }
    },
    closed_at: null,
    synthetic_singleplayer: true
  });

  appendAudit("singleplayer_match_created", {
    match_id: match.match_id,
    steam_id: event.reporter_steam_id
  });

  return match;
}

async function refreshLinkedPlayer(player) {
  if (!player?.external_id) {
    return player;
  }
  if (player.sgc_link_active) {
    return player;
  }

  try {
    await sgc.getBalance(player.external_id);
    return store.upsertPlayer({
      ...player,
      sgc_link_active: true,
      linked_at: player.linked_at || nowIso()
    });
  } catch (error) {
    if (error.status === 404) {
      return player;
    }
    throw error;
  }
}

function getSessionFromRequest(req) {
  const header = req.get("authorization") || "";
  if (!header.startsWith("Bearer ")) {
    return null;
  }

  const token = header.slice("Bearer ".length).trim();
  const session = store.getSession(token);
  if (!session) return null;
  if (Date.parse(session.expires_at) <= Date.now()) return null;
  return session;
}

function requireSession(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.session = session;
  req.player = store.getPlayer(session.steam_id);
  next();
}

async function verifySgcStartup() {
  if (!config.sgc.oauthClientId) {
    throw new Error(
      "SGC_OAUTH_CLIENT_ID is required for the OAuth link flow"
    );
  }
  if (!config.sgc.redirectUri) {
    throw new Error(
      "SGC_REDIRECT_URI is required and must match the OAuth client's registered redirect URI"
    );
  }
  const me = await sgc.getMe();
  const scopes = new Set(me?.app?.scopes || []);
  if (!scopes.has("coins:mint")) {
    throw new Error("SGC app is missing the coins:mint scope");
  }
  if (!me?.app?.can_mint) {
    throw new Error("SGC app is not mint-authorized (can_mint=false)");
  }
}

function scheduleMintRetry(event, reason) {
  const delayMs = Math.max(reason.retryAfterS || 5, 5) * 1000;
  setTimeout(async () => {
    const latest = store.getRewardEvent(event.idempotency_key);
    if (!latest || latest.status !== "retry") return;

      try {
        const player = store.getPlayer(latest.beneficiary_steam_id);
        const response = await sgc.mint({
        externalId: player.external_id,
        amount: latest.amount,
        note: latest.note,
        idempotencyKey: latest.idempotency_key
      });
        store.saveRewardEvent({
          ...latest,
          status: "issued",
          sgc_response: response,
          issued_at: nowIso()
        });
        await issueMatchedCompanyPayout({
          rewardEvent: store.getRewardEvent(latest.idempotency_key),
          player
        });
        appendAudit("mint_retry_succeeded", {
          idempotency_key: latest.idempotency_key
        });
    } catch (error) {
      appendAudit("mint_retry_failed", {
        idempotency_key: latest.idempotency_key,
        status: error.status || 0
      });
    }
  }, delayMs);
}

function eventQualifiesForBbiMatch(event) {
  return event?.event_type === "pve_kill" || event?.event_type === "pvp_kill";
}

function scheduleCompanyPayoutRetry(event, reason) {
  const delayMs = Math.max(reason.retryAfterS || 5, 5) * 1000;
  gatewayLog("company_payout_retry_scheduled", {
    idempotency_key: event.idempotency_key,
    delay_ms: delayMs,
    status: reason.status || 0
  });
  setTimeout(async () => {
    const latest = store.getCompanyPayoutEvent(event.idempotency_key);
    if (!latest || latest.status !== "retry") return;

    try {
      const rewardEvent = store.getRewardEvent(latest.reward_event_idempotency_key);
      if (!rewardEvent) {
        gatewayLog("company_payout_retry_missing_reward_event", {
          idempotency_key: latest.idempotency_key,
          reward_event_idempotency_key: latest.reward_event_idempotency_key
        });
        appendAudit("company_payout_retry_missing_reward_event", {
          idempotency_key: latest.idempotency_key,
          reward_event_idempotency_key: latest.reward_event_idempotency_key
        });
        return;
      }
      const response = await sgc.companyPayout({
        stock: latest.stock,
        amount: latest.amount,
        note: latest.note,
        idempotencyKey: latest.idempotency_key
      });
      store.saveCompanyPayoutEvent({
        ...latest,
        status: "issued",
        issued_at: nowIso(),
        response
      });
      gatewayLog("company_payout_retry_succeeded", {
        idempotency_key: latest.idempotency_key,
        stock: latest.stock,
        amount: latest.amount
      });
      appendAudit("company_payout_retry_succeeded", {
        idempotency_key: latest.idempotency_key,
        stock: latest.stock,
        amount: latest.amount
      });
    } catch (error) {
      gatewayLog("company_payout_retry_failed", {
        idempotency_key: latest.idempotency_key,
        status: error.status || 0,
        body: error.body || error.message
      });
      appendAudit("company_payout_retry_failed", {
        idempotency_key: latest.idempotency_key,
        status: error.status || 0,
        error_body: error.body || error.message
      });
    }
  }, delayMs);
}

async function issueMatchedCompanyPayout({ rewardEvent, player }) {
  if (!config.sgc.bridgeToken) {
    gatewayLog("company_payout_disabled", {
      reason: "missing_bridge_token",
      reward_event: rewardEvent?.idempotency_key || null
    });
    appendAudit("company_payout_disabled", {
      reason: "missing_bridge_token",
      reward_event_idempotency_key: rewardEvent?.idempotency_key || null
    });
    return { disabled: true };
  }
  if (!eventQualifiesForBbiMatch(rewardEvent)) {
    gatewayLog("company_payout_skipped", {
      reason: "event_type_not_eligible",
      event_type: rewardEvent?.event_type || null,
      reward_event: rewardEvent?.idempotency_key || null
    });
    appendAudit("company_payout_skipped", {
      reason: "event_type_not_eligible",
      event_type: rewardEvent?.event_type || null,
      reward_event_idempotency_key: rewardEvent?.idempotency_key || null
    });
    return { skipped: true };
  }

  const bridgeKey = `${rewardEvent.idempotency_key}:company:${config.sgc.matchedCompanyStock}`;
  const existing = store.getCompanyPayoutEvent(bridgeKey);
  if (existing && (existing.status === "issued" || existing.status === "pending" || existing.status === "retry")) {
    gatewayLog("company_payout_existing", {
      idempotency_key: bridgeKey,
      status: existing.status
    });
    appendAudit("company_payout_existing", {
      idempotency_key: bridgeKey,
      status: existing.status
    });
    return existing;
  }

  const note = `matched ${rewardEvent.event_type} payout for ${rewardEvent.beneficiary_steam_id}`;
  gatewayLog("company_payout_requesting", {
    idempotency_key: bridgeKey,
    stock: config.sgc.matchedCompanyStock,
    amount: rewardEvent.amount,
    event_type: rewardEvent.event_type,
    beneficiary_steam_id: rewardEvent.beneficiary_steam_id,
    player_external_id: player?.external_id || null
  });
  appendAudit("company_payout_requesting", {
    idempotency_key: bridgeKey,
    stock: config.sgc.matchedCompanyStock,
    amount: rewardEvent.amount,
    event_type: rewardEvent.event_type,
    beneficiary_steam_id: rewardEvent.beneficiary_steam_id
  });
  const bridgeEvent = store.saveCompanyPayoutEvent({
    idempotency_key: bridgeKey,
    reward_event_idempotency_key: rewardEvent.idempotency_key,
    steam_id: rewardEvent.beneficiary_steam_id,
    stock: config.sgc.matchedCompanyStock,
    event_type: rewardEvent.event_type,
    amount: rewardEvent.amount,
    note,
    status: "pending",
    created_at: nowIso()
  });

  try {
    const response = await sgc.companyPayout({
      stock: bridgeEvent.stock,
      amount: bridgeEvent.amount,
      note: bridgeEvent.note,
      idempotencyKey: bridgeEvent.idempotency_key
    });
    const issued = store.saveCompanyPayoutEvent({
      ...bridgeEvent,
      status: "issued",
      issued_at: nowIso(),
      response
    });
    gatewayLog("company_payout_succeeded", {
      idempotency_key: issued.idempotency_key,
      stock: issued.stock,
      amount: issued.amount,
      response
    });
    appendAudit("company_payout_succeeded", {
      idempotency_key: issued.idempotency_key,
      stock: issued.stock,
      amount: issued.amount,
      response
    });
    return issued;
  } catch (error) {
    const retryable = error.status === 429 || error.status >= 500;
    const failed = store.saveCompanyPayoutEvent({
      ...bridgeEvent,
      status: retryable ? "retry" : "rejected",
      error_status: error.status || 0,
      error_body: error.body || error.message
    });

    if (retryable) {
      scheduleCompanyPayoutRetry(failed, error);
    }

    gatewayLog("company_payout_failed", {
      idempotency_key: failed.idempotency_key,
      stock: failed.stock,
      amount: failed.amount,
      retryable,
      status: error.status || 0,
      body: error.body || error.message
    });
    appendAudit("company_payout_failed", {
      idempotency_key: failed.idempotency_key,
      retryable,
      status: error.status || 0,
      error_body: error.body || error.message,
      stock: failed.stock,
      amount: failed.amount
    });
    return failed;
  }
}

router.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: nowIso() });
});

router.post("/auth/steam/start", (req, res) => {
  const steamId = String(req.body?.steam_id || "").trim();
  const personaName = String(req.body?.persona_name || "").trim();
  if (!steamId) {
    res.status(400).json({ error: "steam_id_required" });
    return;
  }

  const nonce = randomToken(16);
  store.createAuthChallenge({
    nonce,
    steam_id: steamId,
    persona_name: personaName,
    created_at: nowIso()
  });

  res.json({
    nonce,
    identity: config.steam.ticketIdentity
  });
});

router.post("/auth/steam/finish", async (req, res) => {
  try {
    const steamId = String(req.body?.steam_id || "").trim();
    const personaName = String(req.body?.persona_name || "").trim();
    const ticketHex = String(req.body?.ticket_hex || "").trim();
    const nonce = String(req.body?.nonce || "").trim();

    // ticket_hex may be empty when the gateway is intentionally running in
    // insecure dev mode; the verifier will short-circuit in that case.
    if (!steamId || !nonce || (!ticketHex && !config.steam.allowInsecure)) {
      res.status(400).json({ error: "steam_finish_payload_invalid" });
      return;
    }

    const challenge = store.consumeAuthChallenge(nonce);
    if (!challenge || String(challenge.steam_id) !== steamId) {
      res.status(400).json({ error: "invalid_auth_nonce" });
      return;
    }

    const verification = await verifySteamTicket({
      apiKey: config.steam.apiKey,
      appIds: config.steam.appIds,
      ticketHex,
      steamId,
      allowInsecure: config.steam.allowInsecure
    });

    let player = store.upsertPlayer({
      steam_id: steamId,
      external_id: buildExternalId(steamId),
      last_known_name: personaName || challenge.persona_name || steamId,
      trust_flags: verification.insecure ? ["steam_auth_insecure"] : []
    });
    player = await refreshLinkedPlayer(player);

    const session = store.createSession({
      session_token: randomToken(24),
      steam_id: steamId,
      created_at: nowIso(),
      expires_at: new Date(
        Date.now() + config.security.sessionTtlMs
      ).toISOString()
    });

    appendAudit("steam_auth_succeeded", {
      steam_id: steamId,
      insecure: verification.insecure
    });

    res.json({
      session_token: session.session_token,
      player: sanitizePlayer(player)
    });
  } catch (error) {
    res.status(401).json({
      error: "steam_auth_failed",
      details: error.body || error.message
    });
  }
});

router.post("/sgc/link/start", requireSession, async (req, res) => {
  try {
    const player = req.player;
    const state = randomToken(12);
    const codeVerifier = randomToken(24);
    const codeChallenge = sha256Base64Url(codeVerifier);

    store.createOauthState({
      state,
      steam_id: player.steam_id,
      code_verifier: codeVerifier,
      created_at: nowIso()
    });

    const payload = await sgc.startLink({
      externalId: player.external_id,
      externalName: player.last_known_name,
      state,
      codeChallenge
    });

    const authorizeUrl = rewriteOauthOrigin(
      payload?.oauth?.authorize_url,
      config.sgc.oauthPublicBase
    );

    res.json({
      state,
      authorize_url: authorizeUrl,
      fallback: payload?.fallback || null
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: "sgc_link_start_failed",
      details: error.body || error.message
    });
  }
});

router.get("/sgc/link/callback", async (req, res) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const oauthState = store.consumeOauthState(state);
    if (!code || !oauthState) {
      res.status(400).send("Invalid or expired link state.");
      return;
    }

    await sgc.exchangeOauthCode({
      code,
      codeVerifier: oauthState.code_verifier
    });

    const player = store.getPlayer(oauthState.steam_id);
    store.upsertPlayer({
      ...player,
      sgc_link_active: true,
      linked_at: nowIso()
    });

    appendAudit("sgc_link_succeeded", {
      steam_id: oauthState.steam_id
    });

    res.status(200).send("SadGirlCoin link complete. You can return to the game now.");
  } catch (error) {
    res.status(error.status || 500).send(`SadGirlCoin link failed: ${error.message}`);
  }
});

router.get("/sgc/link/status", requireSession, (req, res) => {
  const player = store.getPlayer(req.session.steam_id);
  res.json({
    linked: Boolean(player?.sgc_link_active),
    player: sanitizePlayer(player)
  });
});

router.get("/sgc/balance", requireSession, async (req, res) => {
  try {
    const player = await refreshLinkedPlayer(req.player);
    if (!player?.sgc_link_active) {
      res.status(400).json({ error: "player_not_linked" });
      return;
    }

    const balance = await sgc.getBalance(player.external_id);
    res.json(balance);
  } catch (error) {
    res.status(error.status || 500).json({
      error: "sgc_balance_failed",
      details: error.body || error.message
    });
  }
});

router.get("/leaderboards/summary", requireSession, (req, res) => {
  const verifiedMpKills = countVerifiedPvpKills(
    store.listRewardEvents(),
    req.session.steam_id
  );

  res.json({
    steam_id: req.session.steam_id,
    verified_mp_kills_total: verifiedMpKills
  });
});

router.post("/matches/create", requireSession, (req, res) => {
  const match = store.createMatch({
    match_id: `match_${randomToken(8)}`,
    match_token: randomToken(18),
    host_steam_id: req.session.steam_id,
    server_instance_id: `srv_${randomToken(8)}`,
    created_at: nowIso(),
    expires_at: new Date(
      Date.now() + config.security.matchTokenTtlMs
    ).toISOString(),
    participants: {
      [req.session.steam_id]: { joined_at: nowIso(), role: "host" }
    },
    closed_at: null
  });

  appendAudit("match_created", {
    match_id: match.match_id,
    host_steam_id: match.host_steam_id
  });

  res.json({ match });
});

router.post("/matches/join", requireSession, (req, res) => {
  const matchId = String(req.body?.match_id || "").trim();
  const match = store.getMatch(matchId);
  if (!match || match.closed_at) {
    res.status(404).json({ error: "match_not_found" });
    return;
  }

  const updated = store.updateMatch(matchId, (current) => ({
    ...current,
    participants: {
      ...current.participants,
      [req.session.steam_id]: {
        joined_at: nowIso(),
        role: req.session.steam_id === current.host_steam_id ? "host" : "player"
      }
    }
  }));

  appendAudit("match_joined", {
    match_id: matchId,
    steam_id: req.session.steam_id
  });

  res.json({ match: updated });
});

router.post("/matches/report-event", requireSession, async (req, res) => {
  try {
    const event = {
      ...req.body,
      reporter_steam_id: String(req.body?.reporter_steam_id || ""),
      beneficiary_steam_id: String(req.body?.beneficiary_steam_id || ""),
      victim_steam_id: req.body?.victim_steam_id
        ? String(req.body.victim_steam_id)
        : undefined,
      enemy_spawn_id: req.body?.enemy_spawn_id
        ? String(req.body.enemy_spawn_id)
        : undefined,
      match_id: String(req.body?.match_id || ""),
      server_instance_id: String(req.body?.server_instance_id || ""),
      level_id: req.body?.level_id ? String(req.body.level_id) : undefined,
      run_id: req.body?.run_id ? String(req.body.run_id) : "default",
      death_seq: req.body?.death_seq ? Number(req.body.death_seq) : undefined,
      amount: req.body?.amount != null ? Number(req.body.amount) : undefined,
      collectible_id: req.body?.collectible_id
        ? String(req.body.collectible_id)
        : undefined,
      occurred_at: String(req.body?.occurred_at || "")
    };

    if (req.session.steam_id !== event.reporter_steam_id) {
      res.status(403).json({ error: "reporter_session_mismatch" });
      return;
    }

    const match = ensureSyntheticSingleplayerMatch(event, req.session);
    if (!match) {
      res.status(404).json({ error: "match_not_found" });
      return;
    }

    if (String(req.body?.match_token || "") !== String(match.match_token)) {
      res.status(403).json({ error: "invalid_match_token" });
      return;
    }

    if (event.server_instance_id !== match.server_instance_id) {
      res.status(403).json({ error: "server_instance_mismatch" });
      return;
    }

    const player = await refreshLinkedPlayer(
      store.getPlayer(event.beneficiary_steam_id)
    );
    const recentEvents = store
      .listRewardEvents()
      .filter((candidate) => candidate.status !== "rejected");

    const initialValidation = validateRewardEvent({
      event,
      match,
      player,
      existingEvent: null,
      security: config.security,
      recentRewardEvents: recentEvents
    });

    if (!initialValidation.ok) {
      res.status(initialValidation.code === "duplicate_event" ? 409 : 400).json({
        error: initialValidation.code
      });
      return;
    }

    const rewardSummary = summarizeEvent(event);
    const existing = store.getRewardEvent(rewardSummary.idempotencyKey);
    if (existing) {
      res.status(409).json({ error: "duplicate_event" });
      return;
    }

    const rewardEvent = {
      ...event,
      amount: rewardSummary.amount,
      note: rewardSummary.note,
      idempotency_key: rewardSummary.idempotencyKey,
      status: initialValidation.suspicious ? "held" : "pending",
      suspicious_reasons: initialValidation.suspicious ? initialValidation.suspiciousReasons : [],
      created_at: nowIso()
    };

    store.saveRewardEvent(rewardEvent);

    if (initialValidation.suspicious) {
      appendAudit("reward_held", {
        idempotency_key: rewardEvent.idempotency_key,
        reasons: rewardEvent.suspicious_reasons
      });
      res.status(202).json({ ok: true, status: "held", reward_event: rewardEvent });
      return;
    }

    try {
      const mintResponse = await sgc.mint({
        externalId: player.external_id,
        amount: rewardEvent.amount,
        note: rewardEvent.note,
        idempotencyKey: rewardEvent.idempotency_key
      });

      const issued = store.saveRewardEvent({
        ...rewardEvent,
        status: "issued",
        issued_at: nowIso(),
        sgc_response: mintResponse
      });

      const bridgeResult = await issueMatchedCompanyPayout({
        rewardEvent: issued,
        player
      });

      appendAudit("reward_issued", {
        idempotency_key: issued.idempotency_key,
        steam_id: issued.beneficiary_steam_id,
        amount: issued.amount
      });

      res.json({
        ok: true,
        status: "issued",
        reward_event: issued,
        company_payout_event: bridgeResult
      });
    } catch (error) {
      const retryable = error.status === 429 || error.status >= 500;
      const failed = store.saveRewardEvent({
        ...rewardEvent,
        status: retryable ? "retry" : "rejected",
        error_status: error.status || 0,
        error_body: error.body || error.message
      });

      if (retryable) {
        scheduleMintRetry(failed, error);
      }

      appendAudit("reward_issue_failed", {
        idempotency_key: failed.idempotency_key,
        retryable
      });

      res.status(retryable ? 202 : error.status || 500).json({
        ok: retryable,
        status: failed.status,
        reward_event: failed
      });
    }
  } catch (error) {
    res.status(500).json({
      error: "reward_report_failed",
      details: error.message
    });
  }
});

router.post("/matches/close", requireSession, (req, res) => {
  const matchId = String(req.body?.match_id || "").trim();
  const match = store.getMatch(matchId);
  if (!match) {
    res.status(404).json({ error: "match_not_found" });
    return;
  }

  if (match.host_steam_id !== req.session.steam_id) {
    res.status(403).json({ error: "only_host_can_close_match" });
    return;
  }

  const updated = store.updateMatch(matchId, (current) => ({
    ...current,
    closed_at: nowIso()
  }));

  appendAudit("match_closed", { match_id: matchId });
  res.json({ match: updated });
});

router.get("/rewards/history", requireSession, (req, res) => {
  const events = store
    .listRewardEvents()
    .filter(
      (event) =>
        event.beneficiary_steam_id === req.session.steam_id ||
        event.reporter_steam_id === req.session.steam_id
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

  res.json({ events });
});

if (config.publicBasePath) {
  app.use(config.publicBasePath, router);
} else {
  app.use(router);
}

app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    ts: nowIso(),
    public_base_path: config.publicBasePath || "/"
  });
});

async function main() {
  if (!config.sgc.baseUrl || !config.sgc.apiKey) {
    throw new Error("SGC_BASE_URL and SGC_API_KEY are required");
  }

  await verifySgcStartup();

  app.listen(config.port, config.host, () => {
    console.log(
      `SGC gateway listening on ${config.host}:${config.port} as ${config.publicBaseUrl}`
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
