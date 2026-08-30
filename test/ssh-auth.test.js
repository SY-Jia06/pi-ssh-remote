import assert from "node:assert/strict";
import test from "node:test";
import ssh2 from "ssh2";
import {
  authenticationSteps,
  createAuthHandler,
  isRecoverableAuthenticationError,
  parseOpenSshConfigOutput,
  resolveIdentityAgent,
  shouldInvalidateCachedPassword,
  shouldPromptForPassword,
} from "../ssh-auth.js";

const { Client, Server, utils } = ssh2;

test("ssh -G parser preserves ordered IdentityFile values", () => {
  const config = parseOpenSshConfigOutput([
    "host example",
    "hostname 10.0.0.5",
    "user alice",
    "port 2222",
    "identityfile ~/.ssh/first",
    "identityfile ~/.ssh/second",
    "identityagent /tmp/custom-agent.sock",
    "identitiesonly no",
    "proxyjump bastion",
  ].join("\n"));
  assert.deepEqual(config.identityFiles, ["~/.ssh/first", "~/.ssh/second"]);
  assert.equal(config.identitiesOnly, false);
  assert.equal(config.identityAgent, "/tmp/custom-agent.sock");
  assert.equal(config.proxyJump, "bastion");
});

test("IdentityAgent overrides, disables, or inherits SSH_AUTH_SOCK", () => {
  assert.equal(resolveIdentityAgent(undefined, "/tmp/default.sock"), "/tmp/default.sock");
  assert.equal(resolveIdentityAgent("SSH_AUTH_SOCK", "/tmp/default.sock"), "/tmp/default.sock");
  assert.equal(resolveIdentityAgent("none", "/tmp/default.sock"), undefined);
  assert.equal(resolveIdentityAgent("/tmp/custom.sock", "/tmp/default.sock"), "/tmp/custom.sock");
  assert.equal(resolveIdentityAgent("$CUSTOM_AUTH_SOCK", "/tmp/default.sock", {
    CUSTOM_AUTH_SOCK: "/tmp/env.sock",
  }), "/tmp/env.sock");
  assert.equal(resolveIdentityAgent("$MISSING_AUTH_SOCK", "/tmp/default.sock", {}), undefined);
});

test("authentication tries every configured identity before Agent and password", () => {
  assert.deepEqual(
    authenticationSteps({
      identityFiles: ["first", "second", "first"],
      identitiesOnly: false,
      agent: "/tmp/agent.sock",
      password: "secret",
    }),
    [
      { type: "none" },
      { type: "identity", identityFile: "first" },
      { type: "identity", identityFile: "second" },
      { type: "agent", agent: "/tmp/agent.sock" },
      { type: "password", password: "secret" },
    ],
  );
});

test("IdentitiesOnly disables Agent fallback but not password authentication", () => {
  assert.deepEqual(
    authenticationSteps({
      identityFiles: ["configured-key"],
      identitiesOnly: true,
      agent: "/tmp/agent.sock",
      password: "secret",
    }),
    [
      { type: "none" },
      { type: "identity", identityFile: "configured-key" },
      { type: "password", password: "secret" },
    ],
  );
});

test("auth handler skips unavailable identities and advances one method at a time", async () => {
  const prepared = [];
  const handler = createAuthHandler({
    steps: authenticationSteps({
      identityFiles: ["missing", "usable"],
      agent: "/tmp/agent.sock",
      password: "secret",
    }),
    username: "alice",
    prepareIdentity: async (identityFile) => {
      prepared.push(identityFile);
      return identityFile === "usable" ? { key: Buffer.from("private-key") } : undefined;
    },
    onError: assert.fail,
  });
  const next = () => new Promise((resolve) => handler(null, null, resolve));
  assert.deepEqual(await next(), { type: "none", username: "alice" });
  assert.deepEqual(await next(), { type: "publickey", username: "alice", key: Buffer.from("private-key") });
  assert.deepEqual(prepared, ["missing", "usable"]);
  assert.deepEqual(await next(), { type: "agent", username: "alice", agent: "/tmp/agent.sock" });
  assert.deepEqual(await next(), { type: "password", username: "alice", password: "secret" });
  assert.equal(await next(), false);
});

