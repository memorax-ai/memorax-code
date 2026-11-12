import { isDeepStrictEqual } from "node:util";
import { check, fixtureModel, waitFor } from "./claude-native-support.mjs";

export function permissionArguments({ allowedTool } = {}) {
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--model", fixtureModel, "--permission-mode", "default", "--permission-prompt-tool", "stdio",
    "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    ...(allowedTool ? ["--allowedTools", allowedTool] : [])];
}

export function inflightScript({ startedPath, markerPath, marker }, platform = process.platform) {
  // Keep Windows path separators out of JavaScript escapes in the Bash command.
  if (platform === "win32") {
    startedPath = startedPath.replaceAll("\\", "/");
    markerPath = markerPath.replaceAll("\\", "/");
  }
  return `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(`${startedPath}.tmp`)},JSON.stringify({pid:process.pid,marker:${JSON.stringify(marker)}}));fs.renameSync(${JSON.stringify(`${startedPath}.tmp`)},${JSON.stringify(startedPath)});setTimeout(()=>fs.writeFileSync(${JSON.stringify(markerPath)},${JSON.stringify(marker)}),60000);`;
}

export function summarizePermissionToolResult(result) {
  const content = result?.content;
  const supported = typeof content === "string" || (Array.isArray(content)
    && content.every((part) => part?.type === "text" && typeof part.text === "string"));
  const text = supported ? textContent(content) : "";
  const exit = text.match(/^Exit code (0|[1-9]\d{0,2})(?:\r?\n|$)/);
  const signatures = [
    ["syntax_error", /\bSyntaxError:/],
    ["reference_error", /\bReferenceError:/],
    ["invalid_unicode_escape", /Invalid Unicode escape sequence/],
    ["invalid_token", /Invalid or unexpected token/],
    ["enoent", /\bENOENT\b/],
    ["eacces", /\bEACCES\b/],
    ["eperm", /\bEPERM\b/],
    ["command_not_found", /: command not found(?:\r?\n|$)/],
    ["shell_syntax_error", /syntax error near unexpected token/],
    ["tool_use_error", /<tool_use_error>/],
    ["timeout", /\b(?:timed out|ETIMEDOUT)\b/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  return { isError: typeof result?.is_error === "boolean" ? result.is_error : null,
    contentSupported: supported, textBytes: Buffer.byteLength(text),
    exitCode: exit && Number(exit[1]) <= 255 ? Number(exit[1]) : null,
    signatures };
}

// The official Agent SDK uses this same CLI wire protocol. No SDK hooks, tools,
// transcript substitutions, or permission callbacks execute the fixture tool.
export class ClaudeControlSession {
  constructor(child, { outputLimit = 16 * 1024 * 1024, requestTimeout = 30_000 } = {}) {
    this.child = child;
    this.events = [];
    this.pending = new Map();
    this.permissions = new Map();
    this.nextId = 0;
    this.failure = undefined;
    this.ended = false;
    this.inputEnded = false;
    this.requestTimeout = requestTimeout;
    let buffer = "";
    const sizes = { stdout: 0, stderr: 0 };
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8");
      child[name].on("data", (text) => {
        sizes[name] += Buffer.byteLength(text);
        if (sizes[name] > outputLimit) return this.fail("CLAUDE_CONTROL_OUTPUT_LIMIT");
        if (name === "stderr" || this.failure) return;
        buffer += text;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line) this.accept(line);
        }
      });
    }
    child.stdout.on("end", () => { if (buffer.trim()) this.fail("CLAUDE_CONTROL_TRUNCATED_JSON"); });
    child.stdin.on("error", () => this.fail("CLAUDE_CONTROL_INPUT_FAILED"));
    child.on("error", () => this.fail("CLAUDE_CONTROL_SPAWN_FAILED"));
    child.once("close", (code, signal) => {
      this.ended = true;
      this.exitCode = code;
      this.signal = signal;
      if (this.pending.size) this.fail("CLAUDE_CONTROL_EXITED_DURING_REQUEST");
    });
  }
  fail(code) {
    this.failure ??= code;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(this.failure), { nativeCode: this.failure }));
    }
    this.pending.clear();
  }
  accept(line) {
    try {
      const event = JSON.parse(line);
      check(event && typeof event === "object" && !Array.isArray(event) && typeof event.type === "string",
        "CLAUDE_CONTROL_INVALID_EVENT");
      check(this.events.length < 20_000, "CLAUDE_CONTROL_EVENT_LIMIT");
      this.events.push(event);
      if (event.type === "control_response") {
        const response = event.response;
        const pending = this.pending.get(response?.request_id);
        check(pending, "CLAUDE_CONTROL_RESPONSE_ID_MISMATCH");
        check(response.subtype === "success" || response.subtype === "error", "CLAUDE_CONTROL_RESPONSE_INVALID");
        clearTimeout(pending.timer);
        this.pending.delete(response.request_id);
        if (response.subtype === "error") pending.reject(Object.assign(new Error("CLAUDE_CONTROL_REQUEST_REJECTED"),
          { nativeCode: "CLAUDE_CONTROL_REQUEST_REJECTED" }));
        else pending.resolve(response.response);
      } else if (event.type === "control_request") {
        check(typeof event.request_id === "string" && event.request_id.length > 0
          && !this.permissions.has(event.request_id), "CLAUDE_CONTROL_REQUEST_ID_INVALID");
        check(event.request?.subtype === "can_use_tool" && typeof event.request.tool_use_id === "string"
          && event.request.tool_use_id.length > 0 && typeof event.request.tool_name === "string"
          && event.request.input && typeof event.request.input === "object" && !Array.isArray(event.request.input),
        "CLAUDE_CONTROL_PERMISSION_INVALID");
        this.permissions.set(event.request_id, { event, status: "pending" });
      } else if (event.type === "control_cancel_request") {
        const permission = this.permissions.get(event.request_id);
        check(permission && permission.status === "pending", "CLAUDE_CONTROL_CANCEL_ID_MISMATCH");
        permission.status = "canceled";
      }
    } catch (error) { this.fail(error.nativeCode ?? "CLAUDE_CONTROL_INVALID_JSON"); }
  }
  send(value) {
    check(!this.failure, this.failure);
    check(!this.ended && !this.inputEnded, "CLAUDE_CONTROL_IS_CLOSED");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  request(request) {
    check(!this.failure, this.failure);
    check(!this.ended && !this.inputEnded, "CLAUDE_CONTROL_IS_CLOSED");
    const requestId = `native-control-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("CLAUDE_CONTROL_REQUEST_TIMEOUT"), this.requestTimeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "control_request", request_id: requestId, request });
    });
  }
  respond(event, response) {
    const permission = this.permissions.get(event.request_id);
    check(permission?.event === event && permission.status === "pending", "CLAUDE_CONTROL_PERMISSION_NOT_PENDING");
    this.send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } });
    permission.status = "responded";
  }
  prompt(content) {
    this.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" });
  }
  wait(predicate, after = 0) {
    return waitFor(() => {
      check(!this.failure, this.failure);
      const event = this.events.slice(after).find(predicate);
      check(event || !this.ended, "CLAUDE_CONTROL_EXITED_BEFORE_EVENT");
      return event;
    }, "CLAUDE_CONTROL_EVENT_TIMEOUT", 45_000);
  }
  endInput() {
    if (!this.inputEnded) { this.inputEnded = true; this.child.stdin.end(); }
  }
  async finish() {
    this.endInput();
    await waitFor(() => this.ended, "CLAUDE_CONTROL_EXIT_TIMEOUT", 15_000);
    check(!this.failure, this.failure);
    check(this.exitCode === 0 && !this.signal, "CLAUDE_CONTROL_PROCESS_FAILED");
  }
}

export function selectInterruptedTurn(records, { sessionId, interruptionUuid, prompt, toolCall }) {
  check(Array.isArray(records) && typeof sessionId === "string" && sessionId.length > 0
    && typeof interruptionUuid === "string" && interruptionUuid.length > 0, "CLAUDE_INTERRUPT_IDENTITY_INVALID");
  const nodes = records.filter((record) => ["user", "assistant", "attachment"].includes(record?.type));
  const byUuid = new Map();
  for (const node of nodes) {
    check(node.sessionId === sessionId && typeof node.uuid === "string" && node.uuid.length > 0
      && !byUuid.has(node.uuid), "CLAUDE_INTERRUPT_TRANSCRIPT_IDENTITY_INVALID");
    byUuid.set(node.uuid, node);
  }
  const marker = byUuid.get(interruptionUuid);
  check(marker?.type === "user" && marker.message?.role === "user"
    && textContent(marker.message.content) === "[Request interrupted by user for tool use]",
  "CLAUDE_INTERRUPT_NATIVE_MARKER_MISSING");
  const lineage = [], visited = new Set();
  let current = marker, user;
  while (current) {
    check(!visited.has(current.uuid) && current.isSidechain !== true, "CLAUDE_INTERRUPT_LINEAGE_INVALID");
    visited.add(current.uuid);
    lineage.push(current);
    if (current !== marker && current.type === "user" && current.isMeta !== true && current.message?.role === "user"
      && !(Array.isArray(current.message.content) && current.message.content.some((part) => part?.type === "tool_result"))) {
      user = current;
      break;
    }
    check(typeof current.parentUuid === "string" && byUuid.has(current.parentUuid), "CLAUDE_INTERRUPT_PARENT_MISSING");
    current = byUuid.get(current.parentUuid);
  }
  check(user?.userType === "external" && user.isMeta !== true && typeof user.promptId === "string"
    && user.promptId.length > 0 && !user.interruptedMessageId && !user.interrupted_message_id
    && user.origin?.kind !== "task-notification" && user.promptSource !== "system" && user.isCompactSummary !== true
    && user.isVisibleInTranscriptOnly !== true && textContent(user.message.content) === prompt,
  "CLAUDE_INTERRUPT_PROMPT_MISSING");
  check(marker.promptId === user.promptId, "CLAUDE_INTERRUPT_PROMPT_ID_MISMATCH");
  check(!lineage.some((record) => record.type === "assistant" && record.message?.stop_reason === "end_turn"),
    "CLAUDE_INTERRUPT_COMPLETED_ANCESTOR");
  const parts = lineage.flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : []);
  const calls = parts.filter((part) => part.type === "tool_use" && part.id === toolCall.id);
  const results = parts.filter((part) => part.type === "tool_result" && part.tool_use_id === toolCall.id);
  check(calls.length === 1 && calls[0].name === toolCall.name && isDeepStrictEqual(calls[0].input, toolCall.input),
    "CLAUDE_INTERRUPT_TOOL_MISMATCH");
  check(results.length === 1 && results[0].is_error === true, "CLAUDE_INTERRUPT_TOOL_RESULT_MISSING");
  return { promptId: user.promptId, lineage,
    hasInterruptedMessageId: Boolean(marker.interruptedMessageId ?? marker.interrupted_message_id) };
}

export function textContent(content) {
  return typeof content === "string" ? content : (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n\n");
}
