const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");
const { Pool } = require("pg");
const { createMailer } = require("./mailer");

const JWT_SECRET = process.env.CODED_MESSAGES_JWT_SECRET || "dev-secret-change-me";

function nowIso() {
  return new Date().toISOString();
}

function makePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function publicUser(row) {
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    profile_image_path: row.profile_image_path || ""
  };
}

function convertNamedParams(sql, params = {}) {
  const values = [];
  const indexes = new Map();

  const text = sql.replace(/\$[a-zA-Z_][a-zA-Z0-9_]*/g, (match) => {
    if (!indexes.has(match)) {
      indexes.set(match, values.length + 1);
      values.push(params[match]);
    }
    return `$${indexes.get(match)}`;
  });

  return { text, values };
}

function normalizeMessageDisplayMode(value) {
  return value === "plain" ? "plain" : "coded";
}

function hashResetCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function generateResetCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function resetCodeExpiresAt() {
  return new Date(Date.now() + (15 * 60 * 1000)).toISOString();
}

async function createSqliteDb(dbPath) {
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

  const run = (sql, params = {}) => {
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

  const insert = (sql, params = {}) => {
    run(sql, params);
    return get("SELECT last_insert_rowid() AS id");
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
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`
  ];

  createStatements.forEach((stmt) => run(stmt));
  const messageColumns = all("PRAGMA table_info(messages)");
  if (!messageColumns.some((column) => String(column.name) === "display_mode")) {
    run("ALTER TABLE messages ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'coded'");
  }
  persist();

  return {
    kind: "sqlite",
    run,
    all,
    get,
    insert,
    persist,
    close: async () => {
      persist();
      db.close();
    }
  };
}

async function createPostgresDb(databaseUrl) {
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
  });

  const run = async (sql, params = {}) => {
    const query = convertNamedParams(sql, params);
    return pool.query(query.text, query.values);
  };

  const all = async (sql, params = {}) => {
    const result = await run(sql, params);
    return result.rows;
  };

  const get = async (sql, params = {}) => {
    const rows = await all(sql, params);
    return rows[0] || null;
  };

  const insert = async (sql, params = {}) => {
    const result = await run(`${sql} RETURNING id`, params);
    return result.rows[0];
  };

  const createStatements = [
    `CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      username TEXT NOT NULL UNIQUE,
      profile_image_path TEXT DEFAULT '',
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS friend_requests (
      id BIGSERIAL PRIMARY KEY,
      from_user_id BIGINT NOT NULL,
      to_user_id BIGINT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      responded_at TEXT,
      UNIQUE(from_user_id, to_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS friendships (
      id BIGSERIAL PRIMARY KEY,
      user_a_id BIGINT NOT NULL,
      user_b_id BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(user_a_id, user_b_id)
    )`,
    `CREATE TABLE IF NOT EXISTS conversations (
      id BIGSERIAL PRIMARY KEY,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS conversation_members (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL,
      user_id BIGINT NOT NULL,
      UNIQUE(conversation_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL,
      sender_id BIGINT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    )`
  ];

  for (const stmt of createStatements) {
    await run(stmt);
  }

  await run("ALTER TABLE messages ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'coded'");

  return {
    kind: "postgres",
    run,
    all,
    get,
    insert,
    persist: async () => {},
    close: async () => {
      await pool.end();
    }
  };
}

async function createDb({ dbPath, databaseUrl }) {
  if (databaseUrl) {
    return createPostgresDb(databaseUrl);
  }

  return createSqliteDb(dbPath);
}

function authMiddleware(db) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing token." });
    }

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await db.get("SELECT * FROM users WHERE id = $id", { $id: decoded.userId });
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

async function createApiServer({ host = "127.0.0.1", port = 3847, dbPath, databaseUrl } = {}) {
  const resolvedDbPath = dbPath || path.join(__dirname, "..", "data", "app.sqlite");
  if (!databaseUrl) {
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  }

  const db = await createDb({ dbPath: resolvedDbPath, databaseUrl: databaseUrl || process.env.DATABASE_URL });
  const mailer = createMailer();
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true, database: db.kind, mailer: mailer.enabled ? "configured" : "disabled" });
  });

  app.post("/auth/register", async (req, res, next) => {
    try {
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

      const existingEmail = await db.get("SELECT id FROM users WHERE email = $email", { $email: email });
      if (existingEmail) {
        return res.status(400).json({ error: "Email already in use." });
      }

      const existingUsername = await db.get(
        "SELECT id FROM users WHERE lower(username) = lower($username)",
        { $username: username }
      );
      if (existingUsername) {
        return res.status(400).json({ error: "Username already taken." });
      }

      const hash = bcrypt.hashSync(password, 10);
      await db.insert(
        "INSERT INTO users (email, password_hash, username, profile_image_path, created_at) VALUES ($email, $hash, $username, '', $created)",
        { $email: email, $hash: hash, $username: username, $created: nowIso() }
      );

      const user = await db.get("SELECT * FROM users WHERE email = $email", { $email: email });
      await db.persist();

      const token = jwt.sign({ userId: Number(user.id) }, JWT_SECRET, { expiresIn: "7d" });
      res.json({ token, user: publicUser(user) });

      if (mailer.enabled) {
        setImmediate(async () => {
          try {
            await mailer.sendWelcomeEmail({
              email: user.email,
              username: user.username
            });
          } catch (mailError) {
            console.error("Failed to send welcome email.");
            console.error(mailError);
          }
        });
      }

      return;
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/login", async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const password = String(req.body.password || "");

      const user = await db.get("SELECT * FROM users WHERE email = $email", { $email: email });
      if (!user) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      const ok = bcrypt.compareSync(password, user.password_hash);
      if (!ok) {
        return res.status(400).json({ error: "Invalid credentials." });
      }

      const token = jwt.sign({ userId: Number(user.id) }, JWT_SECRET, { expiresIn: "7d" });
      return res.json({ token, user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/request-password-reset", async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: "Email is required." });
      }

      const genericResponse = {
        ok: true,
        message: "If an account exists for that email, a reset code has been sent."
      };

      const user = await db.get("SELECT * FROM users WHERE email = $email", { $email: email });
      if (!user) {
        return res.json(genericResponse);
      }

      const code = generateResetCode();
      const now = nowIso();
      await db.run(
        "UPDATE password_reset_tokens SET used_at = $usedAt WHERE user_id = $userId AND used_at IS NULL",
        { $usedAt: now, $userId: user.id }
      );
      await db.insert(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, used_at, created_at) VALUES ($userId, $tokenHash, $expiresAt, NULL, $createdAt)",
        {
          $userId: user.id,
          $tokenHash: hashResetCode(code),
          $expiresAt: resetCodeExpiresAt(),
          $createdAt: now
        }
      );
      await db.persist();

      if (mailer.enabled) {
        setImmediate(async () => {
          try {
            await mailer.sendPasswordResetEmail({
              email: user.email,
              username: user.username,
              code
            });
          } catch (mailError) {
            console.error("Failed to send password reset email.");
            console.error(mailError);
          }
        });
      }

      return res.json(genericResponse);
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/reset-password", async (req, res, next) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const code = String(req.body.code || "").trim();
      const password = String(req.body.password || "");

      if (!email || !code || !password) {
        return res.status(400).json({ error: "Email, reset code, and new password are required." });
      }

      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters." });
      }

      const user = await db.get("SELECT * FROM users WHERE email = $email", { $email: email });
      if (!user) {
        return res.status(400).json({ error: "Invalid reset code or expired request." });
      }

      const resetToken = await db.get(
        `SELECT * FROM password_reset_tokens
         WHERE user_id = $userId
           AND token_hash = $tokenHash
           AND used_at IS NULL
           AND expires_at >= $now
         ORDER BY id DESC
         LIMIT 1`,
        { $userId: user.id, $tokenHash: hashResetCode(code), $now: nowIso() }
      );

      if (!resetToken) {
        return res.status(400).json({ error: "Invalid reset code or expired request." });
      }

      const now = nowIso();
      const hash = bcrypt.hashSync(password, 10);
      await db.run("UPDATE users SET password_hash = $hash WHERE id = $id", { $hash: hash, $id: user.id });
      await db.run("UPDATE password_reset_tokens SET used_at = $usedAt WHERE id = $id", {
        $usedAt: now,
        $id: resetToken.id
      });
      await db.run(
        "UPDATE password_reset_tokens SET used_at = $usedAt WHERE user_id = $userId AND used_at IS NULL AND id != $id",
        { $usedAt: now, $userId: user.id, $id: resetToken.id }
      );
      await db.persist();

      return res.json({ ok: true, message: "Password updated. You can sign in now." });
    } catch (err) {
      next(err);
    }
  });

  const requireAuth = authMiddleware(db);

  app.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const username = String(req.body.username || "").trim();
      const profileImagePath = String(req.body.profile_image_path || "").trim();

      if (!username) {
        return res.status(400).json({ error: "Username is required." });
      }

      const duplicate = await db.get(
        "SELECT id FROM users WHERE lower(username) = lower($username) AND id != $id",
        { $username: username, $id: req.user.id }
      );

      if (duplicate) {
        return res.status(400).json({ error: "Username already taken." });
      }

      await db.run(
        "UPDATE users SET username = $username, profile_image_path = $path WHERE id = $id",
        { $username: username, $path: profileImagePath, $id: req.user.id }
      );
      await db.persist();

      const updated = await db.get("SELECT * FROM users WHERE id = $id", { $id: req.user.id });
      res.json({ user: publicUser(updated) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/friends/request", requireAuth, async (req, res, next) => {
    try {
      const username = String(req.body.username || "").trim();
      if (!username) {
        return res.status(400).json({ error: "Username is required." });
      }

      const target = await db.get("SELECT * FROM users WHERE lower(username) = lower($username)", {
        $username: username
      });
      if (!target) {
        return res.status(404).json({ error: "User not found." });
      }

      if (Number(target.id) === Number(req.user.id)) {
        return res.status(400).json({ error: "You cannot friend yourself." });
      }

      const [a, b] = makePair(Number(req.user.id), Number(target.id));
      const existingFriend = await db.get(
        "SELECT id FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
        { $a: a, $b: b }
      );
      if (existingFriend) {
        return res.status(400).json({ error: "You are already friends." });
      }

      const existingRequest = await db.get(
        "SELECT id, status FROM friend_requests WHERE from_user_id = $from AND to_user_id = $to",
        { $from: req.user.id, $to: target.id }
      );
      if (existingRequest && existingRequest.status === "pending") {
        return res.status(400).json({ error: "Friend request already sent." });
      }

      const reversePending = await db.get(
        "SELECT id FROM friend_requests WHERE from_user_id = $from AND to_user_id = $to AND status = 'pending'",
        { $from: target.id, $to: req.user.id }
      );

      if (reversePending) {
        return res.status(400).json({ error: "That user already sent you a request. Accept it from Requests." });
      }

      if (existingRequest) {
        await db.run(
          "UPDATE friend_requests SET status = 'pending', created_at = $created, responded_at = NULL WHERE id = $id",
          { $created: nowIso(), $id: existingRequest.id }
        );
      } else {
        await db.insert(
          "INSERT INTO friend_requests (from_user_id, to_user_id, status, created_at, responded_at) VALUES ($from, $to, 'pending', $created, NULL)",
          { $from: req.user.id, $to: target.id, $created: nowIso() }
        );
      }

      await db.persist();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/friends/requests", requireAuth, async (req, res, next) => {
    try {
      const incoming = await db.all(
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
    } catch (err) {
      next(err);
    }
  });

  app.post("/friends/request/:id/accept", requireAuth, async (req, res, next) => {
    try {
      const requestId = Number(req.params.id);
      if (!requestId) {
        return res.status(400).json({ error: "Invalid request id." });
      }

      const request = await db.get("SELECT * FROM friend_requests WHERE id = $id", { $id: requestId });
      if (!request || Number(request.to_user_id) !== Number(req.user.id)) {
        return res.status(404).json({ error: "Request not found." });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request is not pending." });
      }

      const [a, b] = makePair(Number(request.from_user_id), Number(request.to_user_id));

      await db.run(
        "UPDATE friend_requests SET status = 'accepted', responded_at = $at WHERE id = $id",
        { $at: nowIso(), $id: requestId }
      );

      const existingFriend = await db.get(
        "SELECT id FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
        { $a: a, $b: b }
      );

      if (!existingFriend) {
        await db.insert(
          "INSERT INTO friendships (user_a_id, user_b_id, created_at) VALUES ($a, $b, $created)",
          { $a: a, $b: b, $created: nowIso() }
        );
      }

      const existingConversation = await db.get(
        `SELECT c.id
         FROM conversations c
         JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $u1
         JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $u2
         LIMIT 1`,
        { $u1: a, $u2: b }
      );

      if (!existingConversation) {
        const row = await db.insert("INSERT INTO conversations (created_at) VALUES ($created)", {
          $created: nowIso()
        });
        await db.run(
          "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($c, $u1), ($c, $u2)",
          { $c: row.id, $u1: a, $u2: b }
        );
      }

      await db.persist();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/friends", requireAuth, async (req, res, next) => {
    try {
      const rows = await db.all(
        `SELECT f.id AS friendship_id,
                CASE WHEN f.user_a_id = $me THEN u2.id ELSE u1.id END AS user_id,
                CASE WHEN f.user_a_id = $me THEN u2.username ELSE u1.username END AS username,
                CASE WHEN f.user_a_id = $me THEN u2.profile_image_path ELSE u1.profile_image_path END AS profile_image_path
         FROM friendships f
         JOIN users u1 ON u1.id = f.user_a_id
         JOIN users u2 ON u2.id = f.user_b_id
         WHERE f.user_a_id = $me OR f.user_b_id = $me
         ORDER BY lower(CASE WHEN f.user_a_id = $me THEN u2.username ELSE u1.username END)`,
        { $me: req.user.id }
      );

      const friends = [];
      for (const row of rows) {
        const convo = await db.get(
          `SELECT c.id
           FROM conversations c
           JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $me
           JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $friend
           LIMIT 1`,
          { $me: req.user.id, $friend: row.user_id }
        );

        friends.push({
          friendship_id: Number(row.friendship_id),
          user_id: Number(row.user_id),
          username: row.username,
          profile_image_path: row.profile_image_path || "",
          conversation_id: convo ? Number(convo.id) : null
        });
      }

      res.json({ friends });
    } catch (err) {
      next(err);
    }
  });

  async function isConversationMember(userId, conversationId) {
    const row = await db.get(
      "SELECT id FROM conversation_members WHERE conversation_id = $c AND user_id = $u",
      { $c: conversationId, $u: userId }
    );
    return !!row;
  }

  app.get("/conversations", requireAuth, async (req, res, next) => {
    try {
      const myConversations = await db.all(
        `SELECT c.id, c.created_at
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = $me
         ORDER BY c.id DESC`,
        { $me: req.user.id }
      );

      const conversations = [];
      for (const c of myConversations) {
        const other = await db.get(
          `SELECT u.id, u.username, u.profile_image_path
           FROM conversation_members cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.conversation_id = $c AND u.id != $me
           LIMIT 1`,
          { $c: c.id, $me: req.user.id }
        );

        const lastMessage = await db.get(
          "SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = $c ORDER BY id DESC LIMIT 1",
          { $c: c.id }
        );

        conversations.push({
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
        });
      }

      res.json({ conversations });
    } catch (err) {
      next(err);
    }
  });

  app.get("/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      const conversationId = Number(req.params.id);
      if (!conversationId) {
        return res.status(400).json({ error: "Invalid conversation id." });
      }

      if (!(await isConversationMember(req.user.id, conversationId))) {
        return res.status(403).json({ error: "Not a conversation member." });
      }

      const messages = (
        await db.all(
          `SELECT m.id, m.sender_id, m.body, m.created_at, m.display_mode, u.username AS sender_username
           FROM messages m
           JOIN users u ON u.id = m.sender_id
           WHERE m.conversation_id = $c
           ORDER BY m.id ASC`,
          { $c: conversationId }
        )
      ).map((m) => ({
        id: Number(m.id),
        sender_id: Number(m.sender_id),
        sender_username: m.sender_username,
        body: m.body,
        display_mode: normalizeMessageDisplayMode(m.display_mode),
        created_at: m.created_at
      }));

      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  app.post("/conversations/:id/messages", requireAuth, async (req, res, next) => {
    try {
      const conversationId = Number(req.params.id);
      const body = String(req.body.body || "").trim();
      const displayMode = normalizeMessageDisplayMode(req.body.display_mode);

      if (!conversationId || !body) {
        return res.status(400).json({ error: "Conversation id and body are required." });
      }

      if (!(await isConversationMember(req.user.id, conversationId))) {
        return res.status(403).json({ error: "Not a conversation member." });
      }

      const row = await db.insert(
        "INSERT INTO messages (conversation_id, sender_id, body, created_at, display_mode) VALUES ($c, $s, $b, $created, $displayMode)",
        { $c: conversationId, $s: req.user.id, $b: body, $created: nowIso(), $displayMode: displayMode }
      );
      await db.persist();

      const inserted = await db.get("SELECT id, sender_id, body, created_at, display_mode FROM messages WHERE id = $id", {
        $id: row.id
      });

      res.json({
        message: {
          id: Number(inserted.id),
          sender_id: Number(inserted.sender_id),
          body: inserted.body,
          display_mode: normalizeMessageDisplayMode(inserted.display_mode),
          created_at: inserted.created_at
        }
      });
    } catch (err) {
      next(err);
    }
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
    dbPath: db.kind === "sqlite" ? resolvedDbPath : null,
    databaseKind: db.kind,
    close: async () => {
      await db.close();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

module.exports = {
  createApiServer
};
