import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRELUDE_PATH = path.resolve(__dirname, "..", "jsx", "prelude.jsx");

const DEFAULT_TIMEOUT_MS = Number(process.env.AE_TIMEOUT_MS ?? 60_000);
const POLL_INTERVAL_MS = 100;

let preludeCache: string | undefined;
async function loadPrelude(): Promise<string> {
  const text = preludeCache ?? (await readFile(PRELUDE_PATH, "utf8"));
  preludeCache = text;
  return text;
}

/** Serialize a value as an ASCII-only JS literal (safe for ExtendScript). */
function lit(v: unknown): string {
  const json = JSON.stringify(v === undefined ? null : v);
  return json.replace(
    /[\u007f-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Find the newest installed After Effects (macOS app name or Windows AfterFX.exe path). */
async function detectTarget(): Promise<string> {
  if (process.platform === "darwin") {
    if (process.env.AE_APP_NAME) return process.env.AE_APP_NAME;
    const entries = await readdir("/Applications").catch(() => [] as string[]);
    const candidates = entries
      .filter((e) => e.startsWith("Adobe After Effects") && !/beta/i.test(e))
      .sort();
    if (candidates.length === 0) {
      throw new Error(
        "After Effects was not found in /Applications. Set AE_APP_NAME (e.g. 'Adobe After Effects 2026').",
      );
    }
    return candidates[candidates.length - 1];
  }
  if (process.platform === "win32") {
    if (process.env.AE_PATH) return process.env.AE_PATH;
    const base = "C:\\Program Files\\Adobe";
    const entries = await readdir(base).catch(() => [] as string[]);
    const candidates = entries
      .filter((e) => e.startsWith("Adobe After Effects") && !/beta/i.test(e))
      .sort();
    for (let i = candidates.length - 1; i >= 0; i--) {
      const exe = path.join(base, candidates[i], "Support Files", "AfterFX.exe");
      if (await exists(exe)) return exe;
    }
    throw new Error("AfterFX.exe was not found. Set AE_PATH to the full path of AfterFX.exe.");
  }
  throw new Error("After Effects is only supported on macOS and Windows.");
}

export interface RunOptions {
  timeoutMs?: number;
  /** Wrap the script in an undo group with this name. Default: no undo group. */
  undoName?: string;
}

export interface AeResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  line?: number;
}

// After Effects can only run one script at a time; queue calls.
let queue: Promise<unknown> = Promise.resolve();

export function runJsx(code: string, args: unknown = {}, opts: RunOptions = {}): Promise<unknown> {
  const task = queue.then(() => runJsxNow(code, args, opts));
  queue = task.catch(() => undefined);
  return task;
}

async function runJsxNow(code: string, args: unknown, opts: RunOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prelude = await loadPrelude();
  const target = await detectTarget();
  const dir = await mkdtemp(path.join(tmpdir(), "ae-mcp-"));
  const scriptPath = path.join(dir, "script.jsx");
  const resultPath = path.join(dir, "result.json");

  const script = `${prelude}
var __resultPath = ${lit(resultPath.replace(/\\/g, "/"))};
var __args = ${lit(args)};
(function () {
    var __out;
    var __undo = ${lit(opts.undoName ?? null)};
    try {
        if (__undo) app.beginUndoGroup(__undo);
        var __r = (function (args) {
${code}
        })(__args);
        __out = { ok: true, result: __r };
    } catch (e) {
        __out = { ok: false, error: String(e), line: e.line };
    }
    try { if (__undo) app.endUndoGroup(); } catch (e2) {}
    var f = new File(__resultPath);
    f.encoding = "UTF-8";
    f.open("w");
    f.write(__ser(__out));
    f.close();
})();
`;
  await writeFile(scriptPath, script, "utf8");

  try {
    let execError: Error | undefined;
    let child;
    if (process.platform === "darwin") {
      if (scriptPath.includes("'") || scriptPath.includes('"') || scriptPath.includes("\\")) {
        throw new Error("Temporary path contains unsupported characters: " + scriptPath);
      }
      const appleScript = `tell application "${target}" to DoScript "$.evalFile('${scriptPath}')"`;
      child = execFile("osascript", ["-e", appleScript], { timeout: timeoutMs + 5000 }, (err, _o, stderr) => {
        if (err) execError = new Error(stderr?.trim() || err.message);
      });
    } else {
      child = execFile(target, ["-r", scriptPath], { timeout: timeoutMs + 5000 }, (err, _o, stderr) => {
        if (err) execError = new Error(stderr?.trim() || err.message);
      });
    }
    void child;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await exists(resultPath)) {
        try {
          const text = await readFile(resultPath, "utf8");
          const res = JSON.parse(text) as AeResponse;
          if (!res.ok) {
            throw new Error(`ExtendScript error: ${res.error}${res.line ? ` (line ${res.line})` : ""}`);
          }
          return res.result;
        } catch (e) {
          // File may be partially written; retry on JSON parse errors only.
          if (!(e instanceof SyntaxError)) throw e;
        }
      }
      if (execError) throw execError;
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    throw new Error(
      `Timed out after ${timeoutMs} ms waiting for After Effects. ` +
        "Make sure After Effects is running, no modal dialog is open, and " +
        "Settings > Scripting & Expressions > 'Allow Scripts to Write Files and Access Network' is enabled.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
