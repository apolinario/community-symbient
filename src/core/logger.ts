/**
 * Lightweight structured logger.
 * Replaces direct console.log calls with tagged, level-aware logging.
 */

// Dashboard hook — set by dashboard/server.ts
let logSink: ((line: string) => void) | null = null;
export function setLogSink(sink: (line: string) => void): void {
  logSink = sink;
}

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[minLevel];
}

function formatMessage(tag: string, level: LogLevel, msg: string): string {
  const ts = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${ts} [${tag}] ${level === "info" ? "" : level.toUpperCase() + " "}${msg}`;
}

export function createLogger(tag: string) {
  function emit(level: LogLevel, msg: string) {
    const formatted = formatMessage(tag, level, msg);
    logSink?.(formatted);
  }
  return {
    debug(msg: string) {
      if (shouldLog("debug")) { console.debug(formatMessage(tag, "debug", msg)); emit("debug", msg); }
    },
    info(msg: string) {
      if (shouldLog("info")) { console.log(formatMessage(tag, "info", msg)); emit("info", msg); }
    },
    warn(msg: string) {
      if (shouldLog("warn")) { console.warn(formatMessage(tag, "warn", msg)); emit("warn", msg); }
    },
    error(msg: string) {
      if (shouldLog("error")) { console.error(formatMessage(tag, "error", msg)); emit("error", msg); }
    },
  };
}