test("auth handler honors server methods without prompting unusable key methods", async () => {
  let prepared = false;
  const advertised = [];
  const handler = createAuthHandler({
    steps: authenticationSteps({
      identityFiles: ["encrypted"],
      agent: "/tmp/agent.sock",
      password: "secret",
    }),
    username: "alice",
    prepareIdentity: async () => { prepared = true; return undefined; },
    onMethodsLeft: (methodsLeft) => advertised.push(methodsLeft),
    onError: assert.fail,
  });
  const next = (methodsLeft) => new Promise((resolve) => handler(methodsLeft, false, resolve));
  assert.deepEqual(await next(["password"]), { type: "password", username: "alice", password: "secret" });
  assert.equal(prepared, false);
  assert.deepEqual(advertised, [["password"]]);
});

test("auth handler retains methods skipped before password-publickey partial success", async () => {
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["first"], password: "secret" }),
    username: "alice",
    prepareIdentity: async () => ({ key: Buffer.from("first-key") }),
    onError: assert.fail,
  });
  const next = (methodsLeft, partialSuccess = false) =>
    new Promise((resolve) => handler(methodsLeft, partialSuccess, resolve));
  assert.deepEqual(await next(null), { type: "none", username: "alice" });
  assert.deepEqual(await next(["password"]), { type: "password", username: "alice", password: "secret" });
  assert.deepEqual(await next(["publickey"], true), {
    type: "publickey", username: "alice", key: Buffer.from("first-key"),
  });
});

test("auth handler advances from publickey to password after partial success", async () => {
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["first"], password: "secret" }),
    username: "alice",
    prepareIdentity: async () => ({ key: Buffer.from("first-key") }),
    onError: assert.fail,
  });
  const next = (methodsLeft, partialSuccess = false) =>
    new Promise((resolve) => handler(methodsLeft, partialSuccess, resolve));
  assert.deepEqual(await next(null), { type: "none", username: "alice" });
  assert.equal((await next(["publickey"])).type, "publickey");
  assert.deepEqual(await next(["password"], true), { type: "password", username: "alice", password: "secret" });
});

test("auth handler uses a distinct key for publickey-publickey MFA", async () => {
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["first", "second"] }),
    username: "alice",
    prepareIdentity: async (identityFile) => ({ key: Buffer.from(identityFile) }),
    onError: assert.fail,
  });
  const next = (methodsLeft, partialSuccess = false) =>
    new Promise((resolve) => handler(methodsLeft, partialSuccess, resolve));
  assert.deepEqual(await next(null), { type: "none", username: "alice" });
  assert.deepEqual(await next(["publickey"]), { type: "publickey", username: "alice", key: Buffer.from("first") });
  assert.deepEqual(await next(["publickey"], true), { type: "publickey", username: "alice", key: Buffer.from("second") });
});

test("only nonterminal ssh2 authentication errors are recoverable", () => {
  assert.equal(isRecoverableAuthenticationError({ level: "agent", message: "agent unavailable" }), true);
  assert.equal(isRecoverableAuthenticationError({ level: "client-authentication", message: "Error signing data with key" }), true);
  assert.equal(isRecoverableAuthenticationError({
    level: "client-authentication", message: "All configured authentication methods failed",
  }), false);
  assert.equal(isRecoverableAuthenticationError({ level: "socket", message: "ECONNRESET" }), false);
});

test("cached passwords survive network errors and accepted MFA factors", () => {
  const authFailure = new Error("All configured authentication methods failed");
  assert.equal(shouldInvalidateCachedPassword(authFailure, true), true);
  assert.equal(shouldInvalidateCachedPassword(authFailure, false), false);
  assert.equal(shouldInvalidateCachedPassword(new Error("connect ECONNREFUSED"), true), false);
});

test("password prompting requires an authentication failure and a server offer", () => {
  const authFailure = new Error("All configured authentication methods failed");
  assert.equal(shouldPromptForPassword(authFailure, true), true);
  assert.equal(shouldPromptForPassword(authFailure, false), false);
  assert.equal(shouldPromptForPassword(new Error("connect ECONNREFUSED"), true), false);
});

