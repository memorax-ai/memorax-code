const CLIENT_ENV = "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT";
const SESSION_ENV = "MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID";
const HOME_ENV = "MEMORAX_CODE_HOME";

// Rewrite only statically identifiable command positions. Quoted prose, comments,
// substitutions, and shell programs passed as arguments are not CLI invocations.
export function withMemoryCliSession(command, sessionId, memoraxCodeHome) {
  if (typeof command !== "string" || typeof sessionId !== "string" || !sessionId.trim()
    || sessionId.includes("\0") || typeof memoraxCodeHome !== "string"
    || !memoraxCodeHome.trim() || memoraxCodeHome.includes("\0")) return command;
  const tokens = shellTokens(command);
  if (!tokens) return command;
  const insertions = [];
  let segment = [];
  const visit = () => {
    const position = cliPosition(segment);
    if (!position) return;
    const assignments = Object.fromEntries(segment.slice(position.assignmentStart, position.assignmentEnd)
      .filter((token) => token.literal && assignment(token))
      .map((token) => { const equal = token.value.indexOf("="); return [token.value.slice(0, equal), token.value.slice(equal + 1)]; }));
    if (assignments[CLIENT_ENV] === "qoder" && assignments[SESSION_ENV] === sessionId
      && assignments[HOME_ENV] === memoraxCodeHome) return;
    insertions.push(segment[position.insertAt].start);
  };
  for (const token of tokens) {
    if (token.separator) { visit(); segment = []; }
    else segment.push(token);
  }
  visit();
  const context = `${HOME_ENV}=${shellQuote(memoraxCodeHome)} ${CLIENT_ENV}='qoder' ${SESSION_ENV}=${shellQuote(sessionId)} `;
  return insertions.reverse().reduce((value, index) => value.slice(0, index) + context + value.slice(index), command);
}

function cliPosition(tokens) {
  let index = 0;
  let assignmentStart = 0;
  while (assignment(tokens[index])) index += 1;
  let insertAt = index;
  if (tokens[index]?.literal && basename(tokens[index].value) === "env") {
    index += 1;
    while (["-i", "--ignore-environment", "--"].includes(tokens[index]?.value)) index += 1;
    assignmentStart = index;
    while (assignment(tokens[index])) index += 1;
    insertAt = index;
  } else if (tokens[index]?.literal && tokens[index].value === "command") {
    index += 1;
    if (tokens[index]?.value === "--") index += 1;
  }
  const executable = tokens[index];
  if (!executable?.literal || executable.operator) return undefined;
  const name = basename(executable.value);
  const direct = ["memorax-cli", "memorax-cli.cmd", "memorax-cli.mjs"].includes(name);
  let script = index + 1;
  if (tokens[script]?.value === "--") script += 1;
  const node = ["node", "node.exe"].includes(name) && tokens[script]?.literal
    && basename(tokens[script].value) === "memorax-cli.mjs";
  return direct || node ? { insertAt, assignmentStart, assignmentEnd: insertAt } : undefined;
}

function assignment(token) {
  return token && !token.operator && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value);
}

function basename(value) {
  return value.split("/").at(-1);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function shellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    if (/[ \t\r]/.test(command[index])) { index += 1; continue; }
    if (command[index] === "#") {
      while (index < command.length && command[index] !== "\n") index += 1;
      continue;
    }
    if (";|&\n".includes(command[index])) {
      tokens.push({ separator: true }); index += 1; continue;
    }
    if ("(){}".includes(command[index]) || command.startsWith("<<", index)) return undefined;
    if ("<>".includes(command[index])) {
      tokens.push({ operator: true, start: index, value: command[index], literal: true });
      index += 1; continue;
    }
    const start = index;
    let value = "";
    let quote;
    let literal = true;
    while (index < command.length) {
      const char = command[index];
      if (quote === "'") {
        if (char === "'") quote = undefined;
        else value += char;
        index += 1; continue;
      }
      if (char === "`" || command.startsWith("$(", index)) return undefined;
      if (char === "\\") {
        if (index + 1 >= command.length) return undefined;
        const next = command[index + 1];
        if (next !== "\n") value += quote === '"' && !"$`\"\\".includes(next) ? `\\${next}` : next;
        index += 2; continue;
      }
      if (quote === '"') {
        if (char === '"') quote = undefined;
        else { if (char === "$") literal = false; value += char; }
        index += 1; continue;
      }
      if (char === "'" || char === '"') { quote = char; index += 1; continue; }
      if (/\s/.test(char) || ";|&<>(){}".includes(char)) break;
      if (char === "$") literal = false;
      value += char; index += 1;
    }
    if (quote || index === start) return undefined;
    tokens.push({ start, value, literal });
  }
  return tokens;
}
