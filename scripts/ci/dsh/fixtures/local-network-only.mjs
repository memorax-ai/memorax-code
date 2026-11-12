import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function checkHost(host) {
  if (!loopback.has(String(host))) {
    throw new Error("DSH_NATIVE_EXTERNAL_NETWORK_BLOCKED");
  }
}

function checkRequest(input) {
  if (input instanceof URL || typeof input === "string") {
    checkHost(new URL(input).hostname);
    return;
  }
  if (input?.socketPath) return;
  const host = input?.hostname ?? input?.host ?? "localhost";
  checkHost(loopback.has(host) ? host : new URL(`http://${host}`).hostname);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, ...args) {
  checkRequest(input instanceof Request ? input.url : input);
  return originalFetch.call(this, input, ...args);
};

// The socket fence also covers redirects and clients that bypass fetch/http.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const options = normalized[0];
  if (typeof options === "object") {
    if (!options.path) checkHost(options.host ?? options.hostname ?? "localhost");
  } else if (typeof options === "number") {
    checkHost(typeof normalized[1] === "string" ? normalized[1] : "localhost");
  } else if (typeof options !== "string") {
    throw new Error("DSH_NATIVE_NETWORK_TARGET_UNKNOWN");
  }
  return originalConnect.apply(this, args);
};

for (const module of [http, https]) {
  const original = module.request;
  module.request = function (input, ...args) {
    checkRequest(input);
    return original.call(this, input, ...args);
  };
  module.get = function (input, ...args) {
    const request = module.request(input, ...args);
    request.end();
    return request;
  };
}
syncBuiltinESMExports();
