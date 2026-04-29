function jsonHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json"
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export class SgcClient {
  constructor(config) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.bridgeToken = config.bridgeToken || "";
    this.oauthClientId = config.oauthClientId;
    this.oauthClientSecret = config.oauthClientSecret;
    this.redirectUri = config.redirectUri;
    this.oauthTokenUrl =
      config.oauthTokenUrl || this.baseUrl.replace(/\/v1$/, "") + "/oauth/token";
    this.requestedScope = config.requestedScope;
  }

  async #request(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...jsonHeaders(this.apiKey),
        ...(options.headers || {})
      }
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const error = new Error(`SGC request failed: ${response.status}`);
      error.status = response.status;
      error.body = body;
      error.retryAfterS = Number(response.headers.get("Retry-After-S") || 0);
      throw error;
    }

    return body;
  }

  getMe() {
    return this.#request("/me", { method: "GET" });
  }

  startLink({ externalId, externalName, state, codeChallenge }) {
    return this.#request("/links/oauth/start", {
      method: "POST",
      body: JSON.stringify({
        client_id: this.oauthClientId,
        redirect_uri: this.redirectUri,
        scope: this.requestedScope,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        external_id: externalId,
        external_name: externalName
      })
    });
  }

  async exchangeOauthCode({ code, codeVerifier }) {
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.oauthClientId,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier
    });

    if (this.oauthClientSecret) {
      params.set("client_secret", this.oauthClientSecret);
    }

    let response;
    try {
      response = await fetch(this.oauthTokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      });
    } catch (cause) {
      const error = new Error(
        `SGC OAuth exchange fetch failed for ${this.oauthTokenUrl}: ${cause.message}`
      );
      error.cause = cause;
      throw error;
    }

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const error = new Error(`SGC OAuth exchange failed: ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return body;
  }

  getBalance(externalId) {
    return this.#request(`/users/${encodeURIComponent(externalId)}/balance`, {
      method: "GET"
    });
  }

  charge({ externalId, amount, note, idempotencyKey }) {
    return this.#request("/charge", {
      method: "POST",
      body: JSON.stringify({
        external_id: externalId,
        amount,
        note,
        idempotency_key: idempotencyKey
      })
    });
  }

  mint({ externalId, amount, note, idempotencyKey }) {
    return this.#request("/mint", {
      method: "POST",
      body: JSON.stringify({
        external_id: externalId,
        amount,
        note,
        idempotency_key: idempotencyKey
      })
    });
  }

  async companyPayout({ stock, amount, note, idempotencyKey }) {
    const response = await fetch(`${this.baseUrl}/bridge/company/payout`, {
      method: "POST",
      headers: {
        ...jsonHeaders(this.bridgeToken),
      },
      body: JSON.stringify({
        stock,
        amount,
        note,
        idempotency_key: idempotencyKey
      })
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) {
      const error = new Error(`SGC bridge payout failed: ${response.status}`);
      error.status = response.status;
      error.body = body;
      error.retryAfterS = Number(response.headers.get("Retry-After-S") || 0);
      throw error;
    }

    return body;
  }
}
