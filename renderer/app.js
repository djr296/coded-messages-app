if (!window.codedApi || !window.codedMessages) {
  const authError = document.getElementById("auth-error");
  if (authError) {
    authError.textContent = "App bridge failed to load. Restart the app.";
  }
  throw new Error("Preload bridge unavailable.");
}
const state = {
  authMode: "login",
  token: localStorage.getItem("coded_token") || "",
  me: null,
  friends: [],
  conversations: [],
  requests: [],
  outgoingRequests: [],
  blockedUsers: [],
  sessions: [],
  selectedConversationId: null,
  selectedUsername: "",
  messages: [],
  messageDisplayMode: "coded",
  pendingAttachment: null,
  profileImageData: ""
};

const els = {
  authOverlay: document.getElementById("auth-overlay"),
  authSubtitle: document.getElementById("auth-subtitle"),
  authForm: document.getElementById("auth-form"),
  authEmail: document.getElementById("auth-email"),
  authPasswordLabel: document.querySelector("label[for='auth-password']"),
  authPassword: document.getElementById("auth-password"),
  authUsernameWrap: document.getElementById("auth-username-wrap"),
  authUsername: document.getElementById("auth-username"),
  authSubmit: document.getElementById("auth-submit"),
  authSwitch: document.getElementById("auth-switch"),
  authError: document.getElementById("auth-error"),

  currentUser: document.getElementById("current-user"),
  logoutBtn: document.getElementById("logout-btn"),

  chatList: document.getElementById("chat-list"),
  groupTitleInput: document.getElementById("group-title-input"),
  groupFriendList: document.getElementById("group-friend-list"),
  groupCreateBtn: document.getElementById("group-create-btn"),
  groupStatus: document.getElementById("group-status"),
  requestList: document.getElementById("request-list"),
  outgoingRequestList: document.getElementById("outgoing-request-list"),
  removeFriendBtn: document.getElementById("remove-friend-btn"),
  reportUserBtn: document.getElementById("report-user-btn"),
  blockUserBtn: document.getElementById("block-user-btn"),
  leaveGroupBtn: document.getElementById("leave-group-btn"),

  friendUsernameInput: document.getElementById("friend-username-input"),
  friendAddBtn: document.getElementById("friend-add-btn"),
  friendStatus: document.getElementById("friend-status"),

  connectionBanner: document.getElementById("connection-banner"),
  chatTitle: document.getElementById("chat-title"),
  messages: document.getElementById("messages"),
  sendForm: document.getElementById("send-form"),
  messageInput: document.getElementById("message-input"),
  attachBtn: document.getElementById("attach-btn"),
  attachmentPreview: document.getElementById("attachment-preview"),
  attachmentName: document.getElementById("attachment-name"),
  attachmentClear: document.getElementById("attachment-clear"),
  chatStatus: document.getElementById("chat-status"),
  messageModeCoded: document.getElementById("message-mode-coded"),
  messageModePlain: document.getElementById("message-mode-plain"),

  codedInput: document.getElementById("coded-input"),
  decodedOutput: document.getElementById("decoded-output"),
  decodeBtn: document.getElementById("decode-btn"),

  profileForm: document.getElementById("profile-form"),
  profileUsername: document.getElementById("profile-username"),
  profileImagePreview: document.getElementById("profile-image-preview"),
  profileImageBrowse: document.getElementById("profile-image-browse"),
  profileImageClear: document.getElementById("profile-image-clear"),
  profileStatus: document.getElementById("profile-status"),
  sessionList: document.getElementById("session-list"),
  sessionsRevokeOthers: document.getElementById("sessions-revoke-others"),
  blockedUserList: document.getElementById("blocked-user-list")
};

const views = {
  chat: document.getElementById("chat-view"),
  decrypt: document.getElementById("decrypt-view"),
  profile: document.getElementById("profile-view")
};

let connectionBannerTimer = null;
let syncTimer = null;

function setView(viewName) {
  Object.entries(views).forEach(([name, el]) => {
    el.classList.toggle("active", name === viewName);
  });

  document.querySelectorAll(".menu-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === viewName);
  });
}

function setAuthMode(mode) {
  state.authMode = mode;
  const register = mode === "register";

  els.authSubtitle.textContent = register
    ? "Create your account."
    : "Sign in to continue.";
  els.authSubmit.textContent = register
    ? "Create Account"
    : "Sign In";
  els.authSwitch.textContent = register
    ? "I already have an account"
    : "Create account";
  els.authUsernameWrap.classList.toggle("hidden", !register);
  els.authUsername.required = register;
  els.authPasswordLabel.classList.remove("hidden");
  els.authPassword.classList.remove("hidden");
  els.authPassword.required = true;
  els.authError.textContent = "";
}

