import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fchmodSync,
  fchownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const CONFIG_UPDATE_WARNING = "MemoraX Code config could not be safely updated or verified; existing config was preserved.";

const defaultOperations = {
  accessSync,
  chmodSync,
  closeSync,
  copyFileSync,
  fchmodSync,
  fchownSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

export function updateConfigFileAtomically({
  path,
  defaultText,
  transform,
  parseToml,
  warn = console.warn,
  onFailure,
  operations = {},
  platform = process.platform,
}) {
  const fs = { ...defaultOperations, ...operations };
  let existingStat;
  try {
    existingStat = fs.lstatSync(path);
    if (!existingStat.isFile()) return failed(warn, onFailure, "read", undefined, { recordReason: "not_regular_file" });
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") return failed(warn, onFailure, "read", error);
  }

  let existingText;
  if (existingStat) {
    try {
      existingText = fs.readFileSync(path, "utf8");
    } catch (error) {
      return failed(warn, onFailure, "read", error);
    }
  }

  let candidate;
  let unchanged = false;
  let stage = "parse_existing";
  try {
    if (existingText === undefined) {
      candidate = defaultText;
    } else {
      const parsed = parseToml(existingText);
      stage = "transform";
      candidate = transform(existingText, parsed);
      unchanged = candidate === existingText;
    }
    stage = "parse_candidate";
    if (!unchanged) parseToml(candidate);
  } catch (error) {
    return failed(warn, onFailure, stage, error, stage.startsWith("parse_") ? { recordReason: "invalid_toml" } : {});
  }

  try {
    ensurePrivateConfigDirectoryWithOperations(fs, path, platform);
  } catch (error) {
    return failed(warn, onFailure, "prepare_directory", error);
  }
  if (unchanged) return "unchanged";
  if (existingText !== undefined) {
    try {
      fs.accessSync(path, constants.W_OK);
    } catch (error) {
      return failed(warn, onFailure, "check_permissions", error);
    }
  }

  const uniqueSuffix = `${process.pid}.${randomUUID()}`;
  const tempPath = join(dirname(path), `.${basename(path)}.${uniqueSuffix}.tmp`);
  const backupPath = existingStat
    ? join(dirname(path), `.${basename(path)}.${uniqueSuffix}.bak`)
    : undefined;
  let fd;
  let backupCreated = false;
  let renamed = false;
  stage = "write_temp";
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, candidate, "utf8");
    if (existingStat && platform !== "win32") {
      fs.fchownSync(fd, existingStat.uid, existingStat.gid);
      fs.fchmodSync(fd, existingStat.mode & 0o7777);
    } else if (!existingStat && platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
    }
    fs.closeSync(fd);
    fd = undefined;
    if (backupPath) {
      stage = "backup";
      if (platform === "win32") {
        fs.copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
      } else {
        fs.linkSync(path, backupPath);
      }
      backupCreated = true;
    }
    stage = "publish";
    fs.renameSync(tempPath, path);
    renamed = true;
  } catch (error) {
    let cleanupError;
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (failure) {
        cleanupError ??= failure;
        // Best effort: unlinking an open temporary file is safe on supported Unix hosts.
      }
    }
    if (!renamed) {
      try {
        fs.unlinkSync(tempPath);
      } catch (failure) {
        if (failure?.code !== "ENOENT") cleanupError ??= failure;
        // The temporary file may not have been created or may already have been renamed.
      }
    }
    if (backupCreated && backupPath) {
      try {
        fs.unlinkSync(backupPath);
      } catch (failure) {
        if (failure?.code !== "ENOENT") cleanupError ??= failure;
        // The original target is still authoritative when rename has not completed.
      }
    }
    return failed(warn, onFailure, stage, error, cleanupFields(cleanupError));
  }

  stage = "verify";
  let recordReason;
  try {
    const verifiedText = fs.readFileSync(path, "utf8");
    if (verifiedText !== candidate) {
      recordReason = "content_mismatch";
      throw new Error("config verification failed");
    }
    recordReason = "invalid_toml";
    parseToml(verifiedText);
    recordReason = undefined;
    const verifiedStat = fs.lstatSync(path);
    if (!verifiedStat.isFile()) {
      recordReason = "type_mismatch";
      throw new Error("config type verification failed");
    }
    if (platform !== "win32") {
      const expectedMode = existingStat ? existingStat.mode & 0o7777 : 0o600;
      if ((verifiedStat.mode & 0o7777) !== expectedMode) {
        recordReason = "mode_mismatch";
        throw new Error("config mode verification failed");
      }
      if (existingStat && (verifiedStat.uid !== existingStat.uid || verifiedStat.gid !== existingStat.gid)) {
        recordReason = "owner_mismatch";
        throw new Error("config owner verification failed");
      }
    }
    if (backupCreated && backupPath) {
      stage = "cleanup";
      fs.unlinkSync(backupPath);
      backupCreated = false;
    }
  } catch (error) {
    let configState = "unknown";
    let cleanupError;
    let cleanupErrorCode = "CONFIG_ROLLBACK_FAILED";
    if (existingStat && backupCreated && backupPath) {
      if (platform === "win32") {
        const restorePath = join(dirname(path), `.${basename(path)}.${uniqueSuffix}.restore.tmp`);
        let restoreCopied = false;
        try {
          fs.copyFileSync(backupPath, restorePath, constants.COPYFILE_EXCL);
          restoreCopied = true;
          fs.renameSync(restorePath, path);
          restoreCopied = false;
          configState = "restored";
          cleanupErrorCode = "CONFIG_CLEANUP_FAILED";
          fs.unlinkSync(backupPath);
          backupCreated = false;
        } catch (failure) {
          cleanupError = failure;
          if (restoreCopied) {
            try {
              fs.unlinkSync(restorePath);
            } catch {
              // Keep the original backup for operator recovery.
            }
          }
        }
      } else {
        try {
          fs.renameSync(backupPath, path);
          backupCreated = false;
          configState = "restored";
        } catch (failure) {
          cleanupError = failure;
          // Keep the hard-link backup for operator recovery if atomic restore itself fails.
        }
      }
    } else if (!existingStat) {
      try {
        fs.unlinkSync(path);
        configState = "removed";
      } catch (failure) {
        if (failure?.code === "ENOENT") configState = "removed";
        else cleanupError = failure;
        // Best effort: the new target may already be absent.
      }
    }
    return failed(warn, onFailure, stage, error, {
      configState,
      ...(recordReason ? { recordReason } : {}),
      ...cleanupFields(cleanupError, cleanupErrorCode),
    });
  }
  return existingText === undefined ? "created" : "updated";
}

