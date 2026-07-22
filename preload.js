const { contextBridge, ipcRenderer } = require("electron");
const crypto = require("crypto");
const codec = require("./shared/codec");
const { firebaseConfig } = require("./shared/firebase-config");

const API_BASE = process.env.CODED_MESSAGES_API_BASE || "http://127.0.0.1:3847";
const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
let firebaseAuthState = null;

function nowIso() {
  return new Date().toISOString();
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function pairId(a, b) {
  return [String(a), String(b)].sort().join("_");
}

function userFromFirebaseProfile(fields = {}, uid = "") {
  return {
    id: uid || firestoreScalar(fields.uid),
    app_user_id: Number(firestoreScalar(fields.app_user_id) || 0),
    email: firestoreScalar(fields.email) || "",
    username: firestoreScalar(fields.username) || "",
    profile_image_path: firestoreScalar(fields.profile_image_path) || "",
    last_seen_at: firestoreScalar(fields.last_seen_at) || "",
    online: false
  };
}

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

function firestoreValue(value) {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    return Number.isInteger(value)
      ? { integerValue: String(value) }
      : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => firestoreValue(item)) } };
  }
  return { stringValue: String(value) };
}

function firestoreFields(object) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, firestoreValue(value)])
  );
}

function firestoreScalar(value) {
  if (!value) {
    return "";
  }
  if (Object.prototype.hasOwnProperty.call(value, "stringValue")) return value.stringValue;
  if (Object.prototype.hasOwnProperty.call(value, "integerValue")) return Number(value.integerValue);
  if (Object.prototype.hasOwnProperty.call(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.prototype.hasOwnProperty.call(value, "booleanValue")) return !!value.booleanValue;
  if (Object.prototype.hasOwnProperty.call(value, "nullValue")) return null;
  if (value.arrayValue) return (value.arrayValue.values || []).map((item) => firestoreScalar(item));
  return "";
}

function docId(name) {
  return String(name || "").split("/").pop();
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

async function firestorePatch(path, idToken, data) {
  const updateMask = Object.keys(data)
    .map((key) => `updateMask.fieldPaths=${encodeURIComponent(key)}`)
    .join("&");
  const response = await fetch(`${FIRESTORE_BASE}/${path}?${updateMask}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({ fields: firestoreFields(data) })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error ? payload.error.message : "Could not update Firebase profile.";
    throw new Error(message);
  }
  return payload;
}

async function firestoreGet(path, idToken = firebaseAuthState && firebaseAuthState.idToken) {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${idToken}` }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error ? payload.error.message : "Could not read Firebase data.";
    throw new Error(message);
  }
  return payload;
}

async function firestoreDelete(path, idToken = firebaseAuthState && firebaseAuthState.idToken) {
  const response = await fetch(`${FIRESTORE_BASE}/${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` }
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message = payload && payload.error ? payload.error.message : "Could not delete Firebase data.";
    throw new Error(message);
  }
  return { ok: true };
}

async function firestoreQuery(collectionId, filters = [], orderBy = []) {
  const structuredQuery = {
    from: [{ collectionId }],
    where: filters.length
      ? {
          compositeFilter: {
            op: "AND",
            filters: filters.map(([field, op, value]) => ({
              fieldFilter: {
                field: { fieldPath: field },
                op,
                value: firestoreValue(value)
              }
            }))
          }
        }
      : undefined,
    orderBy: orderBy.map(([field, direction]) => ({
      field: { fieldPath: field },
      direction
    }))
  };

  const response = await fetch(`${FIRESTORE_BASE}:runQuery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${firebaseAuthState.idToken}`
    },
    body: JSON.stringify({ structuredQuery })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error ? payload.error.message : "Could not query Firebase data.";
    throw new Error(message);
  }
  return payload
    .filter((row) => row.document)
    .map((row) => ({
      id: docId(row.document.name),
      fields: row.document.fields || {}
    }));
}

async function mirrorProfileToFirestore(user, authState = firebaseAuthState) {
  if (!authState || !authState.idToken || !authState.localId || !user) {
    return;
  }

  const now = new Date().toISOString();
  await firestorePatch(`users/${encodeURIComponent(authState.localId)}`, authState.idToken, {
    uid: authState.localId,
    app_user_id: Number(user.id),
    email: user.email || authState.email || "",
    username: user.username || "",
    username_lower: String(user.username || "").toLowerCase(),
    profile_image_path: user.profile_image_path || "",
    last_seen_at: user.last_seen_at || "",
    updated_at: now
  });
}

