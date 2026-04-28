import fs from "node:fs";
import path from "node:path";

function ensureParentDir(filePath) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
}

function defaultState() {
  return {
    players: {},
    sessions: {},
    authChallenges: {},
    oauthStates: {},
    matches: {},
    rewardEvents: {},
    auditLogs: []
  };
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(process.cwd(), filePath);
    ensureParentDir(this.filePath);
    this.state = this.#load();
  }

  #load() {
    if (!fs.existsSync(this.filePath)) {
      return defaultState();
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) {
      return defaultState();
    }

    return {
      ...defaultState(),
      ...JSON.parse(raw)
    };
  }

  save() {
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  upsertPlayer(player) {
    const existing = this.state.players[player.steam_id] || {};
    this.state.players[player.steam_id] = {
      trust_flags: [],
      ...existing,
      ...player
    };
    this.save();
    return this.state.players[player.steam_id];
  }

  getPlayer(steamId) {
    return this.state.players[String(steamId)] || null;
  }

  createSession(session) {
    this.state.sessions[session.session_token] = session;
    this.save();
    return session;
  }

  getSession(token) {
    return this.state.sessions[token] || null;
  }

  createAuthChallenge(challenge) {
    this.state.authChallenges[challenge.nonce] = challenge;
    this.save();
    return challenge;
  }

  consumeAuthChallenge(nonce) {
    const challenge = this.state.authChallenges[nonce] || null;
    if (challenge) {
      delete this.state.authChallenges[nonce];
      this.save();
    }
    return challenge;
  }

  createOauthState(record) {
    this.state.oauthStates[record.state] = record;
    this.save();
    return record;
  }

  consumeOauthState(state) {
    const record = this.state.oauthStates[state] || null;
    if (record) {
      delete this.state.oauthStates[state];
      this.save();
    }
    return record;
  }

  createMatch(match) {
    this.state.matches[match.match_id] = match;
    this.save();
    return match;
  }

  getMatch(matchId) {
    return this.state.matches[matchId] || null;
  }

  updateMatch(matchId, updater) {
    const current = this.getMatch(matchId);
    if (!current) {
      return null;
    }
    const next = typeof updater === "function" ? updater(current) : updater;
    this.state.matches[matchId] = next;
    this.save();
    return next;
  }

  getRewardEvent(idempotencyKey) {
    return this.state.rewardEvents[idempotencyKey] || null;
  }

  saveRewardEvent(event) {
    this.state.rewardEvents[event.idempotency_key] = event;
    this.save();
    return event;
  }

  listRewardEvents() {
    return Object.values(this.state.rewardEvents);
  }

  appendAudit(entry) {
    this.state.auditLogs.push(entry);
    if (this.state.auditLogs.length > 10000) {
      this.state.auditLogs = this.state.auditLogs.slice(-10000);
    }
    this.save();
    return entry;
  }
}
