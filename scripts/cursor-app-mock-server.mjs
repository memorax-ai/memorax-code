import { createHash, randomUUID } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttp2Server, constants as http2Constants } from "node:http2";
import { createConnection, createServer as createTcpServer } from "node:net";
import { networkInterfaces } from "node:os";
import {
  completeToolExecution, createCompletedTurn, createConnectDecoder, createExecAbortMessage, createGetBlobMessage, createToolExecution,
  decodeAgentClientMessage, encodeConnectEnvelope,
} from "./cursor-app-protocol.mjs";

const agentPath = "/agent.v1.AgentService/Run";
const http2Preface = Buffer.from("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const maxFrameBytes = 8 * 1024 * 1024;
const corsHeaders = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization" };
const unsupportedAncillaryPaths = new Set([
  "/agent.v1.AgentService/UpdateConversationMetadata", "/aiserver.v1.AnalyticsService/SubmitLogs",
  "/agent.v1.AgentService/GetNewChatNudgeParameterizedModelPicker",
]);
const protocolErrorCodes = new Set([
  "CURSOR_APP_CONNECT_COMPRESSION", "CURSOR_APP_CONNECT_END_STREAM", "CURSOR_APP_CONNECT_FLAGS",
  "CURSOR_APP_CONNECT_REMOTE_ERROR",
  "CURSOR_APP_CONNECT_FRAME_TOO_LARGE", "CURSOR_APP_CONNECT_TRAILING_DATA", "CURSOR_APP_CONNECT_TRUNCATED",
  "CURSOR_APP_PROTO_BYTES", "CURSOR_APP_PROTO_FIELD", "CURSOR_APP_PROTO_REFERENCE", "CURSOR_APP_PROTO_TAG",
  "CURSOR_APP_PROTO_TOO_LARGE", "CURSOR_APP_PROTO_TRUNCATED", "CURSOR_APP_PROTO_UTF8", "CURSOR_APP_PROTO_VARINT",
  "CURSOR_APP_PROTO_WIRE", "CURSOR_APP_RUN_IDENTITY", "CURSOR_APP_RUN_PROMPT", "CURSOR_APP_RUN_UNSUPPORTED",
  "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED", "CURSOR_APP_KV_ID", "CURSOR_APP_RESPONSE_TEXT",
  "CURSOR_APP_EXEC_IDENTITY", "CURSOR_APP_EXEC_OPTIONS", "CURSOR_APP_EXEC_REJECTED",
  "CURSOR_APP_EXEC_READ_UNSUPPORTED", "CURSOR_APP_EXEC_SHELL_UNSUPPORTED",
]);
const toolPlanErrorCodes = new Set([
  "CURSOR_APP_SKILL_IDENTITY", "CURSOR_APP_SKILL_HOOK_CONTEXT", "CURSOR_APP_SKILL_NOT_DISCOVERED",
  "CURSOR_APP_SKILL_NOT_READ", "CURSOR_APP_SKILL_REFERENCE_NOT_READ", "CURSOR_APP_SKILL_COMMAND_FAILED",
  "CURSOR_APP_SKILL_RESULT_JSON", "CURSOR_APP_SKILL_EXEC_COUNT", "CURSOR_APP_SKILL_TRACE_IDENTITY",
  "CURSOR_APP_SKILL_REFERENCE", "CURSOR_APP_MEMORY_OPERATION", "CURSOR_APP_MEMORY_FIXTURE",
  "CURSOR_APP_MEMORY_TRANSPORT", "CURSOR_APP_MEMORY_RESULT_SCOPE", "CURSOR_APP_SEARCH_PAYLOAD",
  "CURSOR_APP_SEARCH_RESULT", "CURSOR_APP_EXPLICIT_ADD_TIMESTAMP", "CURSOR_APP_EXPLICIT_ADD_PAYLOAD",
  "CURSOR_APP_EXPLICIT_ADD_RESULT", "CURSOR_APP_INTERRUPTION_IDENTITY", "CURSOR_APP_INTERRUPTION_TOOL_EXECUTED",
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

export async function startCursorAgentMock({ answer, answers, toolSteps, timeoutMs = 15_000 }) {
  const answerSequence = answers === undefined ? undefined : Array.isArray(answers) ? [...answers] : [];
  if (!(answerSequence ?? [answer]).length || (answerSequence ?? [answer]).some((value) =>
    typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxFrameBytes)
    || toolSteps !== undefined && typeof toolSteps !== "function"
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw Object.assign(new Error("CURSOR_MOCK_OPTIONS_INVALID"), { nativeCode: "CURSOR_MOCK_OPTIONS_INVALID" });
  }
  const requests = [], runs = [], errors = [], connectionErrors = [], unknownRpcMethods = [];
  const sockets = new Set(), sessions = new Set(), requestIds = new Set(), listeners = [];
  const histories = new Map(), activeConversations = new Set(), cancellationArms = new Map();
  let closed = false, closePromise, firstShellFailure, ancillaryRequestCount = 0, unsupportedRpcCount = 0;
  function armCancellation(input) {
    const arm = !closed && cancellationArms.get(input?.requestId);
    if (!arm || !arm(input?.toolCallId)) {
      throw Object.assign(new Error("CURSOR_AGENT_CANCELLATION_STATE"), { code: "CURSOR_AGENT_CANCELLATION_STATE" });
    }
  }
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
    const streamSession = stream.session;
    const path = recordRequest(headers[":method"], headers[":path"], "h2c");
    const compression = headers["connect-content-encoding"] ?? "identity";
    const requestId = headers["x-request-id"];
    let run, completion, pendingKv, pendingExec, selectedAnswer, kvReads, history, cancellation;
    let settled = false, totalBytes = 0, messageCount = 0;
    const acknowledged = new Set();
    const completedExecIds = new Set(), completedToolSteps = [];
    const timer = setTimeout(() => fail("CURSOR_AGENT_TIMEOUT"), timeoutMs);
    const decoder = createConnectDecoder({ compression: compression === "gzip" ? "gzip" : "identity", maxFrameBytes });
    const send = (message) => stream.write(encodeConnectEnvelope(message));
    function fail(code) {
      if (settled || closed) return;
      settled = true;
      clearTimeout(timer);
      if (isAgentPath(path)) errors.push(code);
      else unsupportedRpcCount++;
      if (run) {
        run.error = code;
        if (code === "CURSOR_APP_EXEC_REJECTED" && run.execRejection?.kind === "shell") firstShellFailure ??= run;
        delete run.pendingTool;
        activeConversations.delete(run.conversationId);
        cancellationArms.delete(run.requestId);
      }
      if (!stream.destroyed && !stream.closed) {
        if (!stream.headersSent) stream.respond({ ":status": path === agentPath ? 200 : 404,
          "content-type": "application/connect+proto" });
        if (pendingExec && !pendingExec.closed) send(createExecAbortMessage(pendingExec.execution.id));
        stream.end(encodeConnectEnvelope(Buffer.from(JSON.stringify({ error: { code: "invalid_argument", message: code } })),
          { endStream: true }));
      }
    }
    function failAfterCompletion(code) {
      if (closed || !run?.completed || run.error) return;
      run.completed = false;
      run.error = code;
      errors.push(code);
      stream.close();
    }
    function advance() {
      if (!run || settled || cancellation || pendingKv !== undefined) return;
      if (run.kvReadResultCount < kvReads.length) {
        const read = kvReads[run.kvReadResultCount];
        pendingKv = { ...read, type: "kvGetResult" };
        send(createGetBlobMessage(read));
        run.kvReadCount++;
        return;
      }
      if (pendingExec) {
        if (!pendingExec.closed) return;
        const completed = pendingExec.completed;
        if (pendingExec.execution.kind === "requestContext") {
          run.requestContext = completed.result;
          run.requestContextBytes = completed.requestContextBytes;
        } else {
          send(completed.completedMessage);
          run.toolResults.push(completed.result);
          completedToolSteps.push(completed.stepBytes);
        }
        completedExecIds.add(pendingExec.execution.id);
        pendingExec = undefined;
        delete run.pendingTool;
      }
      if (!completion) {
        let step;
        try { step = toolSteps?.(run, [...run.toolResults]); }
        catch (error) {
          const code = error?.nativeCode ?? error?.code;
          fail(toolPlanErrorCodes.has(code) ? code : "CURSOR_AGENT_TOOL_PLAN_FAILED");
          return;
        }
        if (step !== undefined) {
          if (typeof step?.then === "function") {
            Promise.resolve(step).catch(() => {});
            fail("CURSOR_APP_EXEC_OPTIONS"); return;
          }
          const context = step?.kind === "requestContext";
          if (context && run.requestContextRequestCount) { fail("CURSOR_AGENT_CONTEXT_DUPLICATE"); return; }
          if (!context && run.execRequestCount >= 8) { fail("CURSOR_AGENT_EXEC_LIMIT"); return; }
          const execution = createToolExecution(run, step, {
            id: kvReads.length + run.execRequestCount + run.requestContextRequestCount + 1, toolCallId: randomUUID(),
          });
          pendingExec = { execution, closed: false, heartbeats: 0 };
          if (context) run.requestContextRequestCount++;
          else {
            run.pendingTool = { id: execution.id, toolCallId: execution.toolCallId, kind: execution.kind };
            if (execution.kind === "shell") run.shellApproval = { toolCallId: execution.toolCallId, clicked: false };
            run.execRequestCount++;
            send(execution.startedMessage);
          }
          send(execution.execMessage);
          return;
        }
        completion = createCompletedTurn(run, { answer: selectedAnswer, toolSteps: completedToolSteps,
          firstKvId: kvReads.length + run.execRequestCount + run.requestContextRequestCount + 1 });
        run.conversationStateBytes = completion.conversationStateBytes;
        run.turnBlobId = completion.turnBlobId;
        run.kvWrites = completion.kvWrites;
      }
      if (run.kvAckCount < completion.kvWrites.length) {
        const write = completion.kvWrites[run.kvAckCount];
        pendingKv = { id: write.id, type: "kvAck" };
        send(write.message);
        run.kvWriteCount++;
        return;
      }
      send(completion.checkpointMessage);
      send(completion.textMessage);
      send(completion.turnEndedMessage);
      settled = true;
      run.completed = true;
      histories.set(run.conversationId, [...history, completion]);
      activeConversations.delete(run.conversationId);
      cancellationArms.delete(run.requestId);
      clearTimeout(timer);
      stream.end(encodeConnectEnvelope(Buffer.from("{}"), { endStream: true }));
    }
    function receive(bytes) {
      const message = decodeAgentClientMessage(bytes, { requestId, allowCancellation: Boolean(cancellation) });
      if (message.type === "heartbeat") return;
      if (message.type === "cancelAction") {
        if (!cancellation) { fail("CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED"); return; }
        if (cancellation.actionReceived) { fail("CURSOR_AGENT_CANCELLATION_DUPLICATE"); return; }
        cancellation.actionReceived = true;
        return;
      }
      if (message.type === "run") {
        if (run || requestIds.has(message.requestId)) { fail("CURSOR_AGENT_DUPLICATE_RUN"); return; }
        if (activeConversations.has(message.conversationId)) { fail("CURSOR_AGENT_CONVERSATION_BUSY"); return; }
        history = histories.get(message.conversationId) ?? [];
        if (message.turnRefs.length !== history.length
          || message.turnRefs.some((reference, index) => !reference.equals(history[index].turnBlobId))) {
          fail("CURSOR_AGENT_HISTORY_MISMATCH"); return;
        }
        if (answerSequence && runs.length >= answerSequence.length) { fail("CURSOR_AGENT_ANSWER_EXHAUSTED"); return; }
        kvReads = history.flatMap((turn) => turn.kvWrites).map((write, index) =>
          ({ id: index + 1, blobId: write.blobId, bytes: write.bytes }));
        selectedAnswer = answerSequence?.[runs.length] ?? answer;
        requestIds.add(message.requestId);
        activeConversations.add(message.conversationId);
        run = { ...message, inputConversationStateBytes: message.conversationStateBytes, inputRequestContext: message.requestContext,
          kvWrites: [], kvWriteCount: 0, kvAckCount: 0, kvReadCount: 0, kvReadResultCount: 0,
          toolResults: [], execRequestCount: 0, execResultCount: 0, execCloseCount: 0,
          shellApproval: { toolCallId: undefined, clicked: false },
          requestContextRequestCount: 0, requestContextResultCount: 0, requestContextCloseCount: 0, completed: false, cancelled: false };
        runs.push(run);
        cancellationArms.set(run.requestId, (toolCallId) => {
          if (settled || cancellation || stream.closed || stream.destroyed || completion || pendingKv
            || run.kvWrites.length || run.kvWriteCount || run.kvAckCount
            || run.requestContextRequestCount !== 1 || run.requestContextResultCount !== 1 || run.requestContextCloseCount !== 1
            || pendingExec?.execution.kind !== "shell" || pendingExec.completed || pendingExec.closed
            || pendingExec.execution.toolCallId !== toolCallId) return false;
          cancellation = { id: pendingExec.execution.id, toolCallId, rejected: false, execClosed: false,
            actionReceived: false, transportClosed: false, transportEvents: [] };
          run.cancellation = cancellation;
          return true;
        });
        return;
      }
      if (message.type === "execResult" || message.type === "execControl") {
        if (completedExecIds.has(message.id)) { fail("CURSOR_AGENT_EXEC_DUPLICATE"); return; }
        if (!run || pendingExec?.execution.id !== message.id) { fail("CURSOR_AGENT_EXEC_UNKNOWN"); return; }
        if (message.type === "execResult") {
          if (pendingExec.completed || cancellation?.rejected) { fail("CURSOR_AGENT_EXEC_DUPLICATE"); return; }
          if (message.error) run.execRejection = { id: message.id, kind: message.kind,
            toolCallId: pendingExec.execution.toolCallId, rejectionKind: message.rejectionKind,
            ...(message.exitCode === undefined ? {} : { exitCode: message.exitCode }),
            ...(message.output === undefined ? {} : { output: message.output }) };
          if (cancellation) {
            const execution = pendingExec.execution;
            if (message.kind !== execution.kind || message.execId !== undefined && message.execId !== execution.toolCallId
              || (!message.error || message.rejectionKind === 4)
                && (message.command !== execution.command || message.workingDirectory !== execution.workingDirectory)) {
              fail("CURSOR_APP_EXEC_IDENTITY");
            } else if (!message.error) fail("CURSOR_AGENT_CANCELLATION_EXECUTED");
            else if (message.rejectionKind !== 4) fail("CURSOR_APP_EXEC_REJECTED");
            else cancellation.rejected = true;
            return;
          }
          pendingExec.completed = completeToolExecution(pendingExec.execution, message);
          if (pendingExec.execution.kind === "requestContext") run.requestContextResultCount++;
          else run.execResultCount++;
        } else if (message.event === "error") fail("CURSOR_AGENT_EXEC_THROWN");
        else if (message.event === "heartbeat") {
          if (pendingExec.closed) { fail("CURSOR_AGENT_EXEC_DUPLICATE"); return; }
          if (++pendingExec.heartbeats > 32) fail("CURSOR_AGENT_EXEC_HEARTBEAT_LIMIT");
        } else {
          if (pendingExec.closed) { fail("CURSOR_AGENT_EXEC_DUPLICATE"); return; }
          if (!pendingExec.completed && !cancellation?.rejected) { fail("CURSOR_AGENT_EXEC_RESULT_MISSING"); return; }
          pendingExec.closed = true;
          if (cancellation) cancellation.execClosed = true;
          else if (pendingExec.execution.kind === "requestContext") run.requestContextCloseCount++;
          else run.execCloseCount++;
        }
        return;
      }
      const reading = message.type === "kvGetResult";
      if (!reading && message.type !== "kvAck") { fail("CURSOR_AGENT_UNKNOWN_MESSAGE"); return; }
      if (acknowledged.has(message.id)) { fail(reading ? "CURSOR_AGENT_DUPLICATE_KV_READ" : "CURSOR_AGENT_DUPLICATE_ACK"); return; }
      if (!run || pendingKv?.id !== message.id) { fail(reading ? "CURSOR_AGENT_UNKNOWN_KV_READ" : "CURSOR_AGENT_UNKNOWN_ACK"); return; }
      if (pendingKv.type !== message.type) { fail("CURSOR_AGENT_KV_RESULT_MISMATCH"); return; }
      if (message.error !== undefined) { fail(reading ? "CURSOR_AGENT_KV_READ_REJECTED" : "CURSOR_AGENT_KV_REJECTED"); return; }
      if (reading) {
        if (!message.bytes?.length) { fail("CURSOR_AGENT_KV_READ_MISSING"); return; }
        if (!message.bytes.equals(pendingKv.bytes) || !createHash("sha256").update(message.bytes).digest().equals(pendingKv.blobId)) {
          fail("CURSOR_AGENT_KV_READ_MISMATCH"); return;
        }
        run.kvReadResultCount++;
      } else run.kvAckCount++;
      acknowledged.add(message.id);
      pendingKv = undefined;
    }
    // The official transport maps its string-valued abort reason to INTERNAL_ERROR.
    const isExpectedCancellation = () => cancellation && !settled && !closed
      && !streamSession.closed && !streamSession.destroyed
      && (stream.rstCode === http2Constants.NGHTTP2_CANCEL
        || stream.rstCode === http2Constants.NGHTTP2_INTERNAL_ERROR && cancellation.actionReceived
          && cancellation.rejected && cancellation.execClosed);
    function recordCancellationTransport(event) {
      if (!cancellation || cancellation.transportEvents.length >= 8) return;
      cancellation.transportEvents.push({ event, rstCode: Number.isInteger(stream.rstCode) ? stream.rstCode : null,
        streamClosed: stream.closed, streamDestroyed: stream.destroyed, sessionClosed: streamSession.closed,
        sessionDestroyed: streamSession.destroyed, serverClosed: closed });
    }
    stream.on("error", () => {
      recordCancellationTransport("error");
      if (!isExpectedCancellation()) fail("CURSOR_AGENT_STREAM_ERROR");
    });
    stream.once("aborted", () => {
      recordCancellationTransport("aborted");
      if (!isExpectedCancellation()) fail("CURSOR_AGENT_STREAM_ABORTED");
    });
    stream.once("close", () => {
      recordCancellationTransport("close");
      clearTimeout(timer);
      if (!isExpectedCancellation()) { fail("CURSOR_AGENT_STREAM_CLOSED"); return; }
      try { decoder.finish(); }
      catch (error) { fail(protocolErrorCodes.has(error.code) ? error.code : "CURSOR_AGENT_INVALID_MESSAGE"); return; }
      settled = true;
      run.cancelled = true;
      cancellation.transportClosed = true;
      cancellation.rstCode = stream.rstCode;
      delete run.pendingTool;
      activeConversations.delete(run.conversationId);
      cancellationArms.delete(run.requestId);
    });
    stream.on("data", (chunk) => {
      const completed = settled && run?.completed;
      if (settled && !completed) return;
      const reject = completed ? failAfterCompletion : fail;
      totalBytes += chunk.length;
      if (totalBytes > 4 * maxFrameBytes) { reject("CURSOR_AGENT_REQUEST_TOO_LARGE"); return; }
      try {
        for (const bytes of decoder.push(chunk)) {
          if (++messageCount > 128) { reject("CURSOR_AGENT_TOO_MANY_MESSAGES"); return; }
          if (completed) {
            const message = decodeAgentClientMessage(bytes, { requestId });
            if (message.type !== "heartbeat") {
              reject(message.type === "run" ? "CURSOR_AGENT_DUPLICATE_RUN" : "CURSOR_AGENT_MESSAGE_AFTER_COMPLETION");
              return;
            }
          } else {
            receive(bytes);
            if (settled) return;
          }
        }
        if (!completed) advance();
      } catch (error) {
        if (run && error.code === "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED") run.lastUnsupportedShape = error.wireShape;
        reject(protocolErrorCodes.has(error.code) ? error.code : "CURSOR_AGENT_INVALID_MESSAGE");
      }
    });
    stream.once("end", () => {
      if (settled && !run?.completed) return;
      try { decoder.finish(); }
      catch (error) {
        (settled ? failAfterCompletion : fail)(protocolErrorCodes.has(error.code) ? error.code : "CURSOR_AGENT_INVALID_MESSAGE");
        return;
      }
      if (settled) return;
      // The client can half-close its request before its CANCEL frame arrives.
      if (cancellation) return;
      fail(!run ? "CURSOR_AGENT_RUN_MISSING" : run.kvReadResultCount < kvReads.length
        ? "CURSOR_AGENT_KV_READ_MISSING" : pendingExec ? "CURSOR_AGENT_EXEC_INCOMPLETE" : "CURSOR_AGENT_ACK_MISSING");
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
    cancellationArms.clear();
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
    return { url: `http://localhost:${port}`, requests, runs, errors, connectionErrors, unknownRpcMethods, armCancellation, close,
      get firstShellFailure() { return firstShellFailure; },
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