function showAuth(show) {
  els.authOverlay.classList.toggle("hidden", !show);
}

function setToken(token) {
  state.token = token;
  if (token) {
    localStorage.setItem("coded_token", token);
  } else {
    localStorage.removeItem("coded_token");
  }
}

function setFriendStatus(text) {
  els.friendStatus.textContent = text || "";
}

function setGroupStatus(text) {
  els.groupStatus.textContent = text || "";
}

function setChatStatus(text) {
  els.chatStatus.textContent = text || "";
}

function setProfileStatus(text) {
  els.profileStatus.textContent = text || "";
}

function showConnectionBanner(text, { error = false, autoHideMs = 0 } = {}) {
  clearTimeout(connectionBannerTimer);
  els.connectionBanner.textContent = text;
  els.connectionBanner.classList.remove("hidden", "error", "online");
  els.connectionBanner.classList.add(error ? "error" : "online");

  if (autoHideMs > 0) {
    connectionBannerTimer = setTimeout(() => {
      els.connectionBanner.classList.add("hidden");
    }, autoHideMs);
  }
}

function hideConnectionBanner() {
  clearTimeout(connectionBannerTimer);
  els.connectionBanner.classList.add("hidden");
}

function clearAuthFields({ keepEmail = false } = {}) {
  if (!keepEmail) {
    els.authEmail.value = "";
  }
  els.authPassword.value = "";
  els.authUsername.value = "";
}

