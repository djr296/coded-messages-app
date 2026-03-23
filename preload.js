const { contextBridge } = require("electron");
const codec = require("./shared/codec");

const API_BASE = process.env.CODED_MESSAGES_API_BASE || "http://127.0.0.1:3847";

async function request(path, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

contextBridge.exposeInMainWorld("codedMessages", {
  encode: codec.encode,
  decode: codec.decode
});

contextBridge.exposeInMainWorld("codedApi", {
  baseUrl: API_BASE,
  health: () => request("/health"),
  register: (data) => request("/auth/register", { method: "POST", body: data }),
  login: (data) => request("/auth/login", { method: "POST", body: data }),
  requestPasswordReset: (data) => request("/auth/request-password-reset", { method: "POST", body: data }),
  resetPassword: (data) => request("/auth/reset-password", { method: "POST", body: data }),
  getMe: (token) => request("/me", { token }),
  updateProfile: (token, data) => request("/me/profile", { method: "PATCH", token, body: data }),
  sendFriendRequest: (token, username) => request("/friends/request", { method: "POST", token, body: { username } }),
  getFriendRequests: (token) => request("/friends/requests", { token }),
  acceptFriendRequest: (token, requestId) => request(`/friends/request/${requestId}/accept`, { method: "POST", token }),
  getFriends: (token) => request("/friends", { token }),
  getConversations: (token) => request("/conversations", { token }),
  getMessages: (token, conversationId) => request(`/conversations/${conversationId}/messages`, { token }),
  sendMessage: (token, conversationId, body, displayMode = "coded") =>
    request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      token,
      body: { body, display_mode: displayMode }
    })
});
