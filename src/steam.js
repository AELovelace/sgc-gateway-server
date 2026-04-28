export async function verifySteamTicket({
  apiKey,
  appId,
  ticketHex,
  steamId,
  allowInsecure
}) {
  if (allowInsecure && (!apiKey || !appId)) {
    return {
      ok: true,
      steamId: String(steamId),
      insecure: true
    };
  }

  if (!apiKey || !appId) {
    throw new Error(
      "Steam ticket verification requires STEAM_WEB_API_KEY and STEAM_APP_ID"
    );
  }

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
  const owner = body?.response?.params?.steamid;
  const result = body?.response?.params?.result;

  if (!response.ok || result !== "OK" || !owner) {
    const error = new Error("Steam ticket verification failed");
    error.body = body;
    throw error;
  }

  if (String(owner) !== String(steamId)) {
    const error = new Error("Steam ticket did not match the claimed steam_id");
    error.body = body;
    throw error;
  }

  return {
    ok: true,
    steamId: String(owner),
    insecure: false
  };
}