function setButtonBusy(button, busy, idleText, busyText) {
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function normalizeErrorMessage(err, fallback = "Something went wrong. Please try again.") {
  const message = String(err && err.message ? err.message : fallback);

  if (message.includes("Failed to fetch")) {
    return "Can't reach the server right now. It may be waking up. Please wait a moment and try again.";
  }

  if (message === "Internal server error.") {
    return "The server hit an error. Please wait a few seconds and try again.";
  }

  return message;
}

async function withServerWakeMessage(action, wakingText = "Connecting to the cloud server...") {
  let showedWakeBanner = false;
  const timer = setTimeout(() => {
    showedWakeBanner = true;
    showConnectionBanner(wakingText);
  }, 1200);

  try {
    const result = await action();
    clearTimeout(timer);
    if (showedWakeBanner) {
      showConnectionBanner("Connected to the cloud server.", { autoHideMs: 1800 });
    } else {
      hideConnectionBanner();
    }
    return result;
  } catch (err) {
    clearTimeout(timer);
    showConnectionBanner(normalizeErrorMessage(err), { error: true });
    throw err;
  }
}

function clearDecrypter() {
  els.codedInput.value = "";
  els.decodedOutput.value = "";
}

function clearSessionState() {
  stopBackgroundSync();
  state.me = null;
  state.friends = [];
  state.conversations = [];
  state.requests = [];
  state.outgoingRequests = [];
  state.blockedUsers = [];
  state.sessions = [];
  state.messages = [];
  state.selectedConversationId = null;
  state.selectedUsername = "";
  state.messageDisplayMode = "coded";
  state.pendingAttachment = null;
  state.profileImageData = "";
  syncMessageModeControls();
  renderAttachmentPreview();
  setToken("");
  clearDecrypter();
  clearAuthFields();
  setAuthMode("login");
  renderCurrentUser();
  renderFriends();
  renderGroupFriendList();
  renderRequests();
  renderOutgoingRequests();
  renderBlockedUsers();
  renderSessions();
  renderMessages();
}

function syncMessageModeControls() {
  els.messageModeCoded.checked = state.messageDisplayMode !== "plain";
  els.messageModePlain.checked = state.messageDisplayMode === "plain";
}

function formatTimestamp(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

function formatPresence(user) {
  if (user && user.online) {
    return "Online";
  }
  if (user && user.last_seen_at) {
    return `Last seen ${formatTimestamp(user.last_seen_at)}`;
  }
  return "Offline";
}

function getSelectedFriend() {
  if (!state.selectedConversationId) {
    return null;
  }

  const selected = getSelectedConversation();
  if (!selected || selected.type === "group" || !selected.other_user) {
    return null;
  }

  return state.friends.find((friend) => Number(friend.user_id) === Number(selected.other_user.id)) || null;
}

function getSelectedConversation() {
  if (!state.selectedConversationId) {
    return null;
  }
  return state.conversations.find(
    (conversation) => Number(conversation.id) === Number(state.selectedConversationId)
  ) || null;
}

function getConversationTitle(conversation) {
  if (!conversation) {
    return "";
  }
  if (conversation.type === "group") {
    return conversation.title || "Group Chat";
  }
  return conversation.other_user ? `@${conversation.other_user.username}` : "Direct Chat";
}

function renderAttachmentPreview() {
  const attachment = state.pendingAttachment;
  els.attachmentPreview.classList.toggle("hidden", !attachment);
  els.attachmentName.textContent = attachment ? `${attachment.name} (${attachment.type})` : "";
}

function buildAvatar(path, label) {
  const wrapper = document.createElement("div");
  wrapper.className = "avatar";

  const img = document.createElement("img");
  img.className = "avatar-image";
  img.alt = label;

  const fallback = document.createElement("div");
  fallback.className = "avatar-fallback";
  fallback.textContent = String(label || "?").trim().charAt(0).toUpperCase() || "?";

  if (path) {
    img.src = path;
    img.addEventListener("error", () => {
      img.classList.add("hidden");
      fallback.classList.remove("hidden");
    });
  } else {
    img.classList.add("hidden");
  }

  wrapper.appendChild(img);
  wrapper.appendChild(fallback);
  return wrapper;
}

function renderProfileImagePreview() {
  els.profileImagePreview.innerHTML = "";
  els.profileImagePreview.appendChild(
    buildAvatar(state.profileImageData, state.me ? state.me.username : "?")
  );
}

function renderCurrentUser() {
  if (!state.me) {
    els.currentUser.textContent = "Not signed in";
    return;
  }

  els.currentUser.innerHTML = "";
  els.currentUser.appendChild(buildAvatar(state.me.profile_image_path, state.me.username));

  const details = document.createElement("div");
  details.className = "user-summary";
  const username = document.createElement("strong");
  username.textContent = `@${state.me.username}`;
  const email = document.createElement("span");
  email.textContent = state.me.email;
  details.appendChild(username);
  details.appendChild(email);
  els.currentUser.appendChild(details);
}

function renderFriends() {
  els.chatList.innerHTML = "";

  if (state.conversations.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No chats yet.";
    els.chatList.appendChild(empty);
    return;
  }

  state.conversations.forEach((conversation) => {
    const btn = document.createElement("button");
    const isActive = Number(conversation.id) === Number(state.selectedConversationId);
    const isGroup = conversation.type === "group";
    const avatarUser = isGroup ? null : conversation.other_user;
    btn.className = "contact-btn" + (isActive ? " active" : "");
    btn.appendChild(buildAvatar(
      avatarUser ? avatarUser.profile_image_path : "",
      isGroup ? "#" : avatarUser ? avatarUser.username : "?"
    ));

    const details = document.createElement("div");
    details.className = "contact-summary";
    const username = document.createElement("strong");
    username.textContent = getConversationTitle(conversation);
    const presence = document.createElement("span");
    if (isGroup) {
      presence.className = "presence";
      presence.textContent = `${conversation.members.length} members`;
    } else {
      const otherUser = conversation.other_user || {};
      presence.className = otherUser.online ? "presence online" : "presence";
      presence.textContent = formatPresence(otherUser);
    }
    details.appendChild(username);
    details.appendChild(presence);
    btn.appendChild(details);
    btn.addEventListener("click", () => {
      state.selectedConversationId = conversation.id;
      state.selectedUsername = getConversationTitle(conversation);
      setChatStatus("Loading conversation...");
      renderFriends();
      loadMessages().catch((err) => {
        setChatStatus(normalizeErrorMessage(err));
      });
    });
    els.chatList.appendChild(btn);
  });
}

function renderGroupFriendList() {
  els.groupFriendList.innerHTML = "";

  if (state.friends.length === 0) {
    els.groupFriendList.textContent = "Add friends before creating a group.";
    return;
  }

  state.friends.forEach((friend) => {
    const label = document.createElement("label");
    label.className = "group-friend-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(friend.user_id);
    const name = document.createElement("span");
    name.textContent = `@${friend.username}`;
    label.appendChild(checkbox);
    label.appendChild(name);
    els.groupFriendList.appendChild(label);
  });
}

function renderRequests() {
  els.requestList.innerHTML = "";

  if (state.requests.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No pending requests.";
    els.requestList.appendChild(empty);
    return;
  }

  state.requests.forEach((req) => {
    const card = document.createElement("div");
    card.className = "request-card";

    const label = document.createElement("div");
    label.className = "request-label";
    label.appendChild(buildAvatar(req.profile_image_path, req.username));
    const labelText = document.createElement("strong");
    labelText.textContent = `@${req.username}`;
    label.appendChild(labelText);

    const meta = document.createElement("small");
    meta.className = "status";
    meta.textContent = formatTimestamp(req.created_at);

    const acceptBtn = document.createElement("button");
    acceptBtn.className = "small";
    acceptBtn.textContent = "Accept";
    acceptBtn.addEventListener("click", async () => {
      try {
        setButtonBusy(acceptBtn, true, "Accept", "Accepting...");
        declineBtn.disabled = true;
        setFriendStatus(`Accepting @${req.username}...`);
        await withServerWakeMessage(
          () => window.codedApi.acceptFriendRequest(state.token, req.id),
          "Accepting friend request..."
        );
        await refreshSocialData();
        setFriendStatus(`Accepted @${req.username}.`);
      } catch (err) {
        setFriendStatus(normalizeErrorMessage(err));
      } finally {
        setButtonBusy(acceptBtn, false, "Accept", "");
        declineBtn.disabled = false;
      }
    });

    const declineBtn = document.createElement("button");
    declineBtn.className = "small muted-btn";
    declineBtn.textContent = "Decline";
    declineBtn.addEventListener("click", async () => {
      try {
        setButtonBusy(declineBtn, true, "Decline", "Declining...");
        acceptBtn.disabled = true;
        setFriendStatus(`Declining @${req.username}...`);
        await withServerWakeMessage(
          () => window.codedApi.declineFriendRequest(state.token, req.id),
          "Declining friend request..."
        );
        await refreshSocialData();
        setFriendStatus(`Declined @${req.username}.`);
      } catch (err) {
        setFriendStatus(normalizeErrorMessage(err));
      } finally {
        setButtonBusy(declineBtn, false, "Decline", "");
        acceptBtn.disabled = false;
      }
    });

    const actions = document.createElement("div");
    actions.className = "request-card-actions";
    actions.appendChild(acceptBtn);
    actions.appendChild(declineBtn);

    card.appendChild(label);
    card.appendChild(meta);
    card.appendChild(actions);
    els.requestList.appendChild(card);
  });
}

function renderOutgoingRequests() {
  els.outgoingRequestList.innerHTML = "";

  if (state.outgoingRequests.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No outgoing requests.";
    els.outgoingRequestList.appendChild(empty);
    return;
  }

  state.outgoingRequests.forEach((req) => {
    const card = document.createElement("div");
    card.className = "request-card";

    const label = document.createElement("div");
    label.className = "request-label";
    label.appendChild(buildAvatar(req.profile_image_path, req.username));
    const labelText = document.createElement("strong");
    labelText.textContent = `@${req.username}`;
    label.appendChild(labelText);

    const meta = document.createElement("small");
    meta.className = "status";
    meta.textContent = `Sent ${formatTimestamp(req.created_at)}`;

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "small muted-btn";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", async () => {
      try {
        setButtonBusy(cancelBtn, true, "Cancel", "Cancelling...");
        setFriendStatus(`Cancelling request to @${req.username}...`);
        await withServerWakeMessage(
          () => window.codedApi.cancelFriendRequest(state.token, req.id),
          "Cancelling outgoing request..."
        );
        await refreshSocialData();
        setFriendStatus(`Cancelled request to @${req.username}.`);
      } catch (err) {
        setFriendStatus(normalizeErrorMessage(err));
      } finally {
        setButtonBusy(cancelBtn, false, "Cancel", "");
      }
    });

    card.appendChild(label);
    card.appendChild(meta);
    card.appendChild(cancelBtn);
    els.outgoingRequestList.appendChild(card);
  });
}

