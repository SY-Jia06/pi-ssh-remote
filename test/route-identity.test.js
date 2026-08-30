import assert from "node:assert/strict";
import test from "node:test";
import { sshRouteId } from "../route-identity.js";

const base = {
  username: "root",
  host: "10.0.0.5",
  port: 22,
  sshTarget: "cluster-a",
  proxyJump: "bastion-a",
};

test("route identity is stable across equivalent syntax", () => {
  assert.equal(
    sshRouteId(base),
    sshRouteId({ ...base, sshTarget: "root@cluster-a", proxyJump: " bastion-a " }),
  );
});

test("aliases and ProxyJump chains remain distinct security identities", () => {
  const route = sshRouteId(base);
  assert.notEqual(route, sshRouteId({ ...base, sshTarget: "cluster-b" }));
  assert.notEqual(route, sshRouteId({ ...base, proxyJump: "bastion-b" }));
  assert.notEqual(route, sshRouteId({ ...base, proxyJump: "edge,bastion-a" }));
});

test("effective user, host, and port participate in route identity", () => {
  const route = sshRouteId(base);
  assert.notEqual(route, sshRouteId({ ...base, username: "alice" }));
  assert.notEqual(route, sshRouteId({ ...base, host: "10.0.0.6" }));
  assert.notEqual(route, sshRouteId({ ...base, port: 2222 }));
});
