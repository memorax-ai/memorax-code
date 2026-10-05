import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server } from "node:http2";
import { createConnection, createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import {
  createCompletedTurn, createConnectDecoder, decodeAgentClientMessage, encodeConnectEnvelope,
} from "./cursor-app-protocol.mjs";

const agentPath = "/agent.v1.AgentService/Run";
const http2Preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const maxFrameBytes = 8 * 1024 * 1024;
const corsHeaders = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization" };
const unsupportedAncillaryPaths = new Set([
  "/agent.v1.AgentService/UpdateConversationMetadata", "/aiserver.v1.AnalyticsService/SubmitLogs",
]);
const protocolErrorCodes = new Set([
  "CURSOR_APP_CONNECT_COMPRESSION", "CURSOR_APP_CONNECT_END_STREAM", "CURSOR_APP_CONNECT_FLAGS",
  "CURSOR_APP_CONNECT_FRAME_TOO_LARGE", "CURSOR_APP_CONNECT_TRAILING_DATA", "CURSOR_APP_CONNECT_TRUNCATED",
  "CURSOR_APP_PROTO_BYTES", "CURSOR_APP_PROTO_FIELD", "CURSOR_APP_PROTO_REFERENCE", "CURSOR_APP_PROTO_TAG",
  "CURSOR_APP_PROTO_TOO_LARGE", "CURSOR_APP_PROTO_TRUNCATED", "CURSOR_APP_PROTO_UTF8", "CURSOR_APP_PROTO_VARINT",
  "CURSOR_APP_PROTO_WIRE", "CURSOR_APP_RUN_IDENTITY", "CURSOR_APP_RUN_PROMPT", "CURSOR_APP_RUN_UNSUPPORTED",
  "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED", "CURSOR_APP_KV_ID", "CURSOR_APP_RESPONSE_TEXT",
]);
const ancillaryPaths = new Set([
  "/auth/full_stripe_profile",
  ...[
    ["MCPRegistryService", "GetKnownServers"],
    ["DashboardService", "GetGlobalCommands", "GetTeamCommands", "ListMarketplacePlugins", "GetUserPrivacyMode",
      "IsOnNewPricing", "GetTeamAdminSettingsOrEmptyIfNotInTeam", "GetTeams", "GetMe", "GetScmConnectionStatus",
      "GetUsageLimitStatusAndActiveGrants", "GetPlanInfo", "GetCurrentPeriodUsage", "GetManagedSkills",
      "GetEffectiveUserPlugins", "ListMarketplaces"],
    ["AiService", "AvailableModels", "GetDefaultModelNudgeData", "NameTab", "ServerTime", "CppEditHistoryStatus",
      "KnowledgeBaseList"],
    ["CppService", "AvailableModels"], ["AuthService", "GetEmail"], ["AnalyticsService", "Batch"],
    ["ServerConfigService", "GetServerConfig"], ["FileSyncService", "FSIsEnabledForUser"],
  ].flatMap(([service, ...methods]) => methods.map((method) => `/aiserver.v1.${service}/${method}`)),
]);
function isAgentPath(path) { return /^\/agent\.v[0-9]+\./.test(path) && !unsupportedAncillaryPaths.has(path); }

export async function startCursorAgentMock({ answer, timeoutMs = 15_000 }) {
  if (typeof answer !== "string" || !answer.length || Buffer.byteLength(answer) > maxFrameBytes
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw Object.assign(new Error("CURSOR_MOCK_OPTIONS_INVALID"), { nativeCode: "CURSOR_MOCK_OPTIONS_INVALID" });
  }
  const requests = [], runs = [], errors = [], connectionErrors = [], unknownRpcMethods = [];
  const sockets = new Set(), sessions = new Set(), requestIds = new Set(), listeners = [];
  let closed = false, closePromise, ancillaryRequestCount = 0, unsupportedRpcCount = 0;
  const trackSocket = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    if (closed) socket.destroy();
    return socket;
  };
  const recordRequest = (method, target, protocol) => {
    const path = String(target ?? "").split("?", 1)[0];
    requests.push({ method: ["GET", "HEAD", "POST", "OPTIONS"].includes(method) ? method : "<other>",
      path: path === agentPath || ancillaryPaths.has(path) ? path : "<unknown>", protocol });
    if (!isAgentPath(path)) ancillaryRequestCount++;
    if (path !== agentPath && (protocol === "h2c" || !ancillaryPaths.has(path)) && path.length <= 160
      && /^\/[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/.test(path) && !unknownRpcMethods.includes(path)) unknownRpcMethods.push(path);
    return path;
  };
  const http1 = createHttpServer((request, response) => {
    const path = recordRequest(request.method, request.url, "http/1.1");
    let bytes = 0;
    request.on("error", () => {});
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxFrameBytes) {
        (isAgentPath(path) ? errors : connectionErrors).push("CURSOR_MOCK_REQUEST_TOO_LARGE"); request.destroy();
      }
    });
    request.on("end", () => {
      const status = !ancillaryPaths.has(path) ? 404 : request.method === "OPTIONS" ? 204
        : !["GET", "POST"].includes(request.method) ? 405 : 200;
      if (isAgentPath(path)) errors.push("CURSOR_AGENT_HTTP2_REQUIRED");
      else if (status >= 400) unsupportedRpcCount++;
      response.writeHead(status, { "content-type": "application/json", ...corsHeaders });
      response.end(status === 204 ? undefined : "{}");
    });
  });
  http1.requestTimeout = timeoutMs;
  http1.headersTimeout = timeoutMs;
  http1.on("connection", trackSocket);
  http1.on("clientError", (_error, socket) => {
    if (!closed) connectionErrors.push("CURSOR_MOCK_HTTP1_INVALID");
    socket.destroy();
  });
  const http2 = createHttp2Server();
  http2.on("connection", trackSocket);
  http2.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => { if (!closed) connectionErrors.push("CURSOR_MOCK_HTTP2_SESSION_ERROR"); });
    session.once("close", () => sessions.delete(session));
    if (closed) session.destroy();
  });
  http2.on("stream", (stream, headers) => {
    const path = recordRequest(headers[":method"], headers[":path"], "h2c");
    const compression = headers["connect-content-encoding"] ?? "identity";
    const requestId = headers["x-request-id"];
    let run, completion, pendingAck, settled = false, totalBytes = 0, messageCount = 0;
    const acknowledged = new Set();
    const timer = setTimeout(() => fail("CURSOR_AGENT_TIMEOUT"), timeoutMs);
    const decoder = createConnectDecoder({ compression: compression === "gzip" ? "gzip" : "identity", maxFrameBytes });
    const send = (message) => stream.write(encodeConnectEnvelope(message));
    function fail(code) {
      if (settled || closed) return;
      settled = true;
      clearTimeout(timer);
      if (isAgentPath(path)) errors.push(code);
      else unsupportedRpcCount++;
      if (run) run.error = code;
      if (!stream.destroyed && !stream.closed) {
        if (!stream.headersSent) stream.respond({ ":status": path === agentPath ? 200 : 404,
          "content-type": "application/connect+proto" });
        stream.end(encodeConnectEnvelope(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: code } })),
          { endStream: true }));
      }
    }
    function advance() {
      if (!run || settled || pendingAck !== undefined) return;
      if (run.kvAckCount < completion.kvWrites.length) {
        const write = completion.kvWrites[run.kvAckCount];
        pendingAck = write.id;
        send(write.message);
        run.kvWriteCount++;
        return;
      }
      send(completion.checkpointMessage);
      send(completion.textMessage);
      send(completion.turnEndedMessage);
      settled = true;
      run.completed = true;
      clearTimeout(timer);
      stream.end(encodeConnectEnvelope(Buffer.from("{}"), { endStream: true }));
    }
    function receive(bytes) {
      const message = decodeAgentClientMessage(bytes, { requestId });
      if (message.type === "heartbeat") return;
      if (message.type === "run") {
        if (run || requestIds.has(message.requestId)) { fail("CURSOR_AGENT_DUPLICATE_RUN"); return; }
        completion = createCompletedTurn(message, { answer, firstKvId: 1 });
        requestIds.add(message.requestId);
        run = { ...message, inputConversationStateBytes: message.conversationStateBytes,
          conversationStateBytes: completion.conversationStateBytes, turnBlobId: completion.turnBlobId,
          kvWrites: completion.kvWrites, kvWriteCount: 0, kvAckCount: 0, completed: false };
        runs.push(run);
        return;
      }
      if (message.type !== "kvAck") { fail("CURSOR_AGENT_UNKNOWN_MESSAGE"); return; }
      if (acknowledged.has(message.id)) { fail("CURSOR_AGENT_DUPLICATE_ACK"); return; }
      if (!run || pendingAck !== message.id) { fail("CURSOR_AGENT_UNKNOWN_ACK"); return; }
      if (message.error !== undefined) { fail("CURSOR_AGENT_KV_REJECTED"); return; }
      acknowledged.add(message.id);
      run.kvAckCount++;
      pendingAck = undefined;
    }
    stream.on("error", () => fail("CURSOR_AGENT_STREAM_ERROR"));
    stream.once("aborted", () => fail("CURSOR_AGENT_STREAM_ABORTED"));
    stream.once("close", () => { clearTimeout(timer); fail("CURSOR_AGENT_STREAM_CLOSED"); });
    stream.on("data", (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > 4 * maxFrameBytes) { fail("CURSOR_AGENT_REQUEST_TOO_LARGE"); return; }
      try {
        for (const bytes of decoder.push(chunk)) {
          if (++messageCount > 128) { fail("CURSOR_AGENT_TOO_MANY_MESSAGES"); return; }
          receive(bytes);
          if (settled) return;
        }
        advance();
      } catch (error) { fail(protocolErrorCodes.has(error.code) ? error.code : "CURSOR_AGENT_INVALID_MESSAGE"); }
    });
    stream.once("end", () => {
      if (settled) return;
      try { decoder.finish(); }
      catch (error) { fail(protocolErrorCodes.has(error.code) ? error.code : "CURSOR_AGENT_INVALID_MESSAGE"); return; }
      fail(run ? "CURSOR_AGENT_ACK_MISSING" : "CURSOR_AGENT_RUN_MISSING");
    });
    if (path !== agentPath) fail(isAgentPath(path) ? "CURSOR_AGENT_ROUTE_INVALID" : "CURSOR_MOCK_UNKNOWN_ROUTE");
    else if (headers[":method"] !== "POST") fail("CURSOR_MOCK_METHOD_INVALID");
    else if (headers["content-type"]?.split(";", 1)[0] !== "application/connect+proto"
      || !["identity", "gzip"].includes(compression)) fail("CURSOR_AGENT_ENCODING_INVALID");
    else if (typeof requestId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
      fail("CURSOR_AGENT_REQUEST_ID_INVALID");
    } else stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
  });

  // Sniff only the HTTP/2 preface; both protocol servers remain on private loopback ports.
  function createFront() {
    const server = createTcpServer((socket) => {
      trackSocket(socket);
      let prefix = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (!closed) connectionErrors.push("CURSOR_MOCK_PREFACE_TIMEOUT");
        socket.destroy();
      }, timeoutMs);
      socket.once("close", () => clearTimeout(timer));
      const sniff = (chunk) => {
        prefix = Buffer.concat([prefix, chunk]);
        const possibleHttp2 = prefix.subarray(0, Math.min(prefix.length, http2Preface.length))
          .equals(http2Preface.subarray(0, Math.min(prefix.length, http2Preface.length)));
        if (possibleHttp2 && prefix.length < http2Preface.length) return;
        clearTimeout(timer);
        socket.pause();
        socket.removeListener("data", sniff);
        const target = possibleHttp2 ? http2 : http1;
        const upstream = trackSocket(createConnection({ host: "127.0.0.1", port: target.address().port }));
        upstream.once("error", () => { if (!closed) connectionErrors.push("CURSOR_MOCK_FORWARD_FAILED"); socket.destroy(); });
        socket.once("close", () => upstream.destroy());
        upstream.once("connect", () => {
          upstream.write(prefix);
          socket.pipe(upstream).pipe(socket);
          socket.resume();
        });
      };
      socket.on("data", sniff);
    });
    listeners.push(server);
    return server;
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    closePromise = Promise.all([...listeners, http1, http2].map((server) => new Promise((done) => server.close(done))));
    await closePromise;
  }
  try {
    await listen(http1, "127.0.0.1");
    await listen(http2, "127.0.0.1");
    const front = createFront();
    await listen(front, "127.0.0.1");
    const port = front.address().port;
    if (Object.values(networkInterfaces()).flat().some((entry) => entry?.internal && entry.address === "::1")) {
      await listen(createFront(), "::1", port);
    }
    return { url: `http://localhost:${port}`, requests, runs, errors, connectionErrors, unknownRpcMethods, close,
      get ancillaryRequestCount() { return ancillaryRequestCount; },
      get unsupportedRpcCount() { return unsupportedRpcCount; } };
  } catch (error) { await close(); throw error; }
}

async function listen(server, host, port = 0) {
  await new Promise((done, reject) => {
    server.once("error", reject);
    server.listen({ host, port, ipv6Only: host === "::1" }, () => { server.removeListener("error", reject); done(); });
  });
}