function renderBlockedUsers() {
  els.blockedUserList.innerHTML = "";
  if (state.blockedUsers.length === 0) {
    els.blockedUserList.textContent = "No blocked users.";
    return;
  }

  state.blockedUsers.forEach((user) => {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.textContent = `@${user.username}`;
    const button = document.createElement("button");
    button.className = "muted-btn small";
    button.textContent = "Unblock";
    button.addEventListener("click", async () => {
      try {
        setButtonBusy(button, true, "Unblock", "Unblocking...");
        await window.codedApi.unblockUser(state.token, user.id);
        await refreshAccountSettings();
      } catch (err) {
        setProfileStatus(normalizeErrorMessage(err));
      } finally {
        setButtonBusy(button, false, "Unblock", "");
      }
    });
    row.appendChild(label);
    row.appendChild(button);
    els.blockedUserList.appendChild(row);
  });
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  state.sessions.forEach((session) => {
    const row = document.createElement("div");
    row.className = "settings-row";
    const label = document.createElement("span");
    label.textContent = `${session.current ? "This device" : "Signed-in device"} - active ${formatTimestamp(session.last_seen_at)}`;
    row.appendChild(label);

    if (!session.current) {
      const button = document.createElement("button");
      button.className = "muted-btn small";
      button.textContent = "Log Out";
      button.addEventListener("click", async () => {
        try {
          setButtonBusy(button, true, "Log Out", "Logging out...");
          await window.codedApi.revokeSession(state.token, session.id);
          await refreshAccountSettings();
        } catch (err) {
          setProfileStatus(normalizeErrorMessage(err));
        }
      });
      row.appendChild(button);
    }
    els.sessionList.appendChild(row);
  });
}

