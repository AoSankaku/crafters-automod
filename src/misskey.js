const REQUEST_TIMEOUT_MS = 10_000;

export class MisskeyApiError extends Error {
  constructor(endpoint, status, code) {
    super(`Misskey API ${endpoint} failed (${status}${code ? `, ${code}` : ""}).`);
    this.name = "MisskeyApiError";
    this.endpoint = endpoint;
    this.status = status;
    this.code = code;
  }
}

export class MisskeyApiClient {
  constructor({ baseUrl, token, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/+$/u, "");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  getMe() {
    return this.request("i", {});
  }

  deleteNote(noteId) {
    return this.request("notes/delete", { noteId });
  }

  suspendUser(userId) {
    return this.request("admin/suspend-user", { userId });
  }

  showUser(userId) {
    return this.request("admin/show-user", { userId });
  }

  assignRole(userId, roleId) {
    return this.request("admin/roles/assign", { userId, roleId });
  }

  async request(endpoint, body) {
    const response = await this.fetchImpl(`${this.baseUrl}/api/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "User-Agent": "crafters-automod/0.1.0",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorBody = await readJson(response);
      throw new MisskeyApiError(endpoint, response.status, errorBody?.error?.code);
    }

    if (response.status === 204) return undefined;
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
