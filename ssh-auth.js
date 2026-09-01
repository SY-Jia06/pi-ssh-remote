/** Parse the subset of `ssh -G` output used by the extension. */
export function parseOpenSshConfigOutput(output) {
  const result = { identityFiles: [] };
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.*)$/);
    if (!match) continue;
    const [, key, value] = match;
    if (key === "hostname") result.hostname = value;
    else if (key === "port") result.port = Number(value);
    else if (key === "user") result.user = value;
    else if (key === "identityfile" && value !== "none") result.identityFiles.push(value);
    else if (key === "identityagent") result.identityAgent = value;
    else if (key === "identitiesonly") result.identitiesOnly = value === "yes";
    else if (key === "proxyjump" && value !== "none") result.proxyJump = value;
  }
  return result;
}

/** Resolve OpenSSH's IdentityAgent override against the process Agent. */
export function resolveIdentityAgent(identityAgent, sshAuthSock, environment = process.env) {
  if (identityAgent === undefined || identityAgent === "SSH_AUTH_SOCK") return sshAuthSock;
  if (identityAgent.toLowerCase() === "none") return undefined;
  const variable = identityAgent.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  return variable ? environment[variable] : identityAgent;
}

/**
 * @param {{ identityFiles?: string[], identitiesOnly?: boolean, agent?: string, password?: string }} options
 */
export function authenticationSteps({ identityFiles = [], identitiesOnly = false, agent, password }) {
  const identities = [...new Set(identityFiles)];
  return [
    { type: "none" },
    ...identities.map((identityFile) => ({ type: "identity", identityFile })),
    ...(!identitiesOnly && agent ? [{ type: "agent", agent }] : []),
    ...(password !== undefined ? [{ type: "password", password }] : []),
  ];
}

/** True when ssh2 will continue its authentication state machine after this error. */
export function isRecoverableAuthenticationError(error) {
  return error?.level === "agent"
    || (error?.level === "client-authentication" && !/all configured authentication methods failed/i.test(error.message));
}

/** Only rejected password authentication should invalidate a cached password. */
export function shouldInvalidateCachedPassword(error, passwordRejected) {
  return Boolean(passwordRejected && /all configured authentication methods failed/i.test(error?.message));
}

/** Prompt only when the server advertised password authentication. */
export function shouldPromptForPassword(error, passwordOffered) {
  return Boolean(passwordOffered && /authentication methods failed|authentication failure/i.test(error?.message));
}

/** Build the stateful asynchronous handler expected by ssh2's `authHandler`. */
export function createAuthHandler({ steps, username, prepareIdentity, onMethodsLeft, onAttempt, onAccepted, onError }) {
  const accepted = new Set();
  let attempted = new Set();
  let lastAttemptIndex;
  let lastAttempt;

  const nextAttempt = async (methodsLeft, callback) => {
    const allowed = (method) => methodsLeft === null || methodsLeft.includes(method);
    for (let index = 0; index < steps.length; index++) {
      if (attempted.has(index)) continue;
      const step = steps[index];
      const method = step.type === "identity" || step.type === "agent" ? "publickey" : step.type;
      if (!allowed(method)) continue;
      attempted.add(index);

      let attempt;
      if (step.type === "none") attempt = { type: "none", username };
      else if (step.type === "identity") {
        const identity = await prepareIdentity(step.identityFile);
        if (!identity) continue;
        attempt = { type: "publickey", username, ...identity };
      } else if (step.type === "agent") attempt = { type: "agent", username, agent: step.agent };
      else attempt = { type: "password", username, password: step.password };

      lastAttemptIndex = index;
      lastAttempt = attempt;
      onAttempt?.(attempt);
      return callback(attempt);
    }
    lastAttemptIndex = undefined;
    lastAttempt = undefined;
    callback(false);
  };

  return (methodsLeft, partialSuccess, callback) => {
    onMethodsLeft?.(methodsLeft);
    if (partialSuccess) {
      if (lastAttemptIndex !== undefined) accepted.add(lastAttemptIndex);
      if (lastAttempt) onAccepted?.(lastAttempt);
      attempted = new Set(accepted);
    }
    void nextAttempt(methodsLeft, callback).catch((error) => {
      onError?.(error);
      callback(false);
    });
  };
}