function renderMessages() {
  els.messages.innerHTML = "";

  if (!state.selectedConversationId) {
    els.chatTitle.textContent = "Select a chat";
    els.removeFriendBtn.classList.add("hidden");
    els.reportUserBtn.classList.add("hidden");
    els.blockUserBtn.classList.add("hidden");
    els.leaveGroupBtn.classList.add("hidden");
    return;
  }

  const selectedConversation = getSelectedConversation();
  const selectedFriend = getSelectedFriend();
  if (selectedConversation && selectedConversation.type === "group") {
    els.chatTitle.textContent = `${getConversationTitle(selectedConversation)} - ${selectedConversation.members.length} members`;
    els.removeFriendBtn.classList.add("hidden");
    els.reportUserBtn.classList.add("hidden");
    els.blockUserBtn.classList.add("hidden");
    els.leaveGroupBtn.classList.remove("hidden");
  } else {
    els.chatTitle.textContent = selectedFriend
      ? `Chat with @${selectedFriend.username} - ${formatPresence(selectedFriend)}`
      : "Direct Chat";
    els.removeFriendBtn.classList.remove("hidden");
    els.reportUserBtn.classList.remove("hidden");
    els.blockUserBtn.classList.remove("hidden");
    els.leaveGroupBtn.classList.add("hidden");
  }

  state.messages.forEach((m) => {
    const div = document.createElement("div");
    const fromMe = state.me && Number(m.sender_id) === Number(state.me.id);
    div.className = "msg " + (fromMe ? "me" : "them");

    const coded = document.createElement("div");
    const displayMode = m.display_mode === "plain" ? "plain" : "coded";
    coded.textContent = m.body
      ? displayMode === "plain"
        ? m.body
        : window.codedMessages.encode(m.body)
      : "";

    let attachment = null;
    if (m.attachment_data) {
      if (String(m.attachment_type || "").startsWith("image/")) {
        attachment = document.createElement("img");
        attachment.className = "message-attachment-image";
        attachment.src = m.attachment_data;
        attachment.alt = m.attachment_name || "Attached image";
      } else {
        attachment = document.createElement("a");
        attachment.className = "message-attachment-link";
        attachment.href = m.attachment_data;
        attachment.download = m.attachment_name || "attachment";
        attachment.textContent = `Download ${m.attachment_name || "attachment"}`;
      }
    }

    const meta = document.createElement("small");
    meta.textContent = `${fromMe ? "You" : m.sender_username} | ${displayMode === "plain" ? "Plain text" : "Encoded"} | ${formatTimestamp(m.created_at)}`;

    div.appendChild(coded);
    if (attachment) {
      div.appendChild(attachment);
    }
    div.appendChild(meta);
    els.messages.appendChild(div);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function fillProfileForm() {
  if (!state.me) return;
  els.profileUsername.value = state.me.username || "";
  state.profileImageData = state.me.profile_image_path || "";
  renderProfileImagePreview();
}

async function refreshMe() {
  const meResp = await withServerWakeMessage(
    () => window.codedApi.getMe(state.token),
    "Reconnecting to the cloud server..."
  );
  state.me = meResp.user;
  renderCurrentUser();
  fillProfileForm();
}

async function refreshAccountSettings() {
  const [blockedResp, sessionsResp] = await Promise.all([
    window.codedApi.getBlockedUsers(state.token),
    window.codedApi.getSessions(state.token)
  ]);
  state.blockedUsers = blockedResp.blocked || [];
  state.sessions = sessionsResp.sessions || [];
  renderBlockedUsers();
  renderSessions();
}

async function refreshSocialData() {
  const [friendsResp, requestsResp, conversationsResp] = await withServerWakeMessage(
    () => Promise.all([
      window.codedApi.getFriends(state.token),
      window.codedApi.getFriendRequests(state.token),
      window.codedApi.getConversations(state.token)
    ]),
    "Syncing chats and requests..."
  );

  state.friends = friendsResp.friends || [];
  state.conversations = conversationsResp.conversations || [];
  state.requests = requestsResp.requests || [];
  state.outgoingRequests = requestsResp.outgoing || [];

  if (!state.selectedConversationId) {
    const first = state.conversations[0];
    if (first) {
      state.selectedConversationId = first.id;
      state.selectedUsername = getConversationTitle(first);
    }
  } else {
    const selected = getSelectedConversation();
    if (!selected) {
      state.selectedConversationId = null;
      state.selectedUsername = "";
      state.messages = [];
    } else {
      state.selectedUsername = getConversationTitle(selected);
    }
  }

  renderFriends();
  renderGroupFriendList();
  renderRequests();
  renderOutgoingRequests();
  await loadMessages();
}

async function loadMessages({ silent = false } = {}) {
  if (!state.selectedConversationId) {
    state.messages = [];
    renderMessages();
    return;
  }

  if (!silent) {
    setChatStatus("Loading messages...");
  }
  const resp = silent
    ? await window.codedApi.getMessages(state.token, state.selectedConversationId)
    : await withServerWakeMessage(
        () => window.codedApi.getMessages(state.token, state.selectedConversationId),
        "Loading conversation from the cloud..."
      );
  state.messages = resp.messages;
  if (!silent) {
    setChatStatus("");
  }
  renderMessages();
}

async function backgroundSync() {
  if (!state.token || !state.me) {
    return;
  }

  try {
    const [friendsResp, requestsResp, conversationsResp] = await Promise.all([
      window.codedApi.getFriends(state.token),
      window.codedApi.getFriendRequests(state.token),
      window.codedApi.getConversations(state.token),
      window.codedApi.heartbeat(state.token)
    ]);
    state.friends = friendsResp.friends || [];
    state.conversations = conversationsResp.conversations || [];
    state.requests = requestsResp.requests || [];
    state.outgoingRequests = requestsResp.outgoing || [];

    if (state.selectedConversationId) {
      const selected = getSelectedConversation();
      if (!selected) {
        state.selectedConversationId = null;
        state.selectedUsername = "";
        state.messages = [];
      } else {
        state.selectedUsername = getConversationTitle(selected);
      }
    }

    renderFriends();
    renderGroupFriendList();
    renderRequests();
    renderOutgoingRequests();
    await loadMessages({ silent: true });
  } catch (err) {
    if (String(err.message || "").includes("Session expired")) {
      clearSessionState();
      showAuth(true);
      els.authError.textContent = "Your session ended. Please sign in again.";
    }
  }
}

function startBackgroundSync() {
  clearInterval(syncTimer);
  syncTimer = setInterval(backgroundSync, 5000);
}

function stopBackgroundSync() {
  clearInterval(syncTimer);
  syncTimer = null;
}

async function bootstrap() {
  setAuthMode("login");
  setView("chat");
  syncMessageModeControls();
  setChatStatus("");

  if (!state.token) {
    clearDecrypter();
    showAuth(true);
    hideConnectionBanner();
    return;
  }

  try {
    await refreshMe();
    await refreshSocialData();
    await refreshAccountSettings();
    showAuth(false);
    startBackgroundSync();
  } catch (_err) {
    setToken("");
    state.me = null;
    clearDecrypter();
    showAuth(true);
    els.authError.textContent = "Session expired or the server could not be reached. Sign in again.";
  }
}

function wireEvents() {
  document.querySelectorAll(".menu-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      setView(btn.dataset.view);
      if (btn.dataset.view === "profile" && state.token) {
        refreshAccountSettings().catch((err) => {
          setProfileStatus(normalizeErrorMessage(err));
        });
      }
    });
  });

  els.authSwitch.addEventListener("click", () => {
    clearAuthFields();
    setAuthMode(state.authMode === "login" ? "register" : "login");
  });

  els.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.authError.textContent = "";

    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const username = els.authUsername.value.trim();

    try {
      const idleText = state.authMode === "register"
        ? "Create Account"
        : "Sign In";
      const busyText = state.authMode === "register"
        ? "Creating..."
        : "Signing In...";
      setButtonBusy(els.authSubmit, true, idleText, busyText);

      const resp = state.authMode === "register"
        ? await withServerWakeMessage(
            () => window.codedApi.register({ email, password, username }),
            "Creating your account and waking the server..."
          )
        : await withServerWakeMessage(
            () => window.codedApi.login({ email, password }),
            "Signing in and connecting to the server..."
          );

      setToken(resp.token);
      state.me = resp.user;
      clearDecrypter();
      showAuth(false);
      renderCurrentUser();
      fillProfileForm();
      await refreshSocialData();
      await refreshAccountSettings();
      startBackgroundSync();

      els.authPassword.value = "";
      setFriendStatus("");
    } catch (err) {
      els.authError.textContent = normalizeErrorMessage(err);
    } finally {
      const idleText = state.authMode === "register"
        ? "Create Account"
        : "Sign In";
      setButtonBusy(els.authSubmit, false, idleText, "");
    }
  });

  els.logoutBtn.addEventListener("click", async () => {
    try {
      if (state.token) {
        await window.codedApi.logout(state.token);
      }
    } catch (_err) {
      // Local logout still clears the token if the server is unavailable.
    }
    clearSessionState();
    showAuth(true);
  });

  els.friendAddBtn.addEventListener("click", async () => {
    const username = els.friendUsernameInput.value.trim();
    if (!username) {
      setFriendStatus("Enter a username first.");
      return;
    }

    try {
      setButtonBusy(els.friendAddBtn, true, "Add", "Sending...");
      setFriendStatus("Sending friend request...");
      await withServerWakeMessage(
        () => window.codedApi.sendFriendRequest(state.token, username),
        "Sending friend request to the cloud server..."
      );
      els.friendUsernameInput.value = "";
      setFriendStatus(`Friend request sent to @${username}.`);
      try {
        await refreshSocialData();
      } catch (_refreshErr) {
        setFriendStatus(`Friend request sent to @${username}. Refresh the app if the lists look out of date.`);
      }
    } catch (err) {
      setFriendStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.friendAddBtn, false, "Add", "");
    }
  });

  els.groupCreateBtn.addEventListener("click", async () => {
    const title = els.groupTitleInput.value.trim();
    const memberIds = Array.from(els.groupFriendList.querySelectorAll("input[type='checkbox']:checked"))
      .map((checkbox) => Number(checkbox.value))
      .filter(Boolean);

    if (!title) {
      setGroupStatus("Enter a group name.");
      return;
    }
    if (memberIds.length === 0) {
      setGroupStatus("Choose at least one friend.");
      return;
    }

    try {
      setButtonBusy(els.groupCreateBtn, true, "Create Group", "Creating...");
      setGroupStatus("Creating group...");
      const resp = await withServerWakeMessage(
        () => window.codedApi.createGroupConversation(state.token, title, memberIds),
        "Creating group chat..."
      );
      els.groupTitleInput.value = "";
      els.groupFriendList.querySelectorAll("input[type='checkbox']").forEach((checkbox) => {
        checkbox.checked = false;
      });
      state.selectedConversationId = resp.conversation_id;
      state.selectedUsername = title;
      await refreshSocialData();
      setGroupStatus(`Created "${title}".`);
    } catch (err) {
      setGroupStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.groupCreateBtn, false, "Create Group", "");
    }
  });

  els.sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = els.messageInput.value.trim();

    if ((!body && !state.pendingAttachment) || !state.selectedConversationId) {
      if (!state.selectedConversationId) {
        setChatStatus("Choose a chat before sending a message.");
      }
      return;
    }

    try {
      const sendButton = els.sendForm.querySelector("button[type='submit']");
      setButtonBusy(sendButton, true, "Send", "Sending...");
      setChatStatus(`Sending ${state.messageDisplayMode === "plain" ? "plain-text" : "encoded"} message...`);
      await withServerWakeMessage(
        () => window.codedApi.sendMessage(
          state.token,
          state.selectedConversationId,
          body,
          state.messageDisplayMode,
          state.pendingAttachment
        ),
        "Sending your message to the cloud server..."
      );
      els.messageInput.value = "";
      state.pendingAttachment = null;
      renderAttachmentPreview();
      await loadMessages();
      setChatStatus(`Sent as ${state.messageDisplayMode === "plain" ? "plain text" : "encoded"} text.`);
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      const sendButton = els.sendForm.querySelector("button[type='submit']");
      setButtonBusy(sendButton, false, "Send", "");
    }
  });

  els.attachBtn.addEventListener("click", async () => {
    try {
      const attachment = await window.codedApi.chooseMessageAttachment();
      if (attachment) {
        state.pendingAttachment = attachment;
        renderAttachmentPreview();
        setChatStatus("Attachment ready to send.");
      }
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err, "Couldn't attach that file."));
    }
  });

  els.attachmentClear.addEventListener("click", () => {
    state.pendingAttachment = null;
    renderAttachmentPreview();
    setChatStatus("");
  });

  els.decodeBtn.addEventListener("click", () => {
    els.decodedOutput.value = window.codedMessages.decode(els.codedInput.value);
  });

  els.profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    try {
      const submitButton = els.profileForm.querySelector("button[type='submit']");
      setButtonBusy(submitButton, true, "Save Profile", "Saving...");
      setProfileStatus("Saving profile...");
      const resp = await withServerWakeMessage(
        () => window.codedApi.updateProfile(state.token, {
          username: els.profileUsername.value.trim(),
          profile_image_path: state.profileImageData
        }),
        "Saving your profile to the cloud..."
      );
      state.me = resp.user;
      renderCurrentUser();
      setProfileStatus("Profile saved.");
      await refreshSocialData();
    } catch (err) {
      setProfileStatus(normalizeErrorMessage(err));
    } finally {
      const submitButton = els.profileForm.querySelector("button[type='submit']");
      setButtonBusy(submitButton, false, "Save Profile", "");
    }
  });

  els.removeFriendBtn.addEventListener("click", async () => {
    const selectedFriend = getSelectedFriend();
    if (!selectedFriend) {
      return;
    }

    const confirmed = window.confirm(
      `Remove @${selectedFriend.username} from your friends list? This also removes your shared conversation history.`
    );
    if (!confirmed) {
      return;
    }

    try {
      setButtonBusy(els.removeFriendBtn, true, "Remove Friend", "Removing...");
      setChatStatus(`Removing @${selectedFriend.username}...`);
      await withServerWakeMessage(
        () => window.codedApi.removeFriend(state.token, selectedFriend.user_id),
        "Updating your friends list..."
      );
      state.selectedConversationId = null;
      state.selectedUsername = "";
      state.messages = [];
      await refreshSocialData();
      setChatStatus(`Removed @${selectedFriend.username}.`);
      renderMessages();
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.removeFriendBtn, false, "Remove Friend", "");
    }
  });

  els.blockUserBtn.addEventListener("click", async () => {
    const selectedFriend = getSelectedFriend();
    if (!selectedFriend) {
      return;
    }

    const confirmed = window.confirm(
      `Block @${selectedFriend.username}? This removes the friendship and shared conversation history.`
    );
    if (!confirmed) {
      return;
    }

    try {
      setButtonBusy(els.blockUserBtn, true, "Block", "Blocking...");
      await withServerWakeMessage(
        () => window.codedApi.blockUser(state.token, selectedFriend.user_id),
        "Updating your blocked users..."
      );
      state.selectedConversationId = null;
      state.selectedUsername = "";
      state.messages = [];
      await refreshSocialData();
      await refreshAccountSettings();
      renderMessages();
      setChatStatus(`Blocked @${selectedFriend.username}.`);
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.blockUserBtn, false, "Block", "");
    }
  });

  els.leaveGroupBtn.addEventListener("click", async () => {
    const selectedConversation = getSelectedConversation();
    if (!selectedConversation || selectedConversation.type !== "group") {
      return;
    }

    const confirmed = window.confirm(`Leave "${getConversationTitle(selectedConversation)}"?`);
    if (!confirmed) {
      return;
    }

    try {
      setButtonBusy(els.leaveGroupBtn, true, "Leave Group", "Leaving...");
      await withServerWakeMessage(
        () => window.codedApi.leaveConversation(state.token, selectedConversation.id),
        "Leaving group chat..."
      );
      state.selectedConversationId = null;
      state.selectedUsername = "";
      state.messages = [];
      await refreshSocialData();
      setChatStatus("Left group chat.");
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.leaveGroupBtn, false, "Leave Group", "");
    }
  });

  els.reportUserBtn.addEventListener("click", async () => {
    const selectedFriend = getSelectedFriend();
    if (!selectedFriend) {
      return;
    }

    const input = window.prompt(
      `Report @${selectedFriend.username}. Enter one reason: harassment, spam, impersonation, or other.`
    );
    if (input === null) {
      return;
    }

    const reason = input.trim().toLowerCase();
    if (!["harassment", "spam", "impersonation", "other"].includes(reason)) {
      setChatStatus("Report reason must be harassment, spam, impersonation, or other.");
      return;
    }

    try {
      setButtonBusy(els.reportUserBtn, true, "Report", "Reporting...");
      await window.codedApi.reportUser(state.token, selectedFriend.user_id, reason);
      setChatStatus(`Report submitted for @${selectedFriend.username}.`);
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.reportUserBtn, false, "Report", "");
    }
  });

  els.profileImageBrowse.addEventListener("click", async () => {
    try {
      const selectedImage = await window.codedApi.chooseProfileImage();
      if (selectedImage) {
        state.profileImageData = selectedImage;
        renderProfileImagePreview();
        setProfileStatus("Profile image selected. Save profile to apply it.");
      }
    } catch (err) {
      setProfileStatus(normalizeErrorMessage(err, "Couldn't open the image picker."));
    }
  });

  els.profileImageClear.addEventListener("click", () => {
    state.profileImageData = "";
    renderProfileImagePreview();
    setProfileStatus("Profile image removed. Save profile to apply it.");
  });

  els.sessionsRevokeOthers.addEventListener("click", async () => {
    try {
      setButtonBusy(els.sessionsRevokeOthers, true, "Log Out Other Sessions", "Logging out...");
      await window.codedApi.revokeOtherSessions(state.token);
      await refreshAccountSettings();
      setProfileStatus("Other sessions logged out.");
    } catch (err) {
      setProfileStatus(normalizeErrorMessage(err));
    } finally {
      setButtonBusy(els.sessionsRevokeOthers, false, "Log Out Other Sessions", "");
    }
  });

  document.querySelectorAll("input[name='message-display-mode']").forEach((input) => {
    input.addEventListener("change", () => {
      state.messageDisplayMode = input.value === "plain" ? "plain" : "coded";
      setChatStatus(`New messages will send as ${state.messageDisplayMode === "plain" ? "plain text" : "encoded text"}.`);
    });
  });
}

wireEvents();
bootstrap();

