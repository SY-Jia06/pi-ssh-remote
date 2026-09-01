import { createHash } from "node:crypto";

/**
 * @param {{ username: string, host: string, port: number, sshTarget: string, proxyJump?: string }} route
 */
export function sshRouteId({ username, host, port, sshTarget, proxyJump }) {
  const at = sshTarget.lastIndexOf("@");
  const target = at >= 0 ? sshTarget.slice(at + 1) : sshTarget;
  const jumps = proxyJump?.split(",").map((jump) => jump.trim()).filter(Boolean) ?? [];
  const route = JSON.stringify([username, host, port, target, jumps]);
  return `route:${createHash("sha256").update(route).digest("base64url")}`;
}
