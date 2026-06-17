const { contextBridge, ipcRenderer } = require("electron");
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
  logout: (token) => request("/auth/logout", { method: "POST", token }),
  getMe: (token) => request("/me", { token }),
  heartbeat: (token) => request("/me/heartbeat", { method: "POST", token }),
  updateProfile: (token, data) => request("/me/profile", { method: "PATCH", token, body: data }),
  getSessions: (token) => request("/sessions", { token }),
  revokeSession: (token, sessionId) => request(`/sessions/${sessionId}`, { method: "DELETE", token }),
  revokeOtherSessions: (token) => request("/sessions", { method: "DELETE", token }),
  sendFriendRequest: (token, username) => request("/friends/request", { method: "POST", token, body: { username } }),
  getFriendRequests: (token) => request("/friends/requests", { token }),
  acceptFriendRequest: (token, requestId) => request(`/friends/request/${requestId}/accept`, { method: "POST", token }),
  declineFriendRequest: (token, requestId) => request(`/friends/request/${requestId}/decline`, { method: "POST", token }),
  cancelFriendRequest: (token, requestId) => request(`/friends/request/${requestId}/cancel`, { method: "POST", token }),
  removeFriend: (token, userId) => request(`/friends/${userId}`, { method: "DELETE", token }),
  getBlockedUsers: (token) => request("/blocks", { token }),
  blockUser: (token, userId) => request(`/blocks/${userId}`, { method: "POST", token }),
  unblockUser: (token, userId) => request(`/blocks/${userId}`, { method: "DELETE", token }),
  reportUser: (token, userId, reason) =>
    request(`/reports/${userId}`, { method: "POST", token, body: { reason } }),
  getFriends: (token) => request("/friends", { token }),
  getConversations: (token) => request("/conversations", { token }),
  createGroupConversation: (token, title, memberIds) =>
    request("/conversations/groups", {
      method: "POST",
      token,
      body: { title, member_ids: memberIds }
    }),
  createGroupInvite: (token, conversationId) =>
    request(`/conversations/${conversationId}/invites`, { method: "POST", token }),
  getGroupInvite: (token, inviteToken) => request(`/group-invites/${inviteToken}`, { token }),
  joinGroupInvite: (token, inviteToken) =>
    request(`/group-invites/${inviteToken}/join`, { method: "POST", token }),
  leaveConversation: (token, conversationId) =>
    request(`/conversations/${conversationId}/members/me`, { method: "DELETE", token }),
  getMessages: (token, conversationId) => request(`/conversations/${conversationId}/messages`, { token }),
  sendMessage: (token, conversationId, body, displayMode = "coded", attachment = null) =>
    request(`/conversations/${conversationId}/messages`, {
      method: "POST",
      token,
      body: {
        body,
        display_mode: displayMode,
        attachment_name: attachment ? attachment.name : "",
        attachment_data: attachment ? attachment.data : ""
      }
    }),
  chooseProfileImage: () => ipcRenderer.invoke("pick-profile-image"),
  chooseMessageAttachment: () => ipcRenderer.invoke("pick-message-attachment")
});
