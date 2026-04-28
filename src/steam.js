export async function verifySteamTicket({
  apiKey,
  appIds,
  ticketHex,
  steamId,
  allowInsecure
}) {
  if (allowInsecure && (!apiKey || !appIds?.length)) {
    return {
      ok: true,
      steamId: String(steamId),
      insecure: true
    };
  }

  if (!apiKey || !appIds?.length) {
    throw new Error(
      "Steam ticket verification requires STEAM_WEB_API_KEY and STEAM_APP_ID"
    );
  }

  let lastBody = null;

  for (const appId of appIds) {
    const params = new URLSearchParams({
      key: apiKey,
      appid: String(appId),
      ticket: ticketHex
    });

    const response = await fetch(
      `https://api.steampowered.com/ISteamUserAuth/AuthenticateUserTicket/v1/?${params.toString()}`,
      { method: "GET" }
    );

    const body = await response.json();
    lastBody = body;
    const owner = body?.response?.params?.steamid;
    const result = body?.response?.params?.result;

    if (!response.ok || result !== "OK" || !owner) {
      continue;
    }

    if (String(owner) !== String(steamId)) {
      const error = new Error("Steam ticket did not match the claimed steam_id");
      error.body = body;
      throw error;
    }

    return {
      ok: true,
      steamId: String(owner),
      insecure: false,
      appId: String(appId)
    };
  }

  const error = new Error("Steam ticket verification failed");
  error.body = lastBody;
  throw error;
}
