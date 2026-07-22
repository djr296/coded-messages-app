const { contextBridge, ipcRenderer } = require("electron");
const crypto = require("crypto");
const codec = require("./shared/codec");
const { firebaseConfig } = require("./shared/firebase-config");

const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v1";
const FIREBASE_SECURE_TOKEN_BASE = "https://securetoken.googleapis.com/v1";
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

function encodeSessionToken(state) {
  return Buffer.from(JSON.stringify({
    provider: "firebase",
    idToken: state.idToken || "",
    refreshToken: state.refreshToken || "",
    localId: state.localId || "",
    email: state.email || "",
    expiresAt: state.expiresAt || 0
  }), "utf8").toString("base64url");
}

function decodeSessionToken(token) {
  if (!token) {
    return null;
  }
  try {
    const session = JSON.parse(Buffer.from(String(token), "base64url").toString("utf8"));
    if (session && session.provider === "firebase" && session.localId && session.refreshToken) {
      return session;
    }
  } catch (_err) {}
  return null;
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
    if (!Number.isFinite(value)) {
      return { integerValue: "0" };
    }
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

async function refreshFirebaseAuthState() {
  if (!firebaseAuthState || !firebaseAuthState.refreshToken) {
    throw new Error("Please sign in again.");
  }
  if (firebaseAuthState.expiresAt && firebaseAuthState.expiresAt > Date.now() + 60 * 1000) {
    return firebaseAuthState;
  }

  const response = await fetch(`${FIREBASE_SECURE_TOKEN_BASE}/token?key=${firebaseConfig.apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: firebaseAuthState.refreshToken
    }).toString()
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error("Session expired. Please sign in again.");
  }
  firebaseAuthState = {
    idToken: payload.id_token || "",
    refreshToken: payload.refresh_token || firebaseAuthState.refreshToken,
    localId: payload.user_id || firebaseAuthState.localId,
    email: payload.email || firebaseAuthState.email || "",
    expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000
  };
  return firebaseAuthState;
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

async function firestoreAppendMissing(path, fieldPath, values, idToken = firebaseAuthState && firebaseAuthState.idToken) {
  const documentPath = `projects/${firebaseConfig.projectId}/databases/(default)/documents/${path}`;
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents:commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`
    },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: documentPath,
          fieldTransforms: [{
            fieldPath,
            appendMissingElements: {
              values: values.map((value) => firestoreValue(value))
            }
          }]
        }
      }]
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error ? payload.error.message : "Could not update Firebase data.";
    throw new Error(message);
  }
  return payload;
}

function buildStructuredQuery(collectionId, filters = [], orderBy = []) {
  const structuredQuery = {
    from: [{ collectionId }]
  };

  if (filters.length) {
    const queryFilters = filters.map(([field, op, value]) => ({
      fieldFilter: {
        field: { fieldPath: field },
        op,
        value: firestoreValue(value)
      }
    }));

    structuredQuery.where = queryFilters.length === 1
      ? queryFilters[0]
      : {
          compositeFilter: {
            op: "AND",
            filters: queryFilters
          }
        };
  }

  if (orderBy.length) {
    structuredQuery.orderBy = orderBy.map(([field, direction]) => ({
      field: { fieldPath: field },
      direction
    }));
  }

  return structuredQuery;
}

