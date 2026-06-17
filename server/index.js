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

const ONLINE_WINDOW_MS = 90 * 1000;
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_USERNAME_CHARS = 32;
const ALLOWED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const ALLOWED_ATTACHMENT_TYPES = new Set([
  ...ALLOWED_AVATAR_TYPES,
  "application/pdf",
  "text/plain"
]);

function resolveJwtSecret({ allowInsecureDevJwt = false } = {}) {
  const configuredSecret = String(process.env.CODED_MESSAGES_JWT_SECRET || "").trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (allowInsecureDevJwt) {
    return "dev-secret-change-me";
  }

  throw new Error(
    "CODED_MESSAGES_JWT_SECRET is required for standalone or hosted backend startup."
  );
}

function nowIso() {
  return new Date().toISOString();
}

function makePair(a, b) {
  return a < b ? [a, b] : [b, a];
}

function publicUser(row) {
  const lastSeenAt = row.last_seen_at || null;
  return {
    id: Number(row.id),
    email: row.email,
    username: row.username,
    profile_image_path: row.profile_image_path || "",
    last_seen_at: lastSeenAt,
    online: isRecentlyOnline(lastSeenAt)
  };
}

function isRecentlyOnline(value) {
  if (!value) {
    return false;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && Date.now() - timestamp <= ONLINE_WINDOW_MS;
}

function parseDataUrl(value, { allowedTypes, maxBytes, fieldName }) {
  const text = String(value || "").trim();
  if (!text) {
    return { value: "", mimeType: "", bytes: 0 };
  }

  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(text);
  if (!match) {
    throw new Error(`${fieldName} must be a base64 data URL.`);
  }

  const mimeType = match[1].toLowerCase();
  if (!allowedTypes.has(mimeType)) {
    throw new Error(`${fieldName} type is not allowed.`);
  }

  const bytes = Buffer.from(match[2], "base64").length;
  if (!bytes || bytes > maxBytes) {
    throw new Error(`${fieldName} is too large.`);
  }

  return { value: text, mimeType, bytes };
}

function createRateLimiter({ windowMs, limit, keyPrefix }) {
  const buckets = new Map();
  let requestsSinceCleanup = 0;

  return (req, res, next) => {
    const now = Date.now();
    requestsSinceCleanup += 1;
    if (requestsSinceCleanup >= 100) {
      requestsSinceCleanup = 0;
      for (const [bucketKey, value] of buckets.entries()) {
        if (value.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
    }

    const identity = req.user
      ? `user:${req.user.id}`
      : req.ip || req.socket.remoteAddress || "unknown";
    const key = `${keyPrefix}:${identity}`;
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > limit) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      return res.status(429).json({ error: "Too many requests. Please wait and try again." });
    }

    return next();
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

function numericId(value) {
  return Number(value);
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
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blocker_user_id INTEGER NOT NULL,
      blocked_user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(blocker_user_id, blocked_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_user_id INTEGER NOT NULL,
      reported_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
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
      title TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'direct',
      created_by_user_id INTEGER,
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
      attachment_name TEXT,
      attachment_type TEXT,
      attachment_data TEXT,
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
  const userColumns = all("PRAGMA table_info(users)");
  if (!userColumns.some((column) => String(column.name) === "last_seen_at")) {
    run("ALTER TABLE users ADD COLUMN last_seen_at TEXT");
  }
  const messageColumns = all("PRAGMA table_info(messages)");
  const conversationColumns = all("PRAGMA table_info(conversations)");
  if (!conversationColumns.some((column) => String(column.name) === "title")) {
    run("ALTER TABLE conversations ADD COLUMN title TEXT DEFAULT ''");
  }
  if (!conversationColumns.some((column) => String(column.name) === "type")) {
    run("ALTER TABLE conversations ADD COLUMN type TEXT NOT NULL DEFAULT 'direct'");
  }
  if (!conversationColumns.some((column) => String(column.name) === "created_by_user_id")) {
    run("ALTER TABLE conversations ADD COLUMN created_by_user_id INTEGER");
  }
  if (!messageColumns.some((column) => String(column.name) === "display_mode")) {
    run("ALTER TABLE messages ADD COLUMN display_mode TEXT NOT NULL DEFAULT 'coded'");
  }
  if (!messageColumns.some((column) => String(column.name) === "attachment_name")) {
    run("ALTER TABLE messages ADD COLUMN attachment_name TEXT");
  }
  if (!messageColumns.some((column) => String(column.name) === "attachment_type")) {
    run("ALTER TABLE messages ADD COLUMN attachment_type TEXT");
  }
  if (!messageColumns.some((column) => String(column.name) === "attachment_data")) {
    run("ALTER TABLE messages ADD COLUMN attachment_data TEXT");
  }
  [
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_friend_requests_to_status ON friend_requests(to_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_friend_requests_from_status ON friend_requests(from_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_id)",
    "CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_id)",
    "CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)",
    "CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, id)"
  ].forEach((stmt) => run(stmt));
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
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS blocks (
      id BIGSERIAL PRIMARY KEY,
      blocker_user_id BIGINT NOT NULL,
      blocked_user_id BIGINT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(blocker_user_id, blocked_user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS reports (
      id BIGSERIAL PRIMARY KEY,
      reporter_user_id BIGINT NOT NULL,
      reported_user_id BIGINT NOT NULL,
      reason TEXT NOT NULL,
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
      title TEXT DEFAULT '',
      type TEXT NOT NULL DEFAULT 'direct',
      created_by_user_id BIGINT,
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
      attachment_name TEXT,
      attachment_type TEXT,
      attachment_data TEXT,
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

  // Render connects as the table owner and continues to use these tables.
  // RLS default-denies access through Supabase's exposed anon/authenticated API.
  for (const table of [
    "users",
    "sessions",
    "blocks",
    "reports",
    "friend_requests",
    "friendships",
    "conversations",
    "conversation_members",
    "messages",
    "password_reset_tokens"
  ]) {
    await run(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
  }

  await run("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TEXT");
  await run("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT DEFAULT ''");
  await run("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'direct'");
  await run("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS created_by_user_id BIGINT");
  await run("ALTER TABLE messages ADD COLUMN IF NOT EXISTS display_mode TEXT NOT NULL DEFAULT 'coded'");
  await run("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_name TEXT");
  await run("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_type TEXT");
  await run("ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachment_data TEXT");
  for (const stmt of [
    "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_reports_reported ON reports(reported_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_user_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_friend_requests_to_status ON friend_requests(to_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_friend_requests_from_status ON friend_requests(from_user_id, status)",
    "CREATE INDEX IF NOT EXISTS idx_friendships_user_a ON friendships(user_a_id)",
    "CREATE INDEX IF NOT EXISTS idx_friendships_user_b ON friendships(user_b_id)",
    "CREATE INDEX IF NOT EXISTS idx_conversations_type ON conversations(type)",
    "CREATE INDEX IF NOT EXISTS idx_conversation_members_user ON conversation_members(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id, id)"
  ]) {
    await run(stmt);
  }

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

async function issueSession(db, userId, jwtSecret) {
  const sessionId = crypto.randomUUID();
  const now = nowIso();
  await db.insert(
    "INSERT INTO sessions (id, user_id, created_at, last_seen_at, revoked_at) VALUES ($id, $userId, $createdAt, $lastSeenAt, NULL)",
    { $id: sessionId, $userId: userId, $createdAt: now, $lastSeenAt: now }
  );
  await db.run("UPDATE users SET last_seen_at = $lastSeenAt WHERE id = $userId", {
    $lastSeenAt: now,
    $userId: userId
  });
  await db.persist();

  return jwt.sign({ userId: Number(userId), sessionId }, jwtSecret, { expiresIn: "7d" });
}

async function usersAreBlocked(db, userA, userB) {
  const block = await db.get(
    `SELECT id FROM blocks
     WHERE (blocker_user_id = $userA AND blocked_user_id = $userB)
        OR (blocker_user_id = $userB AND blocked_user_id = $userA)
     LIMIT 1`,
    { $userA: userA, $userB: userB }
  );
  return !!block;
}

async function getDirectConversation(db, userA, userB) {
  return db.get(
    `SELECT c.id
     FROM conversations c
     JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.user_id = $userA
     JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.user_id = $userB
     WHERE c.type = 'direct'
       AND (
         SELECT COUNT(*)
         FROM conversation_members cm
         WHERE cm.conversation_id = c.id
       ) = 2
     LIMIT 1`,
    { $userA: userA, $userB: userB }
  );
}

async function getConversationMembers(db, conversationId) {
  return db.all(
    `SELECT u.id, u.username, u.profile_image_path, u.last_seen_at
     FROM conversation_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = $conversationId
     ORDER BY lower(u.username)`,
    { $conversationId: conversationId }
  );
}

async function conversationHasBlockedMember(db, userId, members) {
  for (const member of members) {
    if (Number(member.id) !== Number(userId) && await usersAreBlocked(db, userId, member.id)) {
      return true;
    }
  }
  return false;
}

async function usersAreFriends(db, userA, userB) {
  const [a, b] = makePair(Number(userA), Number(userB));
  const row = await db.get(
    "SELECT id FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
    { $a: a, $b: b }
  );
  return !!row;
}

async function removeRelationship(db, userA, userB) {
  const [a, b] = makePair(Number(userA), Number(userB));
  const conversation = await getDirectConversation(db, userA, userB);

  await db.run("DELETE FROM friendships WHERE user_a_id = $a AND user_b_id = $b", { $a: a, $b: b });
  await db.run(
    `DELETE FROM friend_requests
     WHERE (from_user_id = $userA AND to_user_id = $userB)
        OR (from_user_id = $userB AND to_user_id = $userA)`,
    { $userA: userA, $userB: userB }
  );

  if (conversation) {
    await db.run("DELETE FROM messages WHERE conversation_id = $conversationId", {
      $conversationId: conversation.id
    });
    await db.run("DELETE FROM conversation_members WHERE conversation_id = $conversationId", {
      $conversationId: conversation.id
    });
    await db.run("DELETE FROM conversations WHERE id = $conversationId", {
      $conversationId: conversation.id
    });
  }
}

function authMiddleware(db, jwtSecret) {
  return async (req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: "Missing token." });
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded.sessionId) {
        return res.status(401).json({ error: "Session expired. Please sign in again." });
      }

      const session = await db.get(
        "SELECT * FROM sessions WHERE id = $id AND user_id = $userId AND revoked_at IS NULL",
        { $id: decoded.sessionId, $userId: decoded.userId }
      );
      if (!session) {
        return res.status(401).json({ error: "Session expired. Please sign in again." });
      }

      const user = await db.get("SELECT * FROM users WHERE id = $id", { $id: decoded.userId });
      if (!user) {
        return res.status(401).json({ error: "Invalid token." });
      }
      const lastSeenMs = new Date(session.last_seen_at).getTime();
      if (!Number.isFinite(lastSeenMs) || Date.now() - lastSeenMs >= 15 * 1000) {
        const now = nowIso();
        await db.run("UPDATE sessions SET last_seen_at = $now WHERE id = $id", {
          $now: now,
          $id: decoded.sessionId
        });
        await db.run("UPDATE users SET last_seen_at = $now WHERE id = $userId", {
          $now: now,
          $userId: decoded.userId
        });
        user.last_seen_at = now;
      }
      req.user = user;
      req.session = session;
      next();
    } catch (_err) {
      return res.status(401).json({ error: "Invalid token." });
    }
  };
}

async function createApiServer({
  host = "127.0.0.1",
  port = 3847,
  dbPath,
  databaseUrl,
  allowInsecureDevJwt = false
} = {}) {
  const resolvedDbPath = dbPath || path.join(__dirname, "..", "data", "app.sqlite");
  if (!databaseUrl) {
    fs.mkdirSync(path.dirname(resolvedDbPath), { recursive: true });
  }

  const jwtSecret = resolveJwtSecret({ allowInsecureDevJwt });
  const db = await createDb({ dbPath: resolvedDbPath, databaseUrl: databaseUrl || process.env.DATABASE_URL });
  const mailer = createMailer();
  const app = express();
  const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, limit: 20, keyPrefix: "auth" });
  const socialLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 60, keyPrefix: "social" });
  const messageLimiter = createRateLimiter({ windowMs: 60 * 1000, limit: 120, keyPrefix: "message" });

  app.set("trust proxy", 1);
  app.use(cors());
  app.use(express.json({ limit: "4mb" }));
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    res.setHeader("X-Request-Id", requestId);
    res.on("finish", () => {
      console.log(JSON.stringify({
        level: "info",
        event: "http_request",
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      }));
    });
    next();
  });

  app.get("/health", async (_req, res, next) => {
    try {
      await db.get("SELECT 1 AS ok");
      res.json({
        ok: true,
        database: db.kind,
        databaseConnected: true,
        mailer: mailer.provider,
        mailConfigured: mailer.enabled
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/register", authLimiter, async (req, res, next) => {
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
      if (username.length > MAX_USERNAME_CHARS) {
        return res.status(400).json({ error: `Username must be ${MAX_USERNAME_CHARS} characters or fewer.` });
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

      const token = await issueSession(db, user.id, jwtSecret);
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

  app.post("/auth/login", authLimiter, async (req, res, next) => {
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

      const token = await issueSession(db, user.id, jwtSecret);
      return res.json({ token, user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  app.post("/auth/request-password-reset", authLimiter, async (req, res, next) => {
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

  app.post("/auth/reset-password", authLimiter, async (req, res, next) => {
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
      await db.run(
        "UPDATE sessions SET revoked_at = $revokedAt WHERE user_id = $userId AND revoked_at IS NULL",
        { $revokedAt: now, $userId: user.id }
      );
      await db.persist();

      return res.json({ ok: true, message: "Password updated. You can sign in now." });
    } catch (err) {
      next(err);
    }
  });

  const requireAuth = authMiddleware(db, jwtSecret);

  app.get("/me", requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  app.post("/me/heartbeat", requireAuth, (req, res) => {
    res.json({ ok: true, last_seen_at: req.user.last_seen_at });
  });

  app.post("/auth/logout", requireAuth, async (req, res, next) => {
    try {
      await db.run("UPDATE sessions SET revoked_at = $revokedAt WHERE id = $id", {
        $revokedAt: nowIso(),
        $id: req.session.id
      });
      await db.persist();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.get("/sessions", requireAuth, async (req, res, next) => {
    try {
      const sessions = await db.all(
        `SELECT id, created_at, last_seen_at
         FROM sessions
         WHERE user_id = $userId AND revoked_at IS NULL
         ORDER BY last_seen_at DESC`,
        { $userId: req.user.id }
      );
      res.json({
        sessions: sessions.map((session) => ({
          id: session.id,
          created_at: session.created_at,
          last_seen_at: session.last_seen_at,
          current: session.id === req.session.id
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/sessions/:id", requireAuth, async (req, res, next) => {
    try {
      const session = await db.get(
        "SELECT id FROM sessions WHERE id = $id AND user_id = $userId AND revoked_at IS NULL",
        { $id: req.params.id, $userId: req.user.id }
      );
      if (!session) {
        return res.status(404).json({ error: "Session not found." });
      }

      await db.run("UPDATE sessions SET revoked_at = $revokedAt WHERE id = $id", {
        $revokedAt: nowIso(),
        $id: session.id
      });
      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  app.delete("/sessions", requireAuth, async (req, res, next) => {
    try {
      await db.run(
        "UPDATE sessions SET revoked_at = $revokedAt WHERE user_id = $userId AND id != $currentId AND revoked_at IS NULL",
        { $revokedAt: nowIso(), $userId: req.user.id, $currentId: req.session.id }
      );
      await db.persist();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.patch("/me/profile", requireAuth, async (req, res, next) => {
    try {
      const username = String(req.body.username || "").trim();
      const profileImagePath = String(req.body.profile_image_path || "").trim();

      if (!username) {
        return res.status(400).json({ error: "Username is required." });
      }
      if (username.length > MAX_USERNAME_CHARS) {
        return res.status(400).json({ error: `Username must be ${MAX_USERNAME_CHARS} characters or fewer.` });
      }

      if (profileImagePath) {
        try {
          parseDataUrl(profileImagePath, {
            allowedTypes: ALLOWED_AVATAR_TYPES,
            maxBytes: MAX_AVATAR_BYTES,
            fieldName: "Profile image"
          });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
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

  app.get("/blocks", requireAuth, async (req, res, next) => {
    try {
      const blocked = await db.all(
        `SELECT u.id, u.username, u.profile_image_path, b.created_at
         FROM blocks b
         JOIN users u ON u.id = b.blocked_user_id
         WHERE b.blocker_user_id = $me
         ORDER BY lower(u.username)`,
        { $me: req.user.id }
      );
      res.json({
        blocked: blocked.map((user) => ({
          id: Number(user.id),
          username: user.username,
          profile_image_path: user.profile_image_path || "",
          created_at: user.created_at
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/blocks/:userId", requireAuth, socialLimiter, async (req, res, next) => {
    try {
      const blockedUserId = Number(req.params.userId);
      if (!blockedUserId || blockedUserId === Number(req.user.id)) {
        return res.status(400).json({ error: "Invalid user to block." });
      }

      const user = await db.get("SELECT id FROM users WHERE id = $id", { $id: blockedUserId });
      if (!user) {
        return res.status(404).json({ error: "User not found." });
      }

      const existing = await db.get(
        "SELECT id FROM blocks WHERE blocker_user_id = $blocker AND blocked_user_id = $blocked",
        { $blocker: req.user.id, $blocked: blockedUserId }
      );
      if (!existing) {
        await db.insert(
          "INSERT INTO blocks (blocker_user_id, blocked_user_id, created_at) VALUES ($blocker, $blocked, $createdAt)",
          { $blocker: req.user.id, $blocked: blockedUserId, $createdAt: nowIso() }
        );
      }

      await removeRelationship(db, req.user.id, blockedUserId);
      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  app.delete("/blocks/:userId", requireAuth, async (req, res, next) => {
    try {
      const blockedUserId = Number(req.params.userId);
      await db.run(
        "DELETE FROM blocks WHERE blocker_user_id = $blocker AND blocked_user_id = $blocked",
        { $blocker: req.user.id, $blocked: blockedUserId }
      );
      await db.persist();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/reports/:userId", requireAuth, socialLimiter, async (req, res, next) => {
    try {
      const reportedUserId = Number(req.params.userId);
      const allowedReasons = new Set(["harassment", "spam", "impersonation", "other"]);
      const reason = String(req.body.reason || "").trim().toLowerCase();

      if (!reportedUserId || reportedUserId === Number(req.user.id)) {
        return res.status(400).json({ error: "Invalid user to report." });
      }
      if (!allowedReasons.has(reason)) {
        return res.status(400).json({ error: "Choose a valid report reason." });
      }

      const reportedUser = await db.get("SELECT id FROM users WHERE id = $id", {
        $id: reportedUserId
      });
      if (!reportedUser) {
        return res.status(404).json({ error: "User not found." });
      }

      await db.insert(
        `INSERT INTO reports (reporter_user_id, reported_user_id, reason, created_at)
         VALUES ($reporterUserId, $reportedUserId, $reason, $createdAt)`,
        {
          $reporterUserId: req.user.id,
          $reportedUserId: reportedUserId,
          $reason: reason,
          $createdAt: nowIso()
        }
      );
      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
    }
  });

  app.post("/friends/request", requireAuth, socialLimiter, async (req, res, next) => {
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

      if (await usersAreBlocked(db, req.user.id, target.id)) {
        return res.status(403).json({ error: "Friend requests are unavailable between these accounts." });
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
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
             WHERE (b.blocker_user_id = $me AND b.blocked_user_id = fr.from_user_id)
                OR (b.blocker_user_id = fr.from_user_id AND b.blocked_user_id = $me)
           )
         ORDER BY fr.created_at DESC`,
        { $me: req.user.id }
      );

      const outgoing = await db.all(
        `SELECT fr.id, fr.created_at, u.id AS to_user_id, u.username, u.profile_image_path
         FROM friend_requests fr
         JOIN users u ON u.id = fr.to_user_id
         WHERE fr.from_user_id = $me AND fr.status = 'pending'
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
             WHERE (b.blocker_user_id = $me AND b.blocked_user_id = fr.to_user_id)
                OR (b.blocker_user_id = fr.to_user_id AND b.blocked_user_id = $me)
           )
         ORDER BY fr.created_at DESC`,
        { $me: req.user.id }
      );

      res.json({
        requests: incoming.map((r) => ({
          id: numericId(r.id),
          from_user_id: numericId(r.from_user_id),
          username: r.username,
          profile_image_path: r.profile_image_path || "",
          created_at: r.created_at
        })),
        outgoing: outgoing.map((r) => ({
          id: numericId(r.id),
          to_user_id: numericId(r.to_user_id),
          username: r.username,
          profile_image_path: r.profile_image_path || "",
          created_at: r.created_at
        }))
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/friends/request/:id/accept", requireAuth, socialLimiter, async (req, res, next) => {
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

      if (await usersAreBlocked(db, request.from_user_id, request.to_user_id)) {
        return res.status(403).json({ error: "This request can no longer be accepted." });
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

      const existingConversation = await getDirectConversation(db, a, b);

      if (!existingConversation) {
        const row = await db.insert(
          "INSERT INTO conversations (title, type, created_by_user_id, created_at) VALUES ('', 'direct', $createdBy, $created)",
          { $createdBy: req.user.id, $created: nowIso() }
        );
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

  app.post("/friends/request/:id/decline", requireAuth, socialLimiter, async (req, res, next) => {
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

      await db.run(
        "UPDATE friend_requests SET status = 'declined', responded_at = $at WHERE id = $id",
        { $at: nowIso(), $id: requestId }
      );
      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/friends/request/:id/cancel", requireAuth, socialLimiter, async (req, res, next) => {
    try {
      const requestId = Number(req.params.id);
      if (!requestId) {
        return res.status(400).json({ error: "Invalid request id." });
      }

      const request = await db.get("SELECT * FROM friend_requests WHERE id = $id", { $id: requestId });
      if (!request || Number(request.from_user_id) !== Number(req.user.id)) {
        return res.status(404).json({ error: "Request not found." });
      }

      if (request.status !== "pending") {
        return res.status(400).json({ error: "Request is not pending." });
      }

      await db.run(
        "UPDATE friend_requests SET status = 'cancelled', responded_at = $at WHERE id = $id",
        { $at: nowIso(), $id: requestId }
      );
      await db.persist();
      return res.json({ ok: true });
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
                CASE WHEN f.user_a_id = $me THEN u2.profile_image_path ELSE u1.profile_image_path END AS profile_image_path,
                CASE WHEN f.user_a_id = $me THEN u2.last_seen_at ELSE u1.last_seen_at END AS last_seen_at
         FROM friendships f
         JOIN users u1 ON u1.id = f.user_a_id
         JOIN users u2 ON u2.id = f.user_b_id
         WHERE (f.user_a_id = $me OR f.user_b_id = $me)
           AND NOT EXISTS (
             SELECT 1 FROM blocks b
             WHERE (b.blocker_user_id = $me AND b.blocked_user_id = CASE WHEN f.user_a_id = $me THEN f.user_b_id ELSE f.user_a_id END)
                OR (b.blocked_user_id = $me AND b.blocker_user_id = CASE WHEN f.user_a_id = $me THEN f.user_b_id ELSE f.user_a_id END)
           )
         ORDER BY lower(CASE WHEN f.user_a_id = $me THEN u2.username ELSE u1.username END)`,
        { $me: req.user.id }
      );

      const friends = [];
      for (const row of rows) {
        const convo = await getDirectConversation(db, req.user.id, row.user_id);

        friends.push({
          friendship_id: Number(row.friendship_id),
          user_id: Number(row.user_id),
          username: row.username,
          profile_image_path: row.profile_image_path || "",
          last_seen_at: row.last_seen_at || null,
          online: isRecentlyOnline(row.last_seen_at),
          conversation_id: convo ? Number(convo.id) : null
        });
      }

      res.json({ friends });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/friends/:userId", requireAuth, async (req, res, next) => {
    try {
      const friendUserId = Number(req.params.userId);
      if (!friendUserId) {
        return res.status(400).json({ error: "Invalid friend id." });
      }

      const [a, b] = makePair(Number(req.user.id), friendUserId);
      const friendship = await db.get(
        "SELECT * FROM friendships WHERE user_a_id = $a AND user_b_id = $b",
        { $a: a, $b: b }
      );

      if (!friendship) {
        return res.status(404).json({ error: "Friendship not found." });
      }

      const conversation = await getDirectConversation(db, req.user.id, friendUserId);

      await db.run("DELETE FROM friendships WHERE id = $id", { $id: friendship.id });
      await db.run(
        `DELETE FROM friend_requests
         WHERE (from_user_id = $u1 AND to_user_id = $u2)
            OR (from_user_id = $u2 AND to_user_id = $u1)`,
        { $u1: req.user.id, $u2: friendUserId }
      );

      if (conversation) {
        await db.run("DELETE FROM messages WHERE conversation_id = $id", { $id: conversation.id });
        await db.run("DELETE FROM conversation_members WHERE conversation_id = $id", { $id: conversation.id });
        await db.run("DELETE FROM conversations WHERE id = $id", { $id: conversation.id });
      }

      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post("/conversations/groups", requireAuth, socialLimiter, async (req, res, next) => {
    try {
      const title = String(req.body.title || "").trim().slice(0, 60);
      const rawMemberIds = Array.isArray(req.body.member_ids) ? req.body.member_ids : [];
      const memberIds = [...new Set(rawMemberIds.map((id) => Number(id)).filter(Boolean))]
        .filter((id) => id !== Number(req.user.id));

      if (!title) {
        return res.status(400).json({ error: "Group name is required." });
      }
      if (memberIds.length === 0) {
        return res.status(400).json({ error: "Choose at least one friend for the group." });
      }
      if (memberIds.length > 20) {
        return res.status(400).json({ error: "Groups can include up to 20 invited friends." });
      }

      for (const memberId of memberIds) {
        if (!(await usersAreFriends(db, req.user.id, memberId))) {
          return res.status(400).json({ error: "Groups can only include your friends." });
        }
        if (await usersAreBlocked(db, req.user.id, memberId)) {
          return res.status(403).json({ error: "Blocked users cannot be added to a group." });
        }
      }

      const row = await db.insert(
        "INSERT INTO conversations (title, type, created_by_user_id, created_at) VALUES ($title, 'group', $createdBy, $createdAt)",
        { $title: title, $createdBy: req.user.id, $createdAt: nowIso() }
      );

      await db.insert(
        "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($conversationId, $userId)",
        { $conversationId: row.id, $userId: req.user.id }
      );
      for (const memberId of memberIds) {
        await db.insert(
          "INSERT INTO conversation_members (conversation_id, user_id) VALUES ($conversationId, $userId)",
          { $conversationId: row.id, $userId: memberId }
        );
      }

      await db.persist();
      return res.json({ conversation_id: Number(row.id) });
    } catch (err) {
      return next(err);
    }
  });

  app.delete("/conversations/:id/members/me", requireAuth, async (req, res, next) => {
    try {
      const conversationId = Number(req.params.id);
      const conversation = await db.get(
        "SELECT id, type FROM conversations WHERE id = $id",
        { $id: conversationId }
      );
      if (!conversation || conversation.type !== "group") {
        return res.status(404).json({ error: "Group conversation not found." });
      }
      if (!(await isConversationMember(req.user.id, conversationId))) {
        return res.status(403).json({ error: "Not a conversation member." });
      }

      await db.run(
        "DELETE FROM conversation_members WHERE conversation_id = $conversationId AND user_id = $userId",
        { $conversationId: conversationId, $userId: req.user.id }
      );

      const remaining = await db.get(
        "SELECT COUNT(*) AS count FROM conversation_members WHERE conversation_id = $conversationId",
        { $conversationId: conversationId }
      );
      if (Number(remaining.count) === 0) {
        await db.run("DELETE FROM messages WHERE conversation_id = $conversationId", {
          $conversationId: conversationId
        });
        await db.run("DELETE FROM conversations WHERE id = $conversationId", {
          $conversationId: conversationId
        });
      }

      await db.persist();
      return res.json({ ok: true });
    } catch (err) {
      return next(err);
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
        `SELECT c.id, c.title, c.type, c.created_at
         FROM conversations c
         JOIN conversation_members cm ON cm.conversation_id = c.id
         WHERE cm.user_id = $me
         ORDER BY c.id DESC`,
        { $me: req.user.id }
      );

      const conversations = [];
      for (const c of myConversations) {
        const members = await getConversationMembers(db, c.id);
        if (await conversationHasBlockedMember(db, req.user.id, members)) {
          continue;
        }
        const other = members.find((member) => Number(member.id) !== Number(req.user.id));

        const lastMessage = await db.get(
          "SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = $c ORDER BY id DESC LIMIT 1",
          { $c: c.id }
        );

        conversations.push({
          id: Number(c.id),
          type: c.type === "group" ? "group" : "direct",
          title: c.title || "",
          created_at: c.created_at,
          members: members.map((member) => ({
            id: Number(member.id),
            username: member.username,
            profile_image_path: member.profile_image_path || "",
            last_seen_at: member.last_seen_at || null,
            online: isRecentlyOnline(member.last_seen_at)
          })),
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

      const members = await getConversationMembers(db, conversationId);
      if (members.length < 2 || await conversationHasBlockedMember(db, req.user.id, members)) {
        return res.status(403).json({ error: "This conversation is unavailable." });
      }

      const messages = (
        await db.all(
          `SELECT m.id, m.sender_id, m.body, m.created_at, m.display_mode,
                  m.attachment_name, m.attachment_type, m.attachment_data,
                  u.username AS sender_username
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
        attachment_name: m.attachment_name || "",
        attachment_type: m.attachment_type || "",
        attachment_data: m.attachment_data || "",
        created_at: m.created_at
      }));

      res.json({ messages });
    } catch (err) {
      next(err);
    }
  });

  app.post("/conversations/:id/messages", requireAuth, messageLimiter, async (req, res, next) => {
    try {
      const conversationId = Number(req.params.id);
      const body = String(req.body.body || "").trim();
      const displayMode = normalizeMessageDisplayMode(req.body.display_mode);
      const attachmentName = String(req.body.attachment_name || "").trim().slice(0, 180);
      const attachmentData = String(req.body.attachment_data || "").trim();

      if (!conversationId || (!body && !attachmentData)) {
        return res.status(400).json({ error: "A message or attachment is required." });
      }
      if (body.length > MAX_MESSAGE_CHARS) {
        return res.status(400).json({ error: `Messages must be ${MAX_MESSAGE_CHARS} characters or fewer.` });
      }

      if (!(await isConversationMember(req.user.id, conversationId))) {
        return res.status(403).json({ error: "Not a conversation member." });
      }

      const members = await getConversationMembers(db, conversationId);
      if (members.length < 2 || await conversationHasBlockedMember(db, req.user.id, members)) {
        return res.status(403).json({ error: "Messages are unavailable between these accounts." });
      }

      let attachment = { value: "", mimeType: "" };
      if (attachmentData) {
        try {
          attachment = parseDataUrl(attachmentData, {
            allowedTypes: ALLOWED_ATTACHMENT_TYPES,
            maxBytes: MAX_ATTACHMENT_BYTES,
            fieldName: "Attachment"
          });
        } catch (err) {
          return res.status(400).json({ error: err.message });
        }
      }

      const row = await db.insert(
        `INSERT INTO messages (
          conversation_id, sender_id, body, created_at, display_mode,
          attachment_name, attachment_type, attachment_data
        ) VALUES (
          $conversationId, $senderId, $body, $createdAt, $displayMode,
          $attachmentName, $attachmentType, $attachmentData
        )`,
        {
          $conversationId: conversationId,
          $senderId: req.user.id,
          $body: body,
          $createdAt: nowIso(),
          $displayMode: displayMode,
          $attachmentName: attachment.value ? attachmentName || "attachment" : null,
          $attachmentType: attachment.mimeType || null,
          $attachmentData: attachment.value || null
        }
      );
      await db.persist();

      const inserted = await db.get(
        `SELECT id, sender_id, body, created_at, display_mode,
                attachment_name, attachment_type, attachment_data
         FROM messages WHERE id = $id`,
        { $id: row.id }
      );

      res.json({
        message: {
          id: Number(inserted.id),
          sender_id: Number(inserted.sender_id),
          body: inserted.body,
          display_mode: normalizeMessageDisplayMode(inserted.display_mode),
          attachment_name: inserted.attachment_name || "",
          attachment_type: inserted.attachment_type || "",
          attachment_data: inserted.attachment_data || "",
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
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;

  return {
    host,
    port: actualPort,
    dbPath: db.kind === "sqlite" ? resolvedDbPath : null,
    databaseKind: db.kind,
    mailerProvider: mailer.provider,
    mailerEnabled: mailer.enabled,
    close: async () => {
      await db.close();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

module.exports = {
  createApiServer
};