test("auth handler reports an accepted password factor separately from an attempted one", async () => {
  const attempted = [];
  const accepted = [];
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["key"], password: "secret" }),
    username: "alice",
    prepareIdentity: async () => ({ key: Buffer.from("key") }),
    onAttempt: (attempt) => attempted.push(attempt.type),
    onAccepted: (attempt) => accepted.push(attempt.type),
    onError: assert.fail,
  });
  const next = (methodsLeft, partialSuccess = false) =>
    new Promise((resolve) => handler(methodsLeft, partialSuccess, resolve));
  await next(["password"]);
  await next(["publickey"], true);
  assert.deepEqual(attempted, ["password", "publickey"]);
  assert.deepEqual(accepted, ["password"]);
});

test("auth handler turns lazy key preparation errors into a clean stop", async () => {
  const failure = new Error("cannot unlock key");
  let reported;
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["encrypted"] }),
    username: "alice",
    prepareIdentity: async () => { throw failure; },
    onError: (error) => { reported = error; },
  });
  const next = () => new Promise((resolve) => handler(null, null, resolve));
  assert.deepEqual(await next(), { type: "none", username: "alice" });
  assert.equal(await next(), false);
  assert.equal(reported, failure);
});

test("ssh2 integration completes password-publickey MFA", async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const userKey = utils.generateKeyPairSync("ed25519").private;
  const parsedUserKey = utils.parseKey(userKey);
  const userPublic = parsedUserKey.getPublicSSH();
  const factors = [];
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connection.on("authentication", (ctx) => {
      if (ctx.method === "none") return ctx.reject(["password"]);
      if (ctx.method === "password") {
        assert.equal(ctx.password, "secret");
        factors.push("password");
        return ctx.reject(["publickey"], true);
      }
      if (ctx.method !== "publickey" || !ctx.key.data.equals(userPublic)) return ctx.reject(["publickey"]);
      if (!ctx.signature) factors.push("publickey");
      if (ctx.signature && !parsedUserKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      ctx.accept();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["user"], password: "secret" }),
    username: "alice",
    prepareIdentity: async () => ({ key: Buffer.from(userKey) }),
    onError: assert.fail,
  });
  const client = new Client();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH MFA integration test timed out")), 5000);
      client.once("ready", () => { clearTimeout(timer); resolve(); });
      client.once("error", (error) => { clearTimeout(timer); reject(error); });
      client.connect({ host: "127.0.0.1", port, username: "alice", hostVerifier: () => true, authHandler: handler });
    });
    assert.deepEqual(factors, ["password", "publickey"]);
  } finally {
    client.end();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ssh2 integration falls through the first key and authenticates with the second", async () => {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const first = utils.generateKeyPairSync("ed25519").private;
  const second = utils.generateKeyPairSync("ed25519").private;
  const firstPublic = utils.parseKey(first).getPublicSSH();
  const secondKey = utils.parseKey(second);
  const secondPublic = secondKey.getPublicSSH();
  const offered = [];
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connection.on("authentication", (ctx) => {
      if (ctx.method === "none") return ctx.reject(["publickey"]);
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      if (!ctx.signature) offered.push(ctx.key.data.toString("base64"));
      if (!ctx.key.data.equals(secondPublic)) return ctx.reject(["publickey"]);
      if (ctx.signature && !secondKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      ctx.accept();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const handler = createAuthHandler({
    steps: authenticationSteps({ identityFiles: ["first", "second"], identitiesOnly: true }),
    username: "alice",
    prepareIdentity: async (identityFile) => ({ key: Buffer.from(identityFile === "first" ? first : second) }),
    onError: assert.fail,
  });
  const client = new Client();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SSH integration test timed out")), 5000);
      client.once("ready", () => { clearTimeout(timer); resolve(); });
      client.once("error", (error) => { clearTimeout(timer); reject(error); });
      client.connect({ host: "127.0.0.1", port, username: "alice", hostVerifier: () => true, authHandler: handler });
    });
    assert.deepEqual(offered, [firstPublic.toString("base64"), secondPublic.toString("base64")]);
  } finally {
    client.end();
    await new Promise((resolve) => server.close(resolve));
  }
});
