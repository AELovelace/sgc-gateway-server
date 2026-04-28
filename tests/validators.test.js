import test from "node:test";
import assert from "node:assert/strict";

import {
  buildExternalId,
  buildIdempotencyKey,
  validateRewardEvent
} from "../src/validators.js";

test("buildExternalId namespaces steam IDs", () => {
  assert.equal(buildExternalId("76561198000000000"), "spd:steam:76561198000000000");
});

test("buildIdempotencyKey derives the expected pvp key", () => {
  assert.equal(
    buildIdempotencyKey({
      event_type: "pvp_kill",
      server_instance_id: "srv_1",
      match_id: "match_1",
      victim_steam_id: "victim",
      beneficiary_steam_id: "killer",
      death_seq: 2
    }),
    "pvp-kill:srv_1:match_1:victim:killer:2"
  );
});

test("validateRewardEvent rejects self-kill pvp rewards", () => {
  const result = validateRewardEvent({
    event: {
      event_type: "pvp_kill",
      match_id: "match_1",
      server_instance_id: "srv_1",
      reporter_steam_id: "host",
      beneficiary_steam_id: "host",
      victim_steam_id: "host",
      death_seq: 1,
      occurred_at: "2026-04-28T08:00:30.000Z"
    },
    match: {
      match_id: "match_1",
      host_steam_id: "host",
      created_at: "2026-04-28T08:00:00.000Z",
      participants: { host: {} }
    },
    player: {
      steam_id: "host",
      sgc_link_active: true
    },
    existingEvent: null,
    security: {
      minLevelCompleteMs: 20000,
      maxPveKillsPerMinute: 120,
      maxPvpKillsPerMatch: 100
    },
    recentRewardEvents: []
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_pvp_victim");
});

test("validateRewardEvent flags suspicious pve rate spikes", () => {
  const recentRewardEvents = [];
  for (let i = 0; i < 120; i += 1) {
    recentRewardEvents.push({
      event_type: "pve_kill",
      beneficiary_steam_id: "killer",
      match_id: "match_1",
      occurred_at: "2026-04-28T08:00:10.000Z"
    });
  }

  const result = validateRewardEvent({
    event: {
      event_type: "pve_kill",
      match_id: "match_1",
      server_instance_id: "srv_1",
      reporter_steam_id: "host",
      beneficiary_steam_id: "killer",
      enemy_spawn_id: "enemy_1",
      occurred_at: "2026-04-28T08:00:30.000Z"
    },
    match: {
      match_id: "match_1",
      host_steam_id: "host",
      created_at: "2026-04-28T08:00:00.000Z",
      participants: { killer: {}, host: {} }
    },
    player: {
      steam_id: "killer",
      sgc_link_active: true
    },
    existingEvent: null,
    security: {
      minLevelCompleteMs: 20000,
      maxPveKillsPerMinute: 120,
      maxPvpKillsPerMatch: 100
    },
    recentRewardEvents,
    now: Date.parse("2026-04-28T08:00:40.000Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.suspicious, true);
  assert.deepEqual(result.suspiciousReasons, ["pve_rate_limit_exceeded"]);
});
