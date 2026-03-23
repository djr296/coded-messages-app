const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");

const JWT_SECRET = process.env.CODED_MESSAGES_JWT_SECRET || "dev-secret-change-me";

function nowIso() {
  return new Date().toISOString();
}

function makePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

async function createDb(dbPath) {
  const SQL = await initSqlJs({
    locateFile: (file) => path.join(path.dirname(require.resolve("sql.js/dist/sql-wasm.js")), file)
  });

  let db;
  if (fs.existsSync(dbPath)) {
    db = new SQL.Database(fs.readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  const persist = () => {
    const bytes = db.export();
    fs.writeFileSync(dbPath, Buffer.from(bytes));
  };

  const exec = (sql, params = {}) => {
    db.run(sql, params);
  };

  const all = (sql, params = {}) => {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  };

  const get = (sql, params = {}) => {
    const rows = all(sql, params);
    return rows[0] || null;
  };

  const createStatements = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      profile_image_path TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS friend_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      responded_at TEXT,
      UNIQUE(from_user_id, to_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS friendships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_a_id INTEGER NOT NULL,
      user_b_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_a_id, user_b_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS conversation_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      UNIQUE(conversation_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`
  ];

  createStatements.forEach((stmt) => exec(stmt));
  persist();

  return {
    exec,
    all,
    get,
    persist
  };
}

function publicUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    profile_image_path: row.profile_image_path || ""
  };
}

function authMiddleware(db) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing token." });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = db.get("SELECT * FROM users WHERE id = $id", { $id: decoded.userId });
      if (!user) {
        return res.status(401).json({ error: "Invalid token." });
      }
      req.user = user;
      next();
    } catch (_err) {
      return res.status(401).json({ error: "Invalid token." });
    }
  };
}

async function createApiServer({ host = "127.0.0.1", port = 3847, dbPath } = {}) {
  const resolvedDbPath = dbPath || path.join(__dirname, "..", "data", "app.sqlite");
  fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });

  const db = await createDb(resolvedDbPath);
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/auth/register", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    let username = String(req.body.username || "").trim();

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    if (!username) {
      username = email.split("@")[0];
    }

    const existingEmail = db.get("SELECT id FROM users WHERE email = $email", { $email: email });
    if (existingEmail) {
      return res.status(400).json({ error: "Email already in use." });
    }

    const existingUsername = db.get("SELECT id FROM users WHERE lower(username) = lower($username)", {
      $username: username
    });
    if (existingUsername) {
      return res.status(400).json({ error: "Username already taken." });
    }

    const hash = bcrypt.hashSync(password, 10);
    db.exec(
      "INSERT INTO users (email, password_hash, username, profile_image_path, created_at) VALUES ($email, $hash, $username, '', $created)",
      { $email: email, $hash: hash, $username: username, $created: nowIso() }
    );

    const user = db.get("SELECT * FROM users WHERE email = $email", { $email: email });
    db.persist();

    const token = jwt.sign({ userId: Number(user.id) }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: publicUser(user) });
  });

  app.post("/auth/login", (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    const user = db.get("SELECT * FROM users WHERE email = $email", { $email: email });
    if (!user) {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "Invalid credentials." });
    }

    const token = jwt.sign({ userId: Number(user.id) }, JWT_SECRET, { expiresIn: "7d" });
    return res.json({ token, user: publicUser(user) });
  });

  const requireAuth = authMiddleware(db);

  app.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.patch("/me/profile", requireAuth, (req, res) => {
    const username = String(req.body.username || "").trim();
    const profileImagePath = String(req.body.profile_image_path || "").trim();

    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const duplicate = db.get(
      "SELECT id FROM users WHERE lower(username) = lower($username) AND id != $id",
      { $username: username, $id: req.user.id }
    );

    if (duplicate) {
      return res.status(400).json({ error: "Username already taken." });
    }

    db.exec(
      "UPDATE users SET username = $username, profile_image_path = $path WHERE id = $id",
      { $username: username, $path: profileImagePath, $id: req.user.id }
    );
    db.persist();

    const updated = db.get("SELECT * FROM users WHERE id = $id", { $id: req.user.id });
    res.json({ user: publicUser(updated) });
  });

  app.post("/friends/request", requireAuth, (req, res) => {
    const username = String(req.body.username || "").trim();
    if (!username) {
      return res.status(400).json({ error: "Username is required." });
    }

    const target = db.get("SELECT * FROM users WHERE lower(username) = lower($username)", { $username: username });
    if (!target) {
      return res.status(404).json({ error: "User not found." });
    }

    if (Number(target.id) === Number(req.user.id)) {
      return res.status(400).json({ error: "You cannot friend yourself." });
    }

    const [a, b] = makePair(Number(req.user.id), Number(target.id));
    const existingFriend = db.get(
      "SELECT id FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
      { $a: a, $b: b }
    );
    if (existingFriend) {
      return res.status(400).json({ error: "You are already friends." });
    }

    const existingRequest = db.get(
      "SELECT id, status FROM friend_requests WHERE from_user_id = $from AND to_user_id = $to",
      { $from: req.user.id, $to: target.id }
    );
    if (existingRequest && existingRequest.status === "pending") {
      return res.status(400).json({ error: "Friend request already sent." });
    }

    const reversePending = db.get(
      "SELECT id FROM friend_requests WHERE from_user_id = $from AND to_user_id = $to AND status = 'pending'",
      { $from: target.id, $to: req.user.id }
    );

    if (reversePending) {
      return res.status(400).json({ error: "That user already sent you a request. Accept it from Requests." });
    }

    if (existingRequest) {
      db.exec(
        "UPDATE friend_requests SET status = 'pending', created_at = $created, responded_at = NULL WHERE id = $id",
        { $created: nowIso(), $id: existingRequest.id }
      );
    } else {
      db.exec(
        "INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at, responded_at) VALUES ($from, $to, 'pending', $created, NULL)",
        { $from: req.user.id, $to: target.id, $created: nowIso() }
      );
    }

    db.persist();
    res.json({ ok: true });
  });

  app.get("/friends/requests", requireAuth, (req, res) => {
    const incoming = db.all(
      `SELECT fr.id, fr.created_at, u.id AS from_user_id, u.username, u.profile_image_path
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $me AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      { $me: req.user.id }
    );

    res.json({
      requests: incoming.map((r) => ({
        id: Number(r.id),
        from_user_id: Number(r.from_user_id),
        username: r.username,
        profile_image_path: r.profile_image_path || "",
        created_at: r.created_at
      }))
    });
  });

  app.post("/friends/request/:id/accept", requireAuth, (req, res) => {
    const requestId = Number(req.params.id);
    if (!requestId) {
      return res.status(400).json({ error: "Invalid request id." });
    }

    const request = db.get("SELECT * FROM friend_requests WHERE id = $id", { $id: requestId });
    if (!request || Number(request.to_user_id) !== Number(req.user.id)) {
      return res.status(404).json({ error: "Request not found." });
    }

    if (request.status !== "pending") {
      return res.status(400).json({ error: "Request is not pending." });
    }

    const [a, b] = makePair(Number(request.from_user_id), Number(request.to_user_id));

    db.exec(
      "UPDATE friend_requests SET status = 'accepted', responded_at = $at WHERE id = $id",
      { $at: nowIso(), $id: requestId }
    );

    const existingFriend = db.get(
      "SELECT id FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
      { $a: a, $b: b }
    );

    if (!existingFriend) {
      db.exec(
        "INSERT INTO friendships (user_a_id, user_b_id, created_at) VALUES ($a, $b, $created)",
        { $a: a, $b: b, $created: nowIso() }
      );
    }

    const existingConversation = db.get(
      `SELECT c.id
       FROM conversations c
       JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $u1
       JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $u2
       LIMIT 1`,
      { $u1: a, $u2: b }
    );

    if (!existingConversation) {
      db.exec("INSERT INTO conversations (created_at) VALUES ($created)", { $created: nowIso() });
      const row = db.get("SELECT last_insert_rowid() AS id");
      db.exec(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($c, $u1), ($c, $u2)",
        { $c: row.id, $u1: a, $u2: b }
      );
    }

    db.persist();
    res.json({ ok: true });
  });

  app.get("/friends", requireAuth, (req, res) => {
    const rows = db.all(
      `SELECT f.id AS friendship_id,
              CASE WHEN f.user_a_id = $me THEN u2.id ELSE u1.id END AS user_id,
              CASE WHEN f.user_a_id = $me THEN u2.username ELSE u1.username END AS username,
              CASE WHEN f.user_a_id = $me THEN u2.profile_image_path ELSE u1.profile_image_path END AS profile_image_path
       FROM friendships f
       JOIN users u1 ON u1.id = f.user_a_id
       JOIN users u2 ON u2.id = f.user_b_id
       WHERE f.user_a_id = $me OR f.user_b_id = $me
       ORDER BY username COLLATE NOCASE`,
      { $me: req.user.id }
    );

    const friends = rows.map((row) => {
      const convo = db.get(
        `SELECT c.id
         FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $me
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $friend
         LIMIT 1`,
        { $me: req.user.id, $friend: row.user_id }
      );

      return {
        friendship_id: Number(row.friendship_id),
        user_id: Number(row.user_id),
        username: row.username,
        profile_image_path: row.profile_image_path || "",
        conversation_id: convo ? Number(convo.id) : null
      };
    });

    res.json({ friends });
  });

  function isConversationMember(userId, conversationId) {
    const row = db.get(
      "SELECT id FROM conversation_members WHERE conversation_id = $c AND user_id = $u",
      { $c: conversationId, $u: userId }
    );
    return !!row;
  }

  app.get("/conversations", requireAuth, (req, res) => {
    const myConversations = db.all(
      `SELECT c.id, c.created_at
       FROM conversations c
       JOIN conversation_members cm ON cm.conversation_id = c.id
       WHERE cm.user_id = $me
       ORDER BY c.id DESC`,
      { $me: req.user.id }
    );

    const conversations = myConversations.map((c) => {
      const other = db.get(
        `SELECT u.id, u.username, u.profile_image_path
         FROM conversation_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id = $c AND u.id != $me
         LIMIT 1`,
        { $c: c.id, $me: req.user.id }
      );

      const lastMessage = db.get(
        "SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = $c ORDER BY id DESC LIMIT 1",
        { $c: c.id }
      );

      return {
        id: Number(c.id),
        created_at: c.created_at,
        other_user: other
          ? {
              id: Number(other.id),
              username: other.username,
              profile_image_path: other.profile_image_path || ""
            }
          : null,
        last_message: lastMessage
          ? {
              id: Number(lastMessage.id),
              sender_id: Number(lastMessage.sender_id),
              body: lastMessage.body,
              created_at: lastMessage.created_at
            }
          : null
      };
    });

    res.json({ conversations });
  });

  app.get("/conversations/:id/messages", requireAuth, (req, res) => {
    const conversationId = Number(req.params.id);
    if (!conversationId) {
      return res.status(400).json({ error: "Invalid conversation id." });
    }

    if (!isConversationMember(req.user.id, conversationId)) {
      return res.status(403).json({ error: "Not a conversation member." });
    }

    const messages = db
      .all(
        `SELECT m.id, m.sender_id, m.body, m.created_at, u.username AS sender_username
         FROM messages m
         JOIN users u ON u.id = m.sender_id
         WHERE m.conversation_id = $c
         ORDER BY m.id ASC`,
        { $c: conversationId }
      )
      .map((m) => ({
        id: Number(m.id),
        sender_id: Number(m.sender_id),
        sender_username: m.sender_username,
        body: m.body,
        created_at: m.created_at
      }));

    res.json({ messages });
  });

  app.post("/conversations/:id/messages", requireAuth, (req, res) => {
    const conversationId = Number(req.params.id);
    const body = String(req.body.body || "").trim();

    if (!conversationId || !body) {
      return res.status(400).json({ error: "Conversation id and body are required." });
    }

    if (!isConversationMember(req.user.id, conversationId)) {
      return res.status(403).json({ error: "Not a conversation member." });
    }

    db.exec(
      "INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES ($c, $s, $b, $created)",
      { $c: conversationId, $s: req.user.id, $b: body, $created: nowIso() }
    );
    const row = db.get("SELECT last_insert_rowid() AS id");
    db.persist();

    const inserted = db.get("SELECT id, sender_id, body, created_at FROM messages WHERE id = $id", {
      $id: row.id
    });

    res.json({
      message: {
        id: Number(inserted.id),
        sender_id: Number(inserted.sender_id),
        body: inserted.body,
        created_at: inserted.created_at
      }
    });
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error." });
  });

  const server = await new Promise((resolve) => {
    const instance = app.listen(port, host, () => resolve(instance));
  });

  return {
    host,
    port,
    dbPath: resolvedDbPath,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  };
}

module.exports = {
  createApiServer
};
