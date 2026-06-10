const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createApiServer } = require("./index");

async function request(baseUrl, route, { method = "GET", token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
}

async function register(baseUrl, email, username) {
  const response = await request(baseUrl, "/auth/register", {
    method: "POST",
    body: { email, username, password: "test-password" }
  });
  assert.equal(response.status, 200);
  return response.payload;
}

test("authorization, blocking, attachments, and sessions", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "coded-messages-test-"));
  const dbPath = path.join(tempDir, "app.sqlite");
  const server = await createApiServer({
    host: "127.0.0.1",
    port: 0,
    dbPath,
    allowInsecureDevJwt: true
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  t.after(async () => {
    await server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const alice = await register(baseUrl, "alice@example.test", "alice");
  const bob = await register(baseUrl, "bob@example.test", "bob");
  const charlie = await register(baseUrl, "charlie@example.test", "charlie");

  const friendRequest = await request(baseUrl, "/friends/request", {
    method: "POST",
    token: alice.token,
    body: { username: "bob" }
  });
  assert.equal(friendRequest.status, 200);

  const incoming = await request(baseUrl, "/friends/requests", { token: bob.token });
  assert.equal(incoming.status, 200);
  assert.equal(incoming.payload.requests.length, 1);

  const accepted = await request(
    baseUrl,
    `/friends/request/${incoming.payload.requests[0].id}/accept`,
    { method: "POST", token: bob.token }
  );
  assert.equal(accepted.status, 200);

  const friends = await request(baseUrl, "/friends", { token: alice.token });
  const conversationId = friends.payload.friends[0].conversation_id;
  assert.ok(conversationId);

  const outsiderRead = await request(
    baseUrl,
    `/conversations/${conversationId}/messages`,
    { token: charlie.token }
  );
  assert.equal(outsiderRead.status, 403);

  const invalidAttachment = await request(
    baseUrl,
    `/conversations/${conversationId}/messages`,
    {
      method: "POST",
      token: alice.token,
      body: {
        body: "",
        attachment_name: "unsafe.html",
        attachment_data: "data:text/html;base64,PGgxPm5vPC9oMT4="
      }
    }
  );
  assert.equal(invalidAttachment.status, 400);

  const validAttachment = await request(
    baseUrl,
    `/conversations/${conversationId}/messages`,
    {
      method: "POST",
      token: alice.token,
      body: {
        body: "file",
        display_mode: "plain",
        attachment_name: "note.txt",
        attachment_data: "data:text/plain;base64,aGVsbG8="
      }
    }
  );
  assert.equal(validAttachment.status, 200);

  const report = await request(baseUrl, `/reports/${bob.user.id}`, {
    method: "POST",
    token: alice.token,
    body: { reason: "spam" }
  });
  assert.equal(report.status, 200);

  const blocked = await request(baseUrl, `/blocks/${bob.user.id}`, {
    method: "POST",
    token: alice.token
  });
  assert.equal(blocked.status, 200);

  const blockedRequest = await request(baseUrl, "/friends/request", {
    method: "POST",
    token: bob.token,
    body: { username: "alice" }
  });
  assert.equal(blockedRequest.status, 403);

  const secondLogin = await request(baseUrl, "/auth/login", {
    method: "POST",
    body: { email: "alice@example.test", password: "test-password" }
  });
  assert.equal(secondLogin.status, 200);

  const sessions = await request(baseUrl, "/sessions", { token: alice.token });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.payload.sessions.length, 2);
  const otherSession = sessions.payload.sessions.find((session) => !session.current);
  assert.ok(otherSession);

  const revoked = await request(baseUrl, `/sessions/${otherSession.id}`, {
    method: "DELETE",
    token: alice.token
  });
  assert.equal(revoked.status, 200);

  const revokedTokenUse = await request(baseUrl, "/me", { token: secondLogin.payload.token });
  assert.equal(revokedTokenUse.status, 401);
});
