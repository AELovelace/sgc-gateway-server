import fs from "node:fs";
import path from "node:path";

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const contents = fs.readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function asBool(value, fallback = false) {
  if (value == null || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeBasePath(value) {
  if (!value || value === "/") {
    return "";
  }

  let normalized = String(value).trim();
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }
  normalized = normalized.replace(/\/+$/, "");
  return normalized === "/" ? "" : normalized;
}

function asStringList(value) {
  if (value == null || String(value).trim() === "") {
    return [];
  }
  return String(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getConfig() {
  return {
    host: process.env.HOST || "0.0.0.0",
    port: asInt(process.env.PORT, 8787),
    publicBaseUrl:
      process.env.PUBLIC_BASE_URL || "https://sadgirlsclub.wtf/gmlapi",
    publicBasePath: normalizeBasePath(process.env.PUBLIC_BASE_PATH || "/gmlapi"),
    storePath: process.env.STORE_PATH || "./data/store.json",
    steam: {
      appIds: asStringList(process.env.STEAM_APP_ID),
      apiKey: process.env.STEAM_WEB_API_KEY || "",
      allowInsecure: asBool(process.env.ALLOW_INSECURE_STEAM_AUTH, false),
      ticketIdentity: process.env.STEAM_TICKET_IDENTITY || "spd-sgc-gateway"
    },
    sgc: {
      baseUrl: process.env.SGC_BASE_URL || "http://127.0.0.1:7788/v1",
      apiKey: process.env.SGC_API_KEY || "",
      bridgeToken: process.env.SGC_BRIDGE_TOKEN || "",
      oauthClientId: process.env.SGC_OAUTH_CLIENT_ID || "",
      oauthClientSecret: process.env.SGC_OAUTH_CLIENT_SECRET || "",
      redirectUri:
        process.env.SGC_REDIRECT_URI ||
        "http://127.0.0.1:8787/sgc/link/callback",
      oauthTokenUrl:
        process.env.SGC_OAUTH_TOKEN_URL || "http://127.0.0.1:7788/oauth/token",
      // If the SGC backend returns authorize URLs that point at its internal
      // host (e.g. http://127.0.0.1:7788), set this to the public origin
      // (e.g. https://sadgirlsclub.wtf) and the gateway will rewrite the
      // origin before handing the URL back to clients.
      oauthPublicBase: process.env.SGC_OAUTH_PUBLIC_BASE || "",
      requestedScope:
        process.env.SGC_REQUESTED_SCOPE || "balance:read coins:debit",
      matchedCompanyStock: process.env.SGC_MATCHED_COMPANY_STOCK || "BBI"
    },
    security: {
      matchTokenTtlMs: asInt(process.env.MATCH_TOKEN_TTL_MS, 6 * 60 * 60 * 1000),
      sessionTtlMs: asInt(process.env.SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
      maxPveKillsPerMinute: asInt(process.env.MAX_PVE_KILLS_PER_MINUTE, 120),
      maxPvpKillsPerMatch: asInt(process.env.MAX_PVP_KILLS_PER_MATCH, 100),
      minLevelCompleteMs: asInt(process.env.MIN_LEVEL_COMPLETE_MS, 20_000)
    }
  };
}