async function firestoreQueryAt(parentPath, collectionId, filters = [], orderBy = []) {
  const auth = await requireFirebaseAuth();
  const structuredQuery = buildStructuredQuery(collectionId, filters, orderBy);
  const parent = parentPath ? `/${parentPath}` : "";

  const response = await fetch(`${FIRESTORE_BASE}${parent}:runQuery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.idToken}`
    },
    body: JSON.stringify({ structuredQuery })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload && payload.error
      ? payload.error.message
      : `Could not query Firebase data. Firebase returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload
    .filter((row) => row.document)
    .map((row) => ({
      id: docId(row.document.name),
      fields: row.document.fields || {}
    }));
}

async function firestoreQuery(collectionId, filters = [], orderBy = []) {
  return firestoreQueryAt("", collectionId, filters, orderBy);
}

async function mirrorProfileToFirestore(user, authState = firebaseAuthState) {
  if (!authState || !authState.idToken || !authState.localId || !user) {
    return;
  }

  const now = new Date().toISOString();
  const appUserId = Number(user.app_user_id || 0);
  await firestorePatch(`users/${encodeURIComponent(authState.localId)}`, authState.idToken, {
    uid: authState.localId,
    app_user_id: Number.isFinite(appUserId) ? appUserId : 0,
    email: user.email || authState.email || "",
    username: user.username || "",
    username_lower: String(user.username || "").toLowerCase(),
    profile_image_path: user.profile_image_path || "",
    last_seen_at: user.last_seen_at || "",
    updated_at: now
  });
}

function setFirebaseAuthState(firebasePayload) {
  firebaseAuthState = {
    idToken: firebasePayload.idToken,
    refreshToken: firebasePayload.refreshToken || "",
    localId: firebasePayload.localId || "",
    email: firebasePayload.email || "",
    expiresAt: Date.now() + Number(firebasePayload.expiresIn || 3600) * 1000
  };
  return firebaseAuthState;
}

async function createFirebaseSessionResponse(user) {
  const auth = await requireFirebaseAuth();
  return {
    token: encodeSessionToken(auth),
    user,
    auth_provider: "firebase"
  };
}

async function deleteFirebaseAccount(idToken) {
  try {
    await firebaseAuthRequest("accounts:delete", { idToken });
  } catch (_err) {
    // Best-effort cleanup. The visible registration error is more important.
  }
}

async function registerWithFirebase({ email, password, username }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const normalizedUsername = String(username || "").trim();
  if (!normalizedEmail || !password || !normalizedUsername) {
    throw new Error("Email, password, and username are required.");
  }
  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters.");
  }
  const firebasePayload = await firebaseAuthRequest("accounts:signUp", {
    email: normalizedEmail,
    password,
    returnSecureToken: true
  });
  setFirebaseAuthState(firebasePayload);
  try {
    const existingUsername = await firestoreQuery("users", [["username_lower", "EQUAL", normalizedUsername.toLowerCase()]]);
    if (existingUsername.length) {
      throw new Error("Username already taken.");
    }
    const user = {
      id: firebaseAuthState.localId,
      app_user_id: 0,
      email: normalizedEmail,
      username: normalizedUsername,
      profile_image_path: "",
      last_seen_at: "",
      online: false
    };
    await mirrorProfileToFirestore(user, firebaseAuthState);
    return createFirebaseSessionResponse(user);
  } catch (err) {
    await deleteFirebaseAccount(firebasePayload.idToken);
    firebaseAuthState = null;
    throw err;
  }
}

async function loginWithFirebase({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const firebasePayload = await firebaseAuthRequest("accounts:signInWithPassword", {
    email: normalizedEmail,
    password,
    returnSecureToken: true
  });
  setFirebaseAuthState(firebasePayload);
  let user;
  try {
    user = (await getCurrentFirebaseProfile()).user;
  } catch (_err) {
    const fallbackUsername = normalizedEmail.split("@")[0].replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24) || "user";
    user = {
      id: firebaseAuthState.localId,
      app_user_id: 0,
      email: normalizedEmail,
      username: fallbackUsername,
      profile_image_path: "",
      last_seen_at: "",
      online: false
    };
    await mirrorProfileToFirestore(user, firebaseAuthState);
  }
  return createFirebaseSessionResponse(user);
}

async function logoutEverywhere(token) {
  firebaseAuthState = null;
}

async function updateProfileEverywhere(token, data) {
  const auth = await requireFirebaseAuth(token);
  const current = await getFirebaseUser(auth.localId);
  const username = String(data.username || current.username || "").trim();
  if (!username) {
    throw new Error("Username is required.");
  }
  if (username.toLowerCase() !== String(current.username || "").toLowerCase()) {
    const rows = await firestoreQuery("users", [["username_lower", "EQUAL", username.toLowerCase()]]);
    if (rows.some((row) => row.id !== auth.localId)) {
      throw new Error("Username already taken.");
    }
  }
  const user = {
    ...current,
    username,
    profile_image_path: data.profile_image_path || current.profile_image_path || ""
  };
  await mirrorProfileToFirestore(user, auth);
  return { user };
}

async function requireFirebaseAuth(token) {
  if (token && !firebaseAuthState) {
    const session = decodeSessionToken(token);
    if (session) {
      firebaseAuthState = session;
    }
  }
  if (!firebaseAuthState || !firebaseAuthState.refreshToken || !firebaseAuthState.localId) {
    throw new Error("Please sign in again.");
  }
  return refreshFirebaseAuthState();
}

async function getFirebaseUser(uid) {
  const doc = await firestoreGet(`users/${encodeURIComponent(uid)}`);
  return userFromFirebaseProfile(doc.fields || {}, uid);
}

function conversationFromFields(id, fields) {
  return {
    id,
    title: firestoreScalar(fields.title) || "",
    type: firestoreScalar(fields.type) || "direct",
    created_by_user_id: firestoreScalar(fields.created_by_user_id),
    created_at: firestoreScalar(fields.created_at),
    updated_at: firestoreScalar(fields.updated_at),
    member_ids: firestoreScalar(fields.member_ids) || []
  };
}

async function putUserConversation(auth, uid, conversationId, conversation) {
  await firestorePatch(
    `userConversations/${encodeURIComponent(uid)}/items/${encodeURIComponent(conversationId)}`,
    auth.idToken,
    {
      conversation_id: conversationId,
      title: conversation.title || "",
      type: conversation.type || "direct",
      created_by_user_id: conversation.created_by_user_id || auth.localId,
      member_ids: conversation.member_ids || [],
      created_at: conversation.created_at || nowIso(),
      updated_at: conversation.updated_at || nowIso(),
      invite_version: conversation.invite_version || "0"
    }
  );
}

async function putConversationForMembers(auth, conversationId, conversation) {
  for (const uid of conversation.member_ids || []) {
    await putUserConversation(auth, uid, conversationId, conversation);
  }
}

async function deleteUserConversation(uid, conversationId) {
  await firestoreDelete(
    `userConversations/${encodeURIComponent(uid)}/items/${encodeURIComponent(conversationId)}`
  ).catch(() => null);
}

async function putFriendView(auth, ownerUid, friendUid, friendshipId, conversationId, createdAt) {
  await firestorePatch(
    `userFriends/${encodeURIComponent(ownerUid)}/items/${encodeURIComponent(friendUid)}`,
    auth.idToken,
    {
      friend_uid: friendUid,
      friendship_id: friendshipId,
      conversation_id: conversationId,
      created_at: createdAt
    }
  );
}

async function putFriendRequestView(auth, ownerUid, box, requestId, requestData) {
  await firestorePatch(
    `userFriendRequests/${encodeURIComponent(ownerUid)}/${box}/${encodeURIComponent(requestId)}`,
    auth.idToken,
    requestData
  );
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
  const auth = await requireFirebaseAuth();
  const user = await getFirebaseUser(auth.localId);
  return { user };
}

async function firebaseHeartbeat() {
  const auth = await requireFirebaseAuth();
  await firestorePatch(`users/${encodeURIComponent(auth.localId)}`, auth.idToken, {
    last_seen_at: nowIso(),
    updated_at: nowIso()
  });
  return { ok: true };
}

async function getFirebaseFriends() {
  const auth = await requireFirebaseAuth();
  const rows = await firestoreQueryAt(`userFriends/${encodeURIComponent(auth.localId)}`, "items");
  const friends = [];
  for (const row of rows) {
    const friendUid = firestoreScalar(row.fields.friend_uid) || row.id;
    if (!friendUid) continue;
    const friend = await getFirebaseUser(friendUid);
    friends.push({
      friendship_id: firestoreScalar(row.fields.friendship_id),
      user_id: friend.id,
      username: friend.username,
      profile_image_path: friend.profile_image_path,
      last_seen_at: friend.last_seen_at,
      online: false,
      conversation_id: firestoreScalar(row.fields.conversation_id) || pairId(auth.localId, friendUid)
    });
  }
  return { friends };
}

async function sendFirebaseFriendRequest(_token, username) {
  const auth = await requireFirebaseAuth();
  const target = await findFirebaseUserByUsername(username);
  if (target.id === auth.localId) {
    throw new Error("You cannot add yourself.");
  }
  try {
    await firestoreGet(`userFriends/${encodeURIComponent(auth.localId)}/items/${encodeURIComponent(target.id)}`);
    throw new Error("You are already friends.");
  } catch (err) {
    const message = String(err.message || "").toLowerCase();
    if (!message.includes("not found")) {
      throw err;
    }
  }
  const requestId = `${auth.localId}_${target.id}`;
  const requestData = {
    from_uid: auth.localId,
    to_uid: target.id,
    status: "pending",
    created_at: nowIso(),
    responded_at: ""
  };
  await firestorePatch(`friendRequests/${requestId}`, auth.idToken, requestData);
  await putFriendRequestView(auth, target.id, "incoming", requestId, requestData);
  await putFriendRequestView(auth, auth.localId, "outgoing", requestId, requestData);
  return { ok: true };
}

async function getFirebaseFriendRequests() {
  const auth = await requireFirebaseAuth();
  const incomingRows = await firestoreQueryAt(
    `userFriendRequests/${encodeURIComponent(auth.localId)}`,
    "incoming",
    [["status", "EQUAL", "pending"]]
  );
  const outgoingRows = await firestoreQueryAt(
    `userFriendRequests/${encodeURIComponent(auth.localId)}`,
    "outgoing",
    [["status", "EQUAL", "pending"]]
  );
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
  const auth = await requireFirebaseAuth();
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
  const acceptedRequestData = {
    from_uid: fromUid,
    to_uid: toUid,
    status: "accepted",
    created_at: firestoreScalar(reqDoc.fields.created_at) || now,
    responded_at: now
  };
  await putFriendRequestView(auth, toUid, "incoming", requestId, acceptedRequestData);
  await putFriendRequestView(auth, fromUid, "outgoing", requestId, acceptedRequestData);
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
  await putFriendView(auth, fromUid, toUid, friendshipId, friendshipId, now);
  await putFriendView(auth, toUid, fromUid, friendshipId, friendshipId, now);
  await putConversationForMembers(auth, friendshipId, {
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
  const auth = await requireFirebaseAuth();
  const reqDoc = await firestoreGet(`friendRequests/${encodeURIComponent(requestId)}`);
  const fromUid = firestoreScalar(reqDoc.fields.from_uid);
  const toUid = firestoreScalar(reqDoc.fields.to_uid);
  if ((status === "declined" && toUid !== auth.localId) || (status === "cancelled" && fromUid !== auth.localId)) {
    throw new Error("Friend request not found.");
  }
  const respondedAt = nowIso();
  await firestorePatch(`friendRequests/${encodeURIComponent(requestId)}`, auth.idToken, {
    status,
    responded_at: respondedAt
  });
  const requestData = {
    from_uid: fromUid,
    to_uid: toUid,
    status,
    created_at: firestoreScalar(reqDoc.fields.created_at) || "",
    responded_at: respondedAt
  };
  await putFriendRequestView(auth, toUid, "incoming", requestId, requestData);
  await putFriendRequestView(auth, fromUid, "outgoing", requestId, requestData);
  return { ok: true };
}

async function removeFirebaseFriend(_token, userId) {
  const auth = await requireFirebaseAuth();
  const id = pairId(auth.localId, userId);
  await firestoreDelete(`friendships/${id}`);
  await firestoreDelete(`conversations/${id}`).catch(() => null);
  await firestoreDelete(`userFriends/${encodeURIComponent(auth.localId)}/items/${encodeURIComponent(userId)}`).catch(() => null);
  await firestoreDelete(`userFriends/${encodeURIComponent(userId)}/items/${encodeURIComponent(auth.localId)}`).catch(() => null);
  await deleteUserConversation(auth.localId, id);
  await deleteUserConversation(userId, id);
  return { ok: true };
}

async function getFirebaseConversations() {
  const auth = await requireFirebaseAuth();
  const rows = await firestoreQueryAt(`userConversations/${encodeURIComponent(auth.localId)}`, "items");
  const conversations = [];
  for (const row of rows) {
    const conversationId = firestoreScalar(row.fields.conversation_id) || row.id;
    const conversation = conversationFromFields(conversationId, row.fields);
    const memberIds = conversation.member_ids;
    const members = [];
    for (const uid of memberIds) {
      members.push(await getFirebaseUser(uid));
    }
    const type = conversation.type;
    const other = type === "direct" ? members.find((member) => member.id !== auth.localId) : null;
    conversations.push({
      id: conversationId,
      title: conversation.title,
      type,
      created_by_user_id: conversation.created_by_user_id,
      created_at: conversation.created_at,
      members,
      other_user: other,
      last_message: null
    });
  }
  conversations.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { conversations };
}

async function createFirebaseGroupConversation(_token, title, memberIds) {
  const auth = await requireFirebaseAuth();
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
    updated_at: now,
    invite_version: "0"
  });
  await putConversationForMembers(auth, conversationId, {
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
  const rows = await firestoreQueryAt(
    `conversations/${encodeURIComponent(conversationId)}`,
    "messages",
    [],
    [["created_at", "ASCENDING"]]
  );
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
  const auth = await requireFirebaseAuth();
  const messageId = `msg_${Date.now()}_${randomId(8)}`;
  const now = nowIso();
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}/messages/${messageId}`, auth.idToken, {
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
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`).catch(() => null);
  if (conversation && conversation.fields) {
    const conversationData = conversationFromFields(String(conversationId), conversation.fields);
    conversationData.updated_at = now;
    await putConversationForMembers(auth, String(conversationId), conversationData).catch(() => null);
  }
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
  const auth = await requireFirebaseAuth();
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  if (firestoreScalar(conversation.fields.created_by_user_id) !== auth.localId) {
    throw new Error("Only the group creator can create invite links.");
  }
  const inviteVersion = firestoreScalar(conversation.fields.invite_version) || "0";
  const token = randomId(32);
  const now = nowIso();
  const expiresAt = expiresIn === "never"
    ? ""
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await firestorePatch(`groupInvites/${token}`, auth.idToken, {
    token,
    conversation_id: String(conversationId),
    conversation_title: firestoreScalar(conversation.fields.title) || "Group Chat",
    created_by_user_id: auth.localId,
    invite_version: inviteVersion,
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
  const auth = await requireFirebaseAuth();
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  if (firestoreScalar(conversation.fields.created_by_user_id) !== auth.localId) {
    throw new Error("Only the group creator can turn off invite links.");
  }
  const now = nowIso();
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
    invite_version: randomId(12),
    invite_revoked_at: now,
    updated_at: now
  });
  return { ok: true };
}

async function getFirebaseGroupInvite(_token, inviteToken) {
  const auth = await requireFirebaseAuth();
  const invite = await firestoreGet(`groupInvites/${encodeURIComponent(inviteToken)}`);
  const revokedAt = firestoreScalar(invite.fields.revoked_at);
  const expiresAt = firestoreScalar(invite.fields.expires_at);
  if (revokedAt || (expiresAt && new Date(expiresAt).getTime() < Date.now())) {
    throw new Error("Invite link is invalid or expired.");
  }
  const conversationId = firestoreScalar(invite.fields.conversation_id);
  const inviteVersion = firestoreScalar(invite.fields.invite_version) || "0";
  let alreadyMember = false;
  try {
    const userConversation = await firestoreGet(
      `userConversations/${encodeURIComponent(auth.localId)}/items/${encodeURIComponent(conversationId)}`
    );
    alreadyMember = !!userConversation.fields;
    const conversationInviteVersion = firestoreScalar(userConversation.fields.invite_version) || inviteVersion;
    if (conversationInviteVersion !== inviteVersion) {
      throw new Error("Invite link is invalid or expired.");
    }
  } catch (err) {
    if (!String(err.message || "").toLowerCase().includes("not found")) {
      throw err;
    }
  }
  return {
    invite: {
      conversation_id: conversationId,
      title: firestoreScalar(invite.fields.conversation_title) || "Group Chat",
      expires_at: expiresAt || null,
      already_member: alreadyMember
    }
  };
}

async function joinFirebaseGroupInvite(_token, inviteToken) {
  const auth = await requireFirebaseAuth();
  const invite = await firestoreGet(`groupInvites/${encodeURIComponent(inviteToken)}`);
  const revokedAt = firestoreScalar(invite.fields.revoked_at);
  const expiresAt = firestoreScalar(invite.fields.expires_at);
  if (revokedAt || (expiresAt && new Date(expiresAt).getTime() < Date.now())) {
    throw new Error("Invite link is invalid or expired.");
  }
  const conversationId = firestoreScalar(invite.fields.conversation_id);
  const now = nowIso();
  await firestoreAppendMissing(
    `conversations/${encodeURIComponent(conversationId)}`,
    "member_ids",
    [auth.localId],
    auth.idToken
  );
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
    updated_at: now
  });
  const updatedConversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  const inviteVersion = firestoreScalar(invite.fields.invite_version) || "0";
  const conversationInviteVersion = firestoreScalar(updatedConversation.fields.invite_version) || "0";
  if (inviteVersion !== conversationInviteVersion) {
    throw new Error("Invite link is invalid or expired.");
  }
  await putUserConversation(auth, auth.localId, conversationId, {
    ...conversationFromFields(conversationId, updatedConversation.fields),
    invite_version: conversationInviteVersion
  });
  return { ok: true, conversation_id: conversationId };
}

async function leaveFirebaseConversation(_token, conversationId) {
  const auth = await requireFirebaseAuth();
  const conversation = await firestoreGet(`conversations/${encodeURIComponent(conversationId)}`);
  const memberIds = (firestoreScalar(conversation.fields.member_ids) || []).filter((uid) => uid !== auth.localId);
  await firestorePatch(`conversations/${encodeURIComponent(conversationId)}`, auth.idToken, {
    member_ids: memberIds,
    updated_at: nowIso()
  });
  await deleteUserConversation(auth.localId, conversationId);
  return { ok: true };
}

async function blockFirebaseUser(_token, userId) {
  const auth = await requireFirebaseAuth();
  const blockData = {
    blocker_user_id: auth.localId,
    blocked_user_id: String(userId),
    created_at: nowIso()
  };
  await firestorePatch(`blocks/${pairId(auth.localId, userId)}`, auth.idToken, blockData);
  await firestorePatch(
    `userBlocks/${encodeURIComponent(auth.localId)}/items/${encodeURIComponent(userId)}`,
    auth.idToken,
    blockData
  );
  await removeFirebaseFriend(_token, userId).catch(() => null);
  return { ok: true };
}

async function unblockFirebaseUser(_token, userId) {
  const auth = await requireFirebaseAuth();
  await firestoreDelete(`blocks/${pairId(auth.localId, userId)}`).catch(() => null);
  await firestoreDelete(`userBlocks/${encodeURIComponent(auth.localId)}/items/${encodeURIComponent(userId)}`).catch(() => null);
  return { ok: true };
}

async function getFirebaseBlockedUsers() {
  const auth = await requireFirebaseAuth();
  const rows = await firestoreQueryAt(`userBlocks/${encodeURIComponent(auth.localId)}`, "items");
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
  const auth = await requireFirebaseAuth();
  const reportId = `report_${Date.now()}_${randomId(8)}`;
  await firestorePatch(`reports/${reportId}`, auth.idToken, {
    reporter_user_id: auth.localId,
    reported_user_id: String(userId),
    reason: String(reason || "").slice(0, 1000),
    created_at: nowIso()
  });
  return { ok: true };
}

async function withFirebaseSession(token, action) {
  await requireFirebaseAuth(token);
  return action();
}

contextBridge.exposeInMainWorld("codedMessages", {
  encode: codec.encode,
  decode: codec.decode
});

contextBridge.exposeInMainWorld("codedApi", {
  baseUrl: `firebase://${firebaseConfig.projectId}`,
  health: async () => ({ ok: true, backend: "firebase", projectId: firebaseConfig.projectId }),
  authProvider: "firebase",
  register: (data) => registerWithFirebase(data),
  login: (data) => loginWithFirebase(data),
  logout: (token) => logoutEverywhere(token),
  getMe: (token) => withFirebaseSession(token, () => getCurrentFirebaseProfile()),
  heartbeat: (token) => withFirebaseSession(token, () => firebaseHeartbeat()),
  updateProfile: (token, data) => updateProfileEverywhere(token, data),
  getSessions: (token) => withFirebaseSession(token, () => ({ sessions: [{ id: "firebase-current", current: true, created_at: nowIso(), last_seen_at: nowIso() }] })),
  revokeSession: (token) => withFirebaseSession(token, () => ({ ok: true })),
  revokeOtherSessions: (token) => withFirebaseSession(token, () => ({ ok: true })),
  sendFriendRequest: (token, username) => withFirebaseSession(token, () => sendFirebaseFriendRequest(token, username)),
  getFriendRequests: (token) => withFirebaseSession(token, () => getFirebaseFriendRequests()),
  acceptFriendRequest: (token, requestId) => withFirebaseSession(token, () => acceptFirebaseFriendRequest(token, requestId)),
  declineFriendRequest: (token, requestId) => withFirebaseSession(token, () => updateFirebaseFriendRequest(token, requestId, "declined")),
  cancelFriendRequest: (token, requestId) => withFirebaseSession(token, () => updateFirebaseFriendRequest(token, requestId, "cancelled")),
  removeFriend: (token, userId) => withFirebaseSession(token, () => removeFirebaseFriend(token, userId)),
  getBlockedUsers: (token) => withFirebaseSession(token, () => getFirebaseBlockedUsers()),
  blockUser: (token, userId) => withFirebaseSession(token, () => blockFirebaseUser(token, userId)),
  unblockUser: (token, userId) => withFirebaseSession(token, () => unblockFirebaseUser(token, userId)),
  reportUser: (token, userId, reason) => withFirebaseSession(token, () => reportFirebaseUser(token, userId, reason)),
  getFriends: (token) => withFirebaseSession(token, () => getFirebaseFriends()),
  getConversations: (token) => withFirebaseSession(token, () => getFirebaseConversations()),
  createGroupConversation: (token, title, memberIds) =>
    withFirebaseSession(token, () => createFirebaseGroupConversation(token, title, memberIds)),
  createGroupInvite: (token, conversationId, expiresIn = "24h") =>
    withFirebaseSession(token, () => createFirebaseGroupInvite(token, conversationId, expiresIn)),
  revokeGroupInvites: (token, conversationId) =>
    withFirebaseSession(token, () => revokeFirebaseGroupInvites(token, conversationId)),
  getGroupInvite: (token, inviteToken) =>
    withFirebaseSession(token, () => getFirebaseGroupInvite(token, inviteToken)),
  joinGroupInvite: (token, inviteToken) =>
    withFirebaseSession(token, () => joinFirebaseGroupInvite(token, inviteToken)),
  leaveConversation: (token, conversationId) =>
    withFirebaseSession(token, () => leaveFirebaseConversation(token, conversationId)),
  getMessages: (token, conversationId) =>
    withFirebaseSession(token, () => getFirebaseMessages(token, conversationId)),
  sendMessage: (token, conversationId, body, displayMode = "coded", attachment = null) =>
    withFirebaseSession(token, () => sendFirebaseMessage(token, conversationId, body, displayMode, attachment)),
  chooseProfileImage: () => ipcRenderer.invoke("pick-profile-image"),
  chooseMessageAttachment: () => ipcRenderer.invoke("pick-message-attachment")
});