async function createAppSessionFromFirebase(firebasePayload, username = "") {
  const session = await request("/auth/firebase-session", {
    method: "POST",
    body: {
      id_token: firebasePayload.idToken,
      username
    }
  });
  firebaseAuthState = {
    idToken: firebasePayload.idToken,
    refreshToken: firebasePayload.refreshToken || "",
    localId: firebasePayload.localId || "",
    email: firebasePayload.email || ""
  };
  const firebaseUser = {
    ...session.user,
    id: firebaseAuthState.localId,
    app_user_id: session.user.id
  };
  await mirrorProfileToFirestore(firebaseUser, firebaseAuthState);
  return { ...session, user: firebaseUser };
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

async function logoutEverywhere(token) {
  try {
    if (token) {
      await request("/auth/logout", { method: "POST", token });
    }
  } finally {
    firebaseAuthState = null;
  }
}

async function updateProfileEverywhere(token, data) {
  const response = await request("/me/profile", { method: "PATCH", token, body: data });
  const firebaseUser = firebaseAuthState
    ? { ...response.user, id: firebaseAuthState.localId, app_user_id: response.user.id }
    : response.user;
  await mirrorProfileToFirestore(firebaseUser);
  return { ...response, user: firebaseUser };
}

function requireFirebaseAuth() {
  if (!firebaseAuthState || !firebaseAuthState.idToken || !firebaseAuthState.localId) {
    throw new Error("Please sign in again.");
  }
  return firebaseAuthState;
}

async function getFirebaseUser(uid) {
  const doc = await firestoreGet(`users/${encodeURIComponent(uid)}`);
  return userFromFirebaseProfile(doc.fields || {}, uid);
}

async function findFirebaseUserByUsername(username) {
  const normalized = String(username || "").trim().toLowerCase();
  if (!normalized) {
    throw new Error("Username is required.");
  }
  const rows = await firestoreQuery("users", [["username_lower", "EQUAL", normalized]]);
  if (!rows.length) {
    throw new Error("User not found.");
  }
  return userFromFirebaseProfile(rows[0].fields, rows[0].id);
}

async function getCurrentFirebaseProfile() {
  const auth = requireFirebaseAuth();
  const user = await getFirebaseUser(auth.localId);
  return { user };
}

async function firebaseHeartbeat() {
  const auth = requireFirebaseAuth();
  await firestorePatch(`users/${encodeURIComponent(auth.localId)}`, auth.idToken, {
    last_seen_at: nowIso(),
    updated_at: nowIso()
  });
  return { ok: true };
}

async function getFirebaseFriends() {
  const auth = requireFirebaseAuth();
  const rows = await firestoreQuery("friendships", [["user_ids", "ARRAY_CONTAINS", auth.localId]]);
  const friends = [];
  for (const row of rows) {
    const userIds = firestoreScalar(row.fields.user_ids) || [];
    const friendUid = userIds.find((uid) => uid !== auth.localId);
    if (!friendUid) continue;
    const friend = await getFirebaseUser(friendUid);
    friends.push({
      friendship_id: row.id,
      user_id: friend.id,
      username: friend.username,
      profile_image_path: friend.profile_image_path,
      last_seen_at: friend.last_seen_at,
      online: false,
      conversation_id: pairId(auth.localId, friendUid)
    });
  }
  return { friends };
}

async function sendFirebaseFriendRequest(_token, username) {
  const auth = requireFirebaseAuth();
  const target = await findFirebaseUserByUsername(username);
  if (target.id === auth.localId) {
    throw new Error("You cannot add yourself.");
  }
  const friendshipId = pairId(auth.localId, target.id);
  try {
    await firestoreGet(`friendships/${friendshipId}`);
    throw new Error("You are already friends.");
  } catch (err) {
    if (!String(err.message || "").includes("not found")) {
      throw err;
    }
  }
  const requestId = `${auth.localId}_${target.id}`;
  await firestorePatch(`friendRequests/${requestId}`, auth.idToken, {
    from_uid: auth.localId,
    to_uid: target.id,
    status: "pending",
    created_at: nowIso(),
    responded_at: ""
  });
  return { ok: true };
}

async function getFirebaseFriendRequests() {
  const auth = requireFirebaseAuth();
  const incomingRows = await firestoreQuery("friendRequests", [
    ["to_uid", "EQUAL", auth.localId],
    ["status", "EQUAL", "pending"]
  ]);
  const outgoingRows = await firestoreQuery("friendRequests", [
    ["from_uid", "EQUAL", auth.localId],
    ["status", "EQUAL", "pending"]
  ]);
  const requests = [];
  for (const row of incomingRows) {
    const fromUid = firestoreScalar(row.fields.from_uid);
    const user = await getFirebaseUser(fromUid);
    requests.push({
      id: row.id,
      from_user_id: user.id,
      username: user.username,
      profile_image_path: user.profile_image_path,
      created_at: firestoreScalar(row.fields.created_at)
    });
  }
  const outgoing = [];
  for (const row of outgoingRows) {
    const toUid = firestoreScalar(row.fields.to_uid);
    const user = await getFirebaseUser(toUid);
    outgoing.push({
      id: row.id,
      to_user_id: user.id,
      username: user.username,
      profile_image_path: user.profile_image_path,
      created_at: firestoreScalar(row.fields.created_at)
    });
  }
  return { requests, outgoing };
}

async function acceptFirebaseFriendRequest(_token, requestId) {
  const auth = requireFirebaseAuth();
  const reqDoc = await firestoreGet(`friendRequests/${encodeURIComponent(requestId)}`);
  const fromUid = firestoreScalar(reqDoc.fields.from_uid);
  const toUid = firestoreScalar(reqDoc.fields.to_uid);
  if (toUid !== auth.localId) {
    throw new Error("Friend request not found.");
  }
  const friendshipId = pairId(fromUid, toUid);
  const now = nowIso();
  await firestorePatch(`friendRequests/${encodeURIComponent(requestId)}`, auth.idToken, {
    status: "accepted",
    responded_at: now
  });
  await firestorePatch(`friendships/${friendshipId}`, auth.idToken, {
    user_a_id: friendshipId.split("_")[0],
    user_b_id: friendshipId.split("_")[1],
    user_ids: friendshipId.split("_"),
    created_at: now
  });
  await firestorePatch(`conversations/${friendshipId}`, auth.idToken, {
    id: friendshipId,
    type: "direct",
    title: "",
    member_ids: friendshipId.split("_"),
    created_by_user_id: fromUid,
    created_at: now,
    updated_at: now
  });
  return { ok: true };
}

async function updateFirebaseFriendRequest(_token, requestId, status) {
  const auth = requireFirebaseAuth();
  const reqDoc = await firestoreGet(`friendRequests/${encodeURIComponent(requestId)}`);
  const fromUid = firestoreScalar(reqDoc.fields.from_uid);
  const toUid = firestoreScalar(reqDoc.fields.to_uid);
  if ((status === "declined" && toUid !== auth.localId) || (status === "cancelled" && fromUid !== auth.localId)) {
    throw new Error("Friend request not found.");
  }
  await firestorePatch(`friendRequests/${encodeURIComponent(requestId)}`, auth.idToken, {
    status,
    responded_at: nowIso()
  });
  return { ok: true };
}

async function removeFirebaseFriend(_token, userId) {
  const auth = requireFirebaseAuth();
  const id = pairId(auth.localId, userId);
  await firestoreDelete(`friendships/${id}`);
  await firestoreDelete(`conversations/${id}`).catch(() => null);
  return { ok: true };
}

async function getFirebaseConversations() {
  const auth = requireFirebaseAuth();
  const rows = await firestoreQuery("conversations", [["member_ids", "ARRAY_CONTAINS", auth.localId]]);
  const conversations = [];
  for (const row of rows) {
    const memberIds = firestoreScalar(row.fields.member_ids) || [];
    const members = [];
    for (const uid of memberIds) {
      members.push(await getFirebaseUser(uid));
    }
    const type = firestoreScalar(row.fields.type) || "direct";
    const other = type === "direct" ? members.find((member) => member.id !== auth.localId) : null;
    conversations.push({
      id: row.id,
      title: firestoreScalar(row.fields.title) || "",
      type,
      created_by_user_id: firestoreScalar(row.fields.created_by_user_id),
      created_at: firestoreScalar(row.fields.created_at),
      members,
      other_user: other,
      last_message: null
    });
  }
  conversations.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { conversations };
}

async function createFirebaseGroupConversation(_token, title, memberIds) {
  const auth = requireFirebaseAuth();
  const uniqueMembers = [...new Set([auth.localId, ...memberIds.map(String)])];
  const conversationId = `group_${randomId(18)}`;
  const now = nowIso();
  await firestorePatch(`conversations/${conversationId}`, auth.idToken, {
    id: conversationId,
    type: "group",
    title: String(title || "Group Chat").trim() || "Group Chat",
    member_ids: uniqueMembers,
    created_by_user_id: auth.localId,
    created_at: now,
    updated_at: now
  });
  return { conversation_id: conversationId };
}

async function getFirebaseMessages(_token, conversationId) {
  const rows = await firestoreQuery("messages", [["conversation_id", "EQUAL", String(conversationId)]]);
  const messages = [];
  for (const row of rows) {
    const senderId = firestoreScalar(row.fields.sender_id);
    let senderUsername = "Unknown";
    try {
      senderUsername = (await getFirebaseUser(senderId)).username;
    } catch (_err) {}
    messages.push({
      id: row.id,
      conversation_id: firestoreScalar(row.fields.conversation_id),
      sender_id: senderId,
      sender_username: senderUsername,
      body: firestoreScalar(row.fields.body),
      display_mode: firestoreScalar(row.fields.display_mode) || "coded",
      attachment_name: firestoreScalar(row.fields.attachment_name),
      attachment_type: firestoreScalar(row.fields.attachment_type),
      attachment_data: firestoreScalar(row.fields.attachment_data),
      created_at: firestoreScalar(row.fields.created_at)
    });
  }
  messages.sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  return { messages };
}

async function sendFirebaseMessage(_token, conversationId, body, displayMode = "coded", attachment = null) {
  const auth = requireFirebaseAuth();
  const messageId = `msg_${Date.now()}_${randomId(8)}`;
  const now = nowIso();
  await firestorePatch(`messages/${messageId}`, auth.idToken, {
    conversation_id: String(conversationId),
    sender_id: auth.localId,
    body: String(body || ""),
    display_mode: displayMode === "plain" ? "plain" : "coded",
    attachment_name: attachment ? attachment.name : "",
    attachment_type: attachment ? attachment.type : "",
    attachment_data: attachment ? attachment.data : "",
    created_at: now
  });
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
    updated_at: now
  }).catch(() => null);
  const user = await getFirebaseUser(auth.localId);
  return {
    message: {
      id: messageId,
      conversation_id: String(conversationId),
      sender_id: auth.localId,
      sender_username: user.username,
      body: String(body || ""),
      display_mode: displayMode === "plain" ? "plain" : "coded",
      attachment_name: attachment ? attachment.name : "",
      attachment_type: attachment ? attachment.type : "",
      attachment_data: attachment ? attachment.data : "",
      created_at: now
    }
  };
}

