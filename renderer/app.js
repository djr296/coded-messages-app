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
  requests: [],
  outgoingRequests: [],
  selectedConversationId: null,
  selectedUsername: "",
  messages: [],
  messageDisplayMode: "coded"
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
  authResetCodeWrap: document.getElementById("auth-reset-code-wrap"),
  authResetCode: document.getElementById("auth-reset-code"),
  authSubmit: document.getElementById("auth-submit"),
  authSwitch: document.getElementById("auth-switch"),
  authForgot: document.getElementById("auth-forgot"),
  authError: document.getElementById("auth-error"),

  currentUser: document.getElementById("current-user"),
  logoutBtn: document.getElementById("logout-btn"),

  chatList: document.getElementById("chat-list"),
  requestList: document.getElementById("request-list"),
  outgoingRequestList: document.getElementById("outgoing-request-list"),
  removeFriendBtn: document.getElementById("remove-friend-btn"),

  friendUsernameInput: document.getElementById("friend-username-input"),
  friendAddBtn: document.getElementById("friend-add-btn"),
  friendStatus: document.getElementById("friend-status"),

  connectionBanner: document.getElementById("connection-banner"),
  chatTitle: document.getElementById("chat-title"),
  messages: document.getElementById("messages"),
  sendForm: document.getElementById("send-form"),
  messageInput: document.getElementById("message-input"),
  chatStatus: document.getElementById("chat-status"),
  messageModeCoded: document.getElementById("message-mode-coded"),
  messageModePlain: document.getElementById("message-mode-plain"),

  codedInput: document.getElementById("coded-input"),
  decodedOutput: document.getElementById("decoded-output"),
  decodeBtn: document.getElementById("decode-btn"),

  profileForm: document.getElementById("profile-form"),
  profileUsername: document.getElementById("profile-username"),
  profileImagePath: document.getElementById("profile-image-path"),
  profileImageBrowse: document.getElementById("profile-image-browse"),
  profileStatus: document.getElementById("profile-status")
};

const views = {
  chat: document.getElementById("chat-view"),
  decrypt: document.getElementById("decrypt-view"),
  profile: document.getElementById("profile-view")
};

let connectionBannerTimer = null;

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
  const requestReset = mode === "reset-request";
  const confirmReset = mode === "reset-confirm";

  els.authSubtitle.textContent = register
    ? "Create your account."
    : requestReset
      ? "Enter your email and we'll send a reset code."
      : confirmReset
        ? "Enter your reset code and choose a new password."
        : "Sign in to continue.";
  els.authSubmit.textContent = register
    ? "Create Account"
    : requestReset
      ? "Send Reset Code"
      : confirmReset
        ? "Reset Password"
        : "Sign In";
  els.authSwitch.textContent = register
    ? "I already have an account"
    : requestReset || confirmReset
      ? "Back to sign in"
      : "Create account";
  els.authUsernameWrap.classList.toggle("hidden", !register);
  els.authUsername.required = register;
  els.authPasswordLabel.classList.toggle("hidden", requestReset);
  els.authPassword.classList.toggle("hidden", requestReset);
  els.authPassword.required = !requestReset;
  els.authResetCodeWrap.classList.toggle("hidden", !confirmReset);
  els.authResetCode.required = confirmReset;
  els.authForgot.classList.toggle("hidden", register || requestReset || confirmReset);
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
  els.authResetCode.value = "";
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

