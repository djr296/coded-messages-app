const { contextBridge, ipcRenderer } = require("electron");
const codec = require("./shared/codec");
const { firebaseConfig } = require("./shared/firebase-config");

const API_BASE = process.env.CODED_MESSAGES_API_BASE || "http://127.0.0.1:3847";
const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";

function firebaseErrorMessage(code) {
  switch (code) {
    case "EMAIL_EXISTS":
      return "Email already in use.";
    case "EMAIL_NOT_FOUND":
    case "INVALID_PASSWORD":
    case "INVALID_LOGIN_CREDENTIALS":
      return "Invalid credentials.";
    case "WEAK_PASSWORD : Password should be at least 6 characters":
    case "WEAK_PASSWORD":
      return "Password must be at least 6 characters.";
    case "TOO_MANY_ATTEMPTS_TRY_LATER":
      return "Too many attempts. Please wait and try again.";
    case "USER_DISABLED":
      return "This account has been disabled.";
    default:
      return code ? code.replace(/_/g, " ").toLowerCase() : "Firebase authentication failed.";
  }
}

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

async function firebaseAuthRequest(endpoint, body) {
  const response = await fetch(`${FIREBASE_AUTH_BASE}/${endpoint}?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = payload && payload.error ? payload.error.message : "";
    throw new Error(firebaseErrorMessage(code));
  }

  return payload;
}

async function createAppSessionFromFirebase(firebasePayload, username = "") {
  return request("/auth/firebase-session", {
    method: "POST",
    body: {
      id_token: firebasePayload.idToken,
      username
    }
  });
}

async function deleteFirebaseAccount(idToken) {
  try {
    await firebaseAuthRequest("accounts:delete", { idToken });
  } catch (_err) {
    // Best-effort cleanup. The visible registration error is more important.
  }
}

async function registerWithFirebase({ email, password, username }) {
  const firebasePayload = await firebaseAuthRequest("accounts:signUp", {
    email,
    password,
    returnSecureToken: true
  });
  try {
    return await createAppSessionFromFirebase(firebasePayload, username);
  } catch (err) {
    await deleteFirebaseAccount(firebasePayload.idToken);
    throw err;
  }
}

async function loginWithFirebase({ email, password }) {
  const firebasePayload = await firebaseAuthRequest("accounts:signInWithPassword", {
    email,
    password,
    returnSecureToken: true
  });
  return createAppSessionFromFirebase(firebasePayload);
}

contextBridge.exposeInMainWorld("codedMessages", {
  encode: codec.encode,
  decode: codec.decode
});

contextBridge.exposeInMainWorld("codedApi", {
  baseUrl: API_BASE,
  health: () => request("/health"),
  authProvider: "firebase",
  register: (data) => registerWithFirebase(data),
  login: (data) => loginWithFirebase(data),
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
  createGroupInvite: (token, conversationId, expiresIn = "24h") =>
    request(`/conversations/${conversationId}/invites`, {
      method: "POST",
      token,
      body: { expires_in: expiresIn }
    }),
  revokeGroupInvites: (token, conversationId) =>
    request(`/conversations/${conversationId}/invites`, { method: "DELETE", token }),
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