async function createFirebaseGroupInvite(_token, conversationId, expiresIn = "24h") {
  const auth = requireFirebaseAuth();
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  if (firestoreScalar(conversation.fields.created_by_user_id) !== auth.localId) {
    throw new Error("Only the group creator can create invite links.");
  }
  const token = randomId(32);
  const now = nowIso();
  const expiresAt = expiresIn === "never"
    ? ""
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await firestorePatch(`groupInvites/${token}`, auth.idToken, {
    token,
    conversation_id: String(conversationId),
    created_by_user_id: auth.localId,
    expires_at: expiresAt,
    revoked_at: "",
    created_at: now
  });
  return {
    token,
    conversation: { id: String(conversationId) },
    expires_at: expiresAt || null,
    expires_in: expiresIn === "never" ? "never" : "24h"
  };
}

async function revokeFirebaseGroupInvites(_token, conversationId) {
  const auth = requireFirebaseAuth();
  const rows = await firestoreQuery("groupInvites", [
    ["conversation_id", "EQUAL", String(conversationId)],
    ["revoked_at", "EQUAL", ""]
  ]);
  const now = nowIso();
  for (const row of rows) {
    if (firestoreScalar(row.fields.created_by_user_id) === auth.localId) {
      await firestorePatch(`groupInvites/${row.id}`, auth.idToken, { revoked_at: now });
    }
  }
  return { ok: true };
}