function getSelectedFriend() {
  if (!state.selectedConversationId) {
    return null;
  }

  return state.friends.find((friend) => friend.conversation_id === state.selectedConversationId) || null;
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

function renderCurrentUser() {
  if (!state.me) {
    els.currentUser.textContent = "Not signed in";
    return;
  }

  els.currentUser.innerHTML = "";
  els.currentUser.appendChild(buildAvatar(state.me.profile_image_path, state.me.username));

  const details = document.createElement("div");
  details.className = "user-summary";
  details.innerHTML = `<strong>@${state.me.username}</strong><span>${state.me.email}</span>`;
  els.currentUser.appendChild(details);
}

function renderFriends() {
  els.chatList.innerHTML = "";

  if (state.friends.length === 0) {
    const empty = document.createElement("div");
    empty.className = "status";
    empty.textContent = "No friends yet.";
    els.chatList.appendChild(empty);
    return;
  }

  state.friends.forEach((friend) => {
    const btn = document.createElement("button");
    const isActive = friend.conversation_id === state.selectedConversationId;
    btn.className = "contact-btn" + (isActive ? " active" : "");
    btn.appendChild(buildAvatar(friend.profile_image_path, friend.username));

    const details = document.createElement("div");
    details.className = "contact-summary";
    details.innerHTML = `<strong>@${friend.username}</strong>`;
    btn.appendChild(details);
    btn.addEventListener("click", () => {
      state.selectedConversationId = friend.conversation_id;
      state.selectedUsername = friend.username;
      setChatStatus("Loading conversation...");
      renderFriends();
      loadMessages().catch((err) => {
        setChatStatus(normalizeErrorMessage(err));
      });
    });
    els.chatList.appendChild(btn);
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

function renderMessages() {
  els.messages.innerHTML = "";

  if (!state.selectedConversationId) {
    els.chatTitle.textContent = "Select a friend";
    els.removeFriendBtn.classList.add("hidden");
    return;
  }

  els.chatTitle.textContent = "Chat with @" + state.selectedUsername;
  els.removeFriendBtn.classList.remove("hidden");

  state.messages.forEach((m) => {
    const div = document.createElement("div");
    const fromMe = state.me && Number(m.sender_id) === Number(state.me.id);
    div.className = "msg " + (fromMe ? "me" : "them");

    const coded = document.createElement("div");
    const displayMode = m.display_mode === "plain" ? "plain" : "coded";
    coded.textContent = displayMode === "plain" ? m.body : window.codedMessages.encode(m.body);

    const meta = document.createElement("small");
    meta.textContent = `${fromMe ? "You" : m.sender_username} • ${displayMode === "plain" ? "Plain text" : "Encoded"} • ${formatTimestamp(m.created_at)}`;

    div.appendChild(coded);
    div.appendChild(meta);
    els.messages.appendChild(div);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function fillProfileForm() {
  if (!state.me) return;
  els.profileUsername.value = state.me.username || "";
  els.profileImagePath.value = state.me.profile_image_path || "";
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

async function refreshSocialData() {
  const [friendsResp, requestsResp] = await withServerWakeMessage(
    () => Promise.all([
      window.codedApi.getFriends(state.token),
      window.codedApi.getFriendRequests(state.token)
    ]),
    "Syncing chats and requests..."
  );

  state.friends = friendsResp.friends;
  state.requests = requestsResp.requests;
  state.outgoingRequests = requestsResp.outgoing || [];

  if (!state.selectedConversationId) {
    const first = state.friends.find((f) => f.conversation_id);
    if (first) {
      state.selectedConversationId = first.conversation_id;
      state.selectedUsername = first.username;
    }
  } else {
    const selected = state.friends.find((f) => f.conversation_id === state.selectedConversationId);
    if (!selected) {
      state.selectedConversationId = null;
      state.selectedUsername = "";
      state.messages = [];
    } else {
      state.selectedUsername = selected.username;
    }
  }

  renderFriends();
  renderRequests();
  renderOutgoingRequests();
  await loadMessages();
}

async function loadMessages() {
  if (!state.selectedConversationId) {
    state.messages = [];
    renderMessages();
    return;
  }

  setChatStatus("Loading messages...");
  const resp = await withServerWakeMessage(
    () => window.codedApi.getMessages(state.token, state.selectedConversationId),
    "Loading conversation from the cloud..."
  );
  state.messages = resp.messages;
  setChatStatus("");
  renderMessages();
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
    showAuth(false);
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
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  els.authSwitch.addEventListener("click", () => {
    clearAuthFields();
    setAuthMode(state.authMode === "login" ? "register" : "login");
  });

  els.authForgot.addEventListener("click", () => {
    clearAuthFields({ keepEmail: true });
    setAuthMode("reset-request");
  });

  els.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.authError.textContent = "";

    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const username = els.authUsername.value.trim();
    const resetCode = els.authResetCode.value.trim();

    try {
      const idleText = state.authMode === "register"
        ? "Create Account"
        : state.authMode === "reset-request"
          ? "Send Reset Code"
          : state.authMode === "reset-confirm"
            ? "Reset Password"
            : "Sign In";
      const busyText = state.authMode === "register"
        ? "Creating..."
        : state.authMode === "reset-request"
          ? "Sending..."
          : state.authMode === "reset-confirm"
            ? "Resetting..."
            : "Signing In...";
      setButtonBusy(els.authSubmit, true, idleText, busyText);

      if (state.authMode === "reset-request") {
        const resp = await withServerWakeMessage(
          () => window.codedApi.requestPasswordReset({ email }),
          "Requesting a password reset code..."
        );
        els.authError.textContent = resp.message;
        setAuthMode("reset-confirm");
        els.authEmail.value = email;
        return;
      }

      if (state.authMode === "reset-confirm") {
        const resp = await withServerWakeMessage(
          () => window.codedApi.resetPassword({ email, code: resetCode, password }),
          "Updating your password..."
        );
        clearAuthFields({ keepEmail: true });
        setAuthMode("login");
        els.authError.textContent = resp.message;
        return;
      }

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

      els.authPassword.value = "";
      setFriendStatus("");
    } catch (err) {
      els.authError.textContent = normalizeErrorMessage(err);
    } finally {
      const idleText = state.authMode === "register"
        ? "Create Account"
        : state.authMode === "reset-request"
          ? "Send Reset Code"
          : state.authMode === "reset-confirm"
            ? "Reset Password"
            : "Sign In";
      setButtonBusy(els.authSubmit, false, idleText, "");
    }
  });

  els.logoutBtn.addEventListener("click", () => {
    state.me = null;
    state.friends = [];
    state.requests = [];
    state.outgoingRequests = [];
    state.messages = [];
    state.selectedConversationId = null;
    state.selectedUsername = "";
    state.messageDisplayMode = "coded";
    syncMessageModeControls();
    setToken("");
    clearDecrypter();
    clearAuthFields();
    setAuthMode("login");
    renderCurrentUser();
    renderFriends();
    renderRequests();
    renderOutgoingRequests();
    renderMessages();
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

  els.sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = els.messageInput.value.trim();

    if (!body || !state.selectedConversationId) {
      if (!state.selectedConversationId) {
        setChatStatus("Choose a friend before sending a message.");
      }
      return;
    }

    try {
      const sendButton = els.sendForm.querySelector("button[type='submit']");
      setButtonBusy(sendButton, true, "Send", "Sending...");
      setChatStatus(`Sending ${state.messageDisplayMode === "plain" ? "plain-text" : "encoded"} message...`);
      await withServerWakeMessage(
        () => window.codedApi.sendMessage(state.token, state.selectedConversationId, body, state.messageDisplayMode),
        "Sending your message to the cloud server..."
      );
      els.messageInput.value = "";
      await loadMessages();
      setChatStatus(`Sent as ${state.messageDisplayMode === "plain" ? "plain text" : "encoded"} text.`);
    } catch (err) {
      setChatStatus(normalizeErrorMessage(err));
    } finally {
      const sendButton = els.sendForm.querySelector("button[type='submit']");
      setButtonBusy(sendButton, false, "Send", "");
    }
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
          profile_image_path: els.profileImagePath.value.trim()
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

  els.profileImageBrowse.addEventListener("click", async () => {
    try {
      const selectedPath = await window.codedApi.chooseProfileImage();
      if (selectedPath) {
        els.profileImagePath.value = selectedPath;
        setProfileStatus("Profile image selected. Save profile to apply it.");
      }
    } catch (err) {
      setProfileStatus(normalizeErrorMessage(err, "Couldn't open the image picker."));
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

