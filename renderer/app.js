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
  selectedConversationId: null,
  selectedUsername: "",
  messages: []
};

const els = {
  authOverlay: document.getElementById("auth-overlay"),
  authSubtitle: document.getElementById("auth-subtitle"),
  authForm: document.getElementById("auth-form"),
  authEmail: document.getElementById("auth-email"),
  authPassword: document.getElementById("auth-password"),
  authUsernameWrap: document.getElementById("auth-username-wrap"),
  authUsername: document.getElementById("auth-username"),
  authSubmit: document.getElementById("auth-submit"),
  authSwitch: document.getElementById("auth-switch"),
  authError: document.getElementById("auth-error"),

  currentUser: document.getElementById("current-user"),
  logoutBtn: document.getElementById("logout-btn"),

  chatList: document.getElementById("chat-list"),
  requestList: document.getElementById("request-list"),

  friendUsernameInput: document.getElementById("friend-username-input"),
  friendAddBtn: document.getElementById("friend-add-btn"),
  friendStatus: document.getElementById("friend-status"),

  chatTitle: document.getElementById("chat-title"),
  messages: document.getElementById("messages"),
  sendForm: document.getElementById("send-form"),
  messageInput: document.getElementById("message-input"),

  codedInput: document.getElementById("coded-input"),
  decodedOutput: document.getElementById("decoded-output"),
  decodeBtn: document.getElementById("decode-btn"),

  profileForm: document.getElementById("profile-form"),
  profileUsername: document.getElementById("profile-username"),
  profileImagePath: document.getElementById("profile-image-path"),
  profileStatus: document.getElementById("profile-status")
};

const views = {
  chat: document.getElementById("chat-view"),
  decrypt: document.getElementById("decrypt-view"),
  profile: document.getElementById("profile-view")
};

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

  els.authSubtitle.textContent = register ? "Create your account." : "Sign in to continue.";
  els.authSubmit.textContent = register ? "Create Account" : "Sign In";
  els.authSwitch.textContent = register ? "I already have an account" : "Create account";
  els.authUsernameWrap.classList.toggle("hidden", !register);
  els.authUsername.required = register;
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

function setProfileStatus(text) {
  els.profileStatus.textContent = text || "";
}

function clearDecrypter() {
  els.codedInput.value = "";
  els.decodedOutput.value = "";
}

function renderCurrentUser() {
  if (!state.me) {
    els.currentUser.textContent = "Not signed in";
    return;
  }
  els.currentUser.textContent = `@${state.me.username} (${state.me.email})`;
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
    btn.textContent = "@" + friend.username;
    btn.addEventListener("click", () => {
      state.selectedConversationId = friend.conversation_id;
      state.selectedUsername = friend.username;
      renderFriends();
      loadMessages();
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
    label.textContent = `@${req.username}`;

    const btn = document.createElement("button");
    btn.className = "small";
    btn.textContent = "Accept";
    btn.addEventListener("click", async () => {
      try {
        await window.codedApi.acceptFriendRequest(state.token, req.id);
        await refreshSocialData();
        setFriendStatus(`Accepted @${req.username}.`);
      } catch (err) {
        setFriendStatus(err.message);
      }
    });

    card.appendChild(label);
    card.appendChild(btn);
    els.requestList.appendChild(card);
  });
}

function renderMessages() {
  els.messages.innerHTML = "";

  if (!state.selectedConversationId) {
    els.chatTitle.textContent = "Select a friend";
    return;
  }

  els.chatTitle.textContent = "Chat with @" + state.selectedUsername;

  state.messages.forEach((m) => {
    const div = document.createElement("div");
    const fromMe = state.me && Number(m.sender_id) === Number(state.me.id);
    div.className = "msg " + (fromMe ? "me" : "them");

    const coded = document.createElement("div");
    coded.textContent = window.codedMessages.encode(m.body);

    const meta = document.createElement("small");
    meta.textContent = fromMe ? "You" : m.sender_username;

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
  const meResp = await window.codedApi.getMe(state.token);
  state.me = meResp.user;
  renderCurrentUser();
  fillProfileForm();
}

async function refreshSocialData() {
  const [friendsResp, requestsResp] = await Promise.all([
    window.codedApi.getFriends(state.token),
    window.codedApi.getFriendRequests(state.token)
  ]);

  state.friends = friendsResp.friends;
  state.requests = requestsResp.requests;

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
  await loadMessages();
}

async function loadMessages() {
  if (!state.selectedConversationId) {
    state.messages = [];
    renderMessages();
    return;
  }

  const resp = await window.codedApi.getMessages(state.token, state.selectedConversationId);
  state.messages = resp.messages;
  renderMessages();
}

async function bootstrap() {
  setAuthMode("login");
  setView("chat");

  if (!state.token) {
    clearDecrypter();
    showAuth(true);
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
  }
}

function wireEvents() {
  document.querySelectorAll(".menu-item").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  els.authSwitch.addEventListener("click", () => {
    setAuthMode(state.authMode === "login" ? "register" : "login");
  });

  els.authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.authError.textContent = "";

    const email = els.authEmail.value.trim();
    const password = els.authPassword.value;
    const username = els.authUsername.value.trim();

    try {
      const resp = state.authMode === "register"
        ? await window.codedApi.register({ email, password, username })
        : await window.codedApi.login({ email, password });

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
      els.authError.textContent = err.message;
    }
  });

  els.logoutBtn.addEventListener("click", () => {
    state.me = null;
    state.friends = [];
    state.requests = [];
    state.messages = [];
    state.selectedConversationId = null;
    state.selectedUsername = "";
    setToken("");
    clearDecrypter();
    renderCurrentUser();
    renderFriends();
    renderRequests();
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
      await window.codedApi.sendFriendRequest(state.token, username);
      els.friendUsernameInput.value = "";
      setFriendStatus(`Friend request sent to @${username}.`);
      try {
        await refreshSocialData();
      } catch (_refreshErr) {
        setFriendStatus(`Friend request sent to @${username}. Refresh the app if the lists look out of date.`);
      }
    } catch (err) {
      setFriendStatus(err.message);
    }
  });

  els.sendForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = els.messageInput.value.trim();

    if (!body || !state.selectedConversationId) {
      return;
    }

    try {
      await window.codedApi.sendMessage(state.token, state.selectedConversationId, body);
      els.messageInput.value = "";
      await loadMessages();
    } catch (err) {
      setFriendStatus(err.message);
    }
  });

  els.decodeBtn.addEventListener("click", () => {
    els.decodedOutput.value = window.codedMessages.decode(els.codedInput.value);
  });

  els.profileForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    try {
      const resp = await window.codedApi.updateProfile(state.token, {
        username: els.profileUsername.value.trim(),
        profile_image_path: els.profileImagePath.value.trim()
      });
      state.me = resp.user;
      renderCurrentUser();
      setProfileStatus("Profile saved.");
      await refreshSocialData();
    } catch (err) {
      setProfileStatus(err.message);
    }
  });
}

wireEvents();
bootstrap();

