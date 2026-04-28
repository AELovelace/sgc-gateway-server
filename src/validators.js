export const REWARD_TYPES = {
  pve_kill: { amount: 1, note: "pve kill reward" },
  level_complete: { amount: 10, note: "level complete reward" },
  pvp_kill: { amount: 5, note: "pvp kill reward" }
};

export function buildExternalId(steamId) {
  return `spd:steam:${steamId}`;
}

export function buildIdempotencyKey(event) {
  switch (event.event_type) {
    case "pve_kill":
      return `pve-kill:${event.server_instance_id}:${event.match_id}:${event.enemy_spawn_id}:${event.beneficiary_steam_id}`;
    case "level_complete":
      return `level-complete:${event.server_instance_id}:${event.run_id}:${event.level_id}:${event.beneficiary_steam_id}`;
    case "pvp_kill":
      return `pvp-kill:${event.server_instance_id}:${event.match_id}:${event.victim_steam_id}:${event.beneficiary_steam_id}:${event.death_seq}`;
    default:
      return "";
  }
}

export function summarizeEvent(event) {
  const reward = REWARD_TYPES[event.event_type];
  return {
    amount: reward.amount,
    note: reward.note,
    idempotencyKey: buildIdempotencyKey(event)
  };
}

export function validateRewardEvent({
  event,
  match,
  player,
  existingEvent,
  security,
  recentRewardEvents,
  now = Date.now()
}) {
  if (!REWARD_TYPES[event.event_type]) {
    return { ok: false, code: "invalid_event_type" };
  }

  if (!match || match.closed_at) {
    return { ok: false, code: "match_not_active" };
  }

  if (!player?.sgc_link_active) {
    return { ok: false, code: "player_not_linked" };
  }

  if (!match.participants?.[event.beneficiary_steam_id]) {
    return { ok: false, code: "beneficiary_not_in_match" };
  }

  if (event.reporter_steam_id !== match.host_steam_id) {
    return { ok: false, code: "reporter_not_match_host" };
  }

  if (existingEvent) {
    return { ok: false, code: "duplicate_event" };
  }

  const occurredAtMs = Date.parse(event.occurred_at);
  if (!Number.isFinite(occurredAtMs)) {
    return { ok: false, code: "invalid_occurred_at" };
  }

  const matchStartedAtMs = Date.parse(match.created_at);
  if (occurredAtMs < matchStartedAtMs) {
    return { ok: false, code: "event_before_match_start" };
  }

  if (occurredAtMs > now + 10000) {
    return { ok: false, code: "event_from_future" };
  }

  if (event.event_type === "pvp_kill") {
    if (
      !event.victim_steam_id ||
      String(event.victim_steam_id) === String(event.beneficiary_steam_id)
    ) {
      return { ok: false, code: "invalid_pvp_victim" };
    }
  }

  if (
    event.event_type === "level_complete" &&
    occurredAtMs - matchStartedAtMs < security.minLevelCompleteMs
  ) {
    return { ok: false, code: "level_complete_too_fast" };
  }

  const suspiciousReasons = [];
  const samePlayerEvents = recentRewardEvents.filter(
    (candidate) =>
      candidate.beneficiary_steam_id === event.beneficiary_steam_id &&
      candidate.match_id === event.match_id &&
      candidate.event_type === event.event_type
  );

  if (event.event_type === "pve_kill") {
    const oneMinuteAgo = now - 60000;
    const recentPveCount = recentRewardEvents.filter(
      (candidate) =>
        candidate.event_type === "pve_kill" &&
        candidate.beneficiary_steam_id === event.beneficiary_steam_id &&
        Date.parse(candidate.occurred_at) >= oneMinuteAgo
    ).length;

    if (recentPveCount >= security.maxPveKillsPerMinute) {
      suspiciousReasons.push("pve_rate_limit_exceeded");
    }
  }

  if (
    event.event_type === "pvp_kill" &&
    samePlayerEvents.length >= security.maxPvpKillsPerMatch
  ) {
    suspiciousReasons.push("pvp_match_cap_exceeded");
  }

  return {
    ok: true,
    suspicious: suspiciousReasons.length > 0,
    suspiciousReasons
  };
}