async function getFirebaseGroupInvite(_token, inviteToken) {
  const auth = requireFirebaseAuth();
  const invite = await firestoreGet(`groupInvites/${encodeURIComponent(inviteToken)}`);
  const revokedAt = firestoreScalar(invite.fields.revoked_at);
  const expiresAt = firestoreScalar(invite.fields.expires_at);
  if (revokedAt || (expiresAt && new Date(expiresAt).getTime() < Date.now())) {
    throw new Error("Invite link is invalid or expired.");
  }
  const conversationId = firestoreScalar(invite.fields.conversation_id);
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  const memberIds = firestoreScalar(conversation.fields.member_ids) || [];
  return {
    invite: {
      conversation_id: conversationId,
      title: firestoreScalar(conversation.fields.title) || "Group Chat",
      expires_at: expiresAt || null,
      already_member: memberIds.includes(auth.localId)
    }
  };
}

async function joinFirebaseGroupInvite(_token, inviteToken) {
  const auth = requireFirebaseAuth();
  const lookup = await getFirebaseGroupInvite(_token, inviteToken);
  const conversationId = lookup.invite.conversation_id;
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  const memberIds = firestoreScalar(conversation.fields.member_ids) || [];
  if (!memberIds.includes(auth.localId)) {
    memberIds.push(auth.localId);
    await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
      member_ids: memberIds,
      updated_at: nowIso()
    });
  }
  return { ok: true, conversation_id: conversationId };
}