export function ensurePrivateConfigDirectory(
  path,
  { operations = {}, platform = process.platform } = {},
) {
  const fs = { ...defaultOperations, ...operations };
  ensurePrivateConfigDirectoryWithOperations(fs, path, platform);
}

export function setTomlField(text, section, key, renderedValue) {
  const source = String(text ?? "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const escapedSection = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[(?:${escapedSection}|"${escapedSection}"|'${escapedSection}')\\]\\s*(?:#.*)?$`);
  const assignment = new RegExp(`^(\\s*(?:${escapedKey}|"${escapedKey}"|'${escapedKey}')\\s*=\\s*)`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    if (renderedValue === undefined) return source;
    const separator = source.length === 0
      ? ""
      : source.endsWith(`${newline}${newline}`)
        ? ""
        : source.endsWith(newline)
          ? newline
          : `${newline}${newline}`;
    return `${source}${separator}[${section}]${newline}${key} = ${renderedValue}${newline}`;
  }
  const nextHeader = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const end = nextHeader === -1 ? lines.length : nextHeader;
  const field = lines.findIndex((line, index) => index > start && index < end && assignment.test(line));
  if (field !== -1) {
    if (renderedValue === undefined) {
      lines.splice(field, 1);
    } else {
      const prefix = lines[field].match(assignment)?.[1] ?? `${key} = `;
      const comment = tomlInlineComment(lines[field].slice(prefix.length));
      lines[field] = `${prefix}${renderedValue}${comment}`;
    }
  } else if (renderedValue !== undefined) {
    lines.splice(start + 1, 0, `${key} = ${renderedValue}`);
  }
  return lines.join(newline);
}

function ensurePrivateConfigDirectoryWithOperations(fs, path, platform) {
  const directoryPath = dirname(path);
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  if (platform !== "win32") fs.chmodSync(directoryPath, 0o700);
}

function failed(warn, onFailure, stage, error, details = {}) {
  const systemCode = safeSystemCode(error);
  const fields = {
    stage,
    errorCode: `CONFIG_${stage.toUpperCase()}_FAILED`,
    configState: "preserved",
    ...(systemCode ? { systemCode } : {}),
    ...details,
  };
  // Reporting is observational and must never change the update result.
  try { onFailure?.(fields); } catch { /* Preserve the configuration failure. */ }
  warn(CONFIG_UPDATE_WARNING);
  return "failed";
}

function cleanupFields(error, cleanupErrorCode = "CONFIG_CLEANUP_FAILED") {
  if (error === undefined) return {};
  const cleanupSystemCode = safeSystemCode(error);
  return { cleanupErrorCode, ...(cleanupSystemCode ? { cleanupSystemCode } : {}) };
}

function safeSystemCode(error) {
  const allowed = ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EDQUOT", "EROFS", "EMFILE", "ENFILE", "EBUSY", "EEXIST", "EIO", "EINVAL", "ENAMETOOLONG", "ELOOP"];
  return allowed.includes(error?.code) ? error.code : undefined;
}

function tomlInlineComment(value) {
  let quote;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") {
      let commentStart = index;
      while (commentStart > 0 && /[ \t]/.test(value[commentStart - 1])) commentStart -= 1;
      return value.slice(commentStart);
    }
  }
  return "";
}

function isNodeError(error) {
  return error instanceof Error;
}