async function leaveFirebaseConversation(_token, conversationId) {
  const auth = requireFirebaseAuth();
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  const memberIds = (firestoreScalar(conversation.fields.member_ids) || []).filter((uid) => uid !== auth.localId);
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
    member_ids: memberIds,
    updated_at: nowIso()
  });
  return { ok: true };
}

async function blockFirebaseUser(_token, userId) {
  const auth = requireFirebaseAuth();
  await firestorePatch(`blocks/${pairId(auth.localId, userId)}`, auth.idToken, {
    blocker_user_id: auth.localId,
    blocked_user_id: String(userId),
    created_at: nowIso()
  });
  await removeFirebaseFriend(_token, userId).catch(() => null);
  return { ok: true };
}

async function unblockFirebaseUser(_token, userId) {
  const auth = requireFirebaseAuth();
  await firestoreDelete(`blocks/${pairId(auth.localId, userId)}`).catch(() => null);
  return { ok: true };
}

async function getFirebaseBlockedUsers() {
  const auth = requireFirebaseAuth();
  const rows = await firestoreQuery("blocks", [["blocker_user_id", "EQUAL", auth.localId]]);
  const blocked = [];
  for (const row of rows) {
    const uid = firestoreScalar(row.fields.blocked_user_id);
    try {
      blocked.push(await getFirebaseUser(uid));
    } catch (_err) {}
  }
  return { blocked };
}

async function reportFirebaseUser(_token, userId, reason) {
  const auth = requireFirebaseAuth();
  const reportId = `report_${Date.now()}_${randomId(8)}`;
  await firestorePatch(`reports/${reportId}`, auth.idToken, {
    reporter_user_id: auth.localId,
    reported_user_id: String(userId),
    reason: String(reason || "").slice(0, 1000),
    created_at: nowIso()
  });
  return { ok: true };
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
  logout: (token) => logoutEverywhere(token),
  getMe: () => getCurrentFirebaseProfile(),
  heartbeat: () => firebaseHeartbeat(),
  updateProfile: (token, data) => updateProfileEverywhere(token, data),
  getSessions: () => ({ sessions: [{ id: "firebase-current", current: true, created_at: nowIso(), last_seen_at: nowIso() }] }),
  revokeSession: () => ({ ok: true }),
  revokeOtherSessions: () => ({ ok: true }),
  sendFriendRequest: (token, username) => sendFirebaseFriendRequest(token, username),
  getFriendRequests: () => getFirebaseFriendRequests(),
  acceptFriendRequest: (token, requestId) => acceptFirebaseFriendRequest(token, requestId),
  declineFriendRequest: (token, requestId) => updateFirebaseFriendRequest(token, requestId, "declined"),
  cancelFriendRequest: (token, requestId) => updateFirebaseFriendRequest(token, requestId, "cancelled"),
  removeFriend: (token, userId) => removeFirebaseFriend(token, userId),
  getBlockedUsers: () => getFirebaseBlockedUsers(),
  blockUser: (token, userId) => blockFirebaseUser(token, userId),
  unblockUser: (token, userId) => unblockFirebaseUser(token, userId),
  reportUser: (token, userId, reason) => reportFirebaseUser(token, userId, reason),
  getFriends: () => getFirebaseFriends(),
  getConversations: () => getFirebaseConversations(),
  createGroupConversation: (token, title, memberIds) =>
    createFirebaseGroupConversation(token, title, memberIds),
  createGroupInvite: (token, conversationId, expiresIn = "24h") =>
    createFirebaseGroupInvite(token, conversationId, expiresIn),
  revokeGroupInvites: (token, conversationId) =>
    revokeFirebaseGroupInvites(token, conversationId),
  getGroupInvite: (token, inviteToken) => getFirebaseGroupInvite(token, inviteToken),
  joinGroupInvite: (token, inviteToken) =>
    joinFirebaseGroupInvite(token, inviteToken),
  leaveConversation: (token, conversationId) =>
    leaveFirebaseConversation(token, conversationId),
  getMessages: (token, conversationId) => getFirebaseMessages(token, conversationId),
  sendMessage: (token, conversationId, body, displayMode = "coded", attachment = null) =>
    sendFirebaseMessage(token, conversationId, body, displayMode, attachment),
  chooseProfileImage: () => ipcRenderer.invoke("pick-profile-image"),
  chooseMessageAttachment: () => ipcRenderer.invoke("pick-message-attachment")
});
