#!/usr/bin/env node
// Factory Guild contribution CLI. Zero dependencies, Node 18+.
// Talks to the same JSON API the factory.com/guild web app uses.

import { execFileSync } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";

const BASE = (process.env.FACTORY_GUILD_URL || "https://factory.com/guild").replace(/\/+$/, "");
const ORIGIN = new URL(BASE).origin;
const COOKIE_NAME = "__Secure-guild_session";
const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "factory-guild");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");
const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;
const AUTH_HINT = "Run: guild auth import (macOS Chromium browsers) or guild auth set";

// Chromium browsers: macOS profile root under Application Support, Linux
// profile root under ~/.config. `linuxDir` is the Linux config directory name;
// a browser without one is skipped on Linux (Arc has no Linux build).
const BROWSERS = [
  { id: "chrome", name: "Chrome", dir: "Google/Chrome", linuxDir: "google-chrome", service: "Chrome Safe Storage", account: "Chrome" },
  { id: "brave", name: "Brave", dir: "BraveSoftware/Brave-Browser", linuxDir: "BraveSoftware/Brave-Browser", service: "Brave Safe Storage", account: "Brave" },
  { id: "edge", name: "Edge", dir: "Microsoft Edge", linuxDir: "microsoft-edge", service: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
  { id: "arc", name: "Arc", dir: "Arc/User Data", linuxDir: null, service: "Arc Safe Storage", account: "Arc" },
  { id: "chromium", name: "Chromium", dir: "Chromium", linuxDir: "chromium", service: "Chromium Safe Storage", account: "Chromium" },
];

const MANUAL_TYPES = ["text_post", "blog", "video", "project_public", "project_private"];
const NEEDS_LINK = new Set(["text_post", "blog", "video", "project_public"]);
const NEEDS_DESCRIPTION = new Set(["project_private"]);
const MAX_TITLE = 120;
const MAX_DESCRIPTION = 2000;
const MAX_LINKS = 5;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FILE_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif",
  webp: "image/webp", gif: "image/gif", pdf: "application/pdf",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

const ERRORS = {
  invalid_title: `Title is required (max ${MAX_TITLE} characters).`,
  invalid_link: "Links must be valid and start with https://.",
  invalid_description: `Description must be under ${MAX_DESCRIPTION} characters.`,
  invalid_activity: "Invalid contribution type.",
  description_required: "This contribution type needs a description so reviewers can assess it.",
  too_many_pending: "Too many contributions in review. Wait for some to be reviewed.",
  duplicate_submission: "You already logged this contribution.",
  duplicate_link: "The same link was given twice.",
  invalid_items: "Provide between one and five links.",
  invalid_file: "The attached file was rejected.",
  forbidden: "Request blocked by the server.",
  rate_limited: "Rate limited. Wait a few minutes and retry.",
  not_found: "Not found (already withdrawn, reviewed, or never existed).",
  unavailable: "The Guild is unavailable right now. Try again shortly.",
};

class CliError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

const HELP = `factory-guild: log Factory Guild contributions from the command line

Usage:
  guild auth import [--browser <id>]
                               macOS: copy your signed-in session from Chrome, Brave, Edge, Arc, or
                               Chromium (ids: ${BROWSERS.map((b) => b.id).join(", ")}). macOS may ask for
                               Keychain access.
                               Linux: copy your signed-in session from Chrome, Brave, Edge, or
                               Chromium under ~/.config. It tries secret-tool for the browser
                               keyring password first, then the fixed "peanuts" fallback Chrome
                               uses without a keyring.
  guild auth set [token]       Save your session (token, "name=value", or a full Cookie header).
                               Reads stdin or prompts when no token is given.
  guild auth status            Check that the saved session is still valid
  guild auth logout            Delete the saved session
  guild submit <link>... [options]
  guild withdraw <id>          Withdraw a contribution that is still in review
  guild withdraw --group <id>  Withdraw a multi-link contribution (the group id printed by submit)

submit options:
  -t, --title <text>           Title (required, max ${MAX_TITLE} chars)
  -d, --description <text>     Description (max ${MAX_DESCRIPTION} chars; required for project_private)
      --type <type>            ${MANUAL_TYPES.join(" | ")}
                               Default: the server's suggestion, else left for reviewers to choose
  -f, --file <path>            Attach an image, PDF, or video (max 50 MB). A file can replace the link.
      --dry-run                Validate and classify, but do not submit
      --json                   Print machine-readable JSON

Auth:
  Set up once. The session is saved to ${AUTH_FILE} and renewed automatically
  each time you use the CLI, so it stays valid while you keep using it.
  Without 'auth import', copy the value of the "${COOKIE_NAME}" cookie on factory.com
  (browser devtools > Application > Cookies > https://factory.com, path /guild)
  and run 'guild auth set'.
  FACTORY_GUILD_SESSION overrides the saved session (it is never renewed or saved).
`;

function parseArgs(argv, spec) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith("-") || a === "-") { out._.push(a); continue; }
    const [flag, inline] = a.startsWith("--") ? a.split(/=(.*)/s, 2) : [a, undefined];
    const def = spec[flag];
    if (!def) throw new CliError(`Unknown option: ${flag}`, 2);
    if (def.bool) { out[def.key] = true; continue; }
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined) throw new CliError(`Option ${flag} needs a value`, 2);
    out[def.key] = value;
  }
  return out;
}

function normalizeToken(input) {
  const raw = input.trim().replace(/^cookie:\s*/i, "");
  if (!raw) throw new CliError("Empty token.", 2);
  if (!raw.includes("=")) return raw;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0 && part.slice(0, idx).trim() === COOKIE_NAME) return part.slice(idx + 1).trim();
  }
  throw new CliError(`No "${COOKIE_NAME}" cookie found in the value you provided.`, 2);
}

function loadAuth() {
  if (!existsSync(AUTH_FILE)) throw new CliError(`Not signed in. ${AUTH_HINT}`, 3);
  let auth;
  try { auth = JSON.parse(readFileSync(AUTH_FILE, "utf8")); } catch { auth = null; }
  if (!auth || !auth.token) throw new CliError(`Saved auth file is invalid. ${AUTH_HINT}`, 3);
  return auth;
}

function saveAuth(auth) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(auth) + "\n", { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
}

// The server re-issues the session cookie with a fresh expiry on page loads.
// Keeping it in sync means a one-time setup keeps working while the CLI is used.
async function refreshSession(token) {
  try {
    const res = await fetch(`${BASE}/submissions`, {
      headers: { Cookie: `${COOKIE_NAME}=${token}`, "User-Agent": "factory-guild-cli" },
      redirect: "manual",
    });
    if (res.status !== 200 || typeof res.headers.getSetCookie !== "function") return null;
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1 || pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
      const maxAge = attrs.map((a) => a.trim().match(/^max-age=(\d+)$/i)).find(Boolean);
      return {
        token: pair.slice(eq + 1).trim(),
        expires_at: maxAge ? new Date(Date.now() + Number(maxAge[1]) * 1000).toISOString() : null,
      };
    }
  } catch { /* offline or blocked: keep the current token */ }
  return null;
}

async function getToken() {
  const env = process.env.FACTORY_GUILD_SESSION;
  if (env) return normalizeToken(env);
  const auth = loadAuth();
  const last = Date.parse(auth.refreshed_at || auth.saved_at || "") || 0;
  if (Date.now() - last > REFRESH_AFTER_MS) {
    const fresh = await refreshSession(auth.token);
    if (fresh) {
      saveAuth({ ...auth, token: fresh.token, expires_at: fresh.expires_at, refreshed_at: new Date().toISOString() });
      return fresh.token;
    }
  }
  return auth.token;
}

async function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8");
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stderr.write(s); };
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); process.stderr.write("\n"); resolve(a); }));
}

async function api(method, path, { token, body } = {}) {
  const headers = {
    Cookie: `${COOKIE_NAME}=${token}`,
    Origin: ORIGIN,
    Referer: `${BASE}/submissions`,
    Accept: "application/json",
    "User-Agent": "factory-guild-cli",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  } catch (e) {
    throw new CliError(`Network error: ${e.message}`);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (res.status === 401 || (res.status >= 300 && res.status < 400)) {
    throw new CliError(`Session expired or invalid. ${AUTH_HINT}`, 3);
  }
  return { status: res.status, ok: res.ok, data };
}

function apiError(res) {
  const code = res.data && typeof res.data.error === "string" ? res.data.error : null;
  const idx = res.data && Number.isInteger(res.data.index) ? ` (link ${res.data.index + 1})` : "";
  const msg = (code && ERRORS[code]) || (code ? `Server error: ${code}` : `Unexpected response (HTTP ${res.status})`);
  return new CliError(`${msg}${idx}`);
}

function withHttps(link) {
  const l = link.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(l) ? l : `https://${l}`;
}

function validLink(l) {
  try {
    const u = new URL(l);
    return u.protocol === "https:" && u.hostname !== "" && l.length <= 500;
  } catch {
    return false;
  }
}

async function authSet(args) {
  const { _: rest } = parseArgs(args, {});
  const input = rest[0] ?? (await readSecret("Paste the session token: "));
  const token = normalizeToken(input);
  if (!(await checkSession(token))) {
    throw new CliError(`The server rejected that token. Check that you copied the "${COOKIE_NAME}" value and that it has not expired.`, 3);
  }
  await saveVerified(token);
}

async function saveVerified(token) {
  const now = new Date().toISOString();
  const fresh = await refreshSession(token);
  saveAuth({ token: fresh?.token ?? token, expires_at: fresh?.expires_at ?? null, saved_at: now, refreshed_at: fresh ? now : null });
  console.log(`Signed in. Saved to ${AUTH_FILE}`);
}

function browserRoot(browser) {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", browser.dir);
  return join(homedir(), ".config", browser.linuxDir);
}

function chromiumCookieKey(browser) {
  if (process.platform === "darwin") {
    const password = execFileSync("security", ["find-generic-password", "-w", "-s", browser.service, "-a", browser.account], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  }
  // Linux: PBKDF2 uses 1 iteration, not 1003. Try the system keyring first
  // (Chrome stores its "Safe Storage" password there when one is available),
  // then fall back to the fixed password Chrome uses without a keyring.
  let password = null;
  for (const app of ["chrome", "chromium"]) {
    try {
      password = execFileSync("secret-tool", ["lookup", "application", app], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (password) break;
    } catch { /* secret-tool missing or no entry: fall through to peanuts */ }
  }
  return pbkdf2Sync(password || "peanuts", "saltysalt", 1, 16, "sha1");
}

function decryptChromiumCookie(encrypted, key) {
  const tag = encrypted.subarray(0, 3).toString();
  if (tag !== "v10" && tag !== "v11") return null;
  const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  let plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  // Chrome 130+ prepends a 32-byte hash of the host key to the value.
  if (plain.length > 32 && !plain.subarray(0, 32).every((b) => b >= 0x20 && b < 0x7f)) plain = plain.subarray(32);
  return plain.toString("utf8");
}

// Collect candidate tokens from every profile of a browser, newest-expiring first.
function readBrowserCandidates(browser, tmp) {
  if (process.platform === "linux" && !browser.linuxDir) return [];
  const root = browserRoot(browser);
  if (!existsSync(root)) return [];
  const out = [];
  for (const profile of readdirSync(root)) {
    if (profile !== "Default" && !/^Profile \d+$/.test(profile)) continue;
    const dbPath = [join(root, profile, "Network", "Cookies"), join(root, profile, "Cookies")].find(existsSync);
    if (!dbPath) continue;
    // Copy with the write-ahead log so cookies Chrome has not flushed yet are included.
    const copy = join(tmp, `${browser.id}-${profile.replace(/\s/g, "_")}.db`);
    copyFileSync(dbPath, copy);
    for (const ext of ["-wal", "-shm", "-journal"]) if (existsSync(dbPath + ext)) copyFileSync(dbPath + ext, copy + ext);
    let rows;
    try {
      rows = execFileSync("sqlite3", ["-readonly", "-separator", "|", copy,
        `select hex(encrypted_value), value, expires_utc from cookies where host_key = 'factory.com' and name = '${COOKIE_NAME}' order by expires_utc desc`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (e) {
      if (e.code === "ENOENT") throw new CliError("The sqlite3 command was not found. Use: guild auth set", 2);
      continue;
    }
    for (const line of rows ? rows.split("\n") : []) {
      const [hex, plain] = line.split("|");
      out.push({ profile, hex, plain });
    }
  }
  return out;
}

async function authImport(args) {
  const { browser: only } = parseArgs(args, { "--browser": { key: "browser" } });
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new CliError("auth import only supports macOS and Linux. Use: guild auth set (see 'guild --help').", 2);
  }
  const browsers = BROWSERS.filter((b) => (!only || b.id === only.toLowerCase())
    && (process.platform !== "linux" || b.linuxDir));
  if (browsers.length === 0) throw new CliError(`--browser must be one of: ${BROWSERS.map((b) => b.id).join(", ")}`, 2);

  const tmp = mkdtempSync(join(tmpdir(), "factory-guild-"));
  const notes = [];
  try {
    for (const browser of browsers) {
      const candidates = readBrowserCandidates(browser, tmp);
      if (candidates.length === 0) continue;
      let key = null;
      for (const c of candidates) {
        let token = c.plain || null;
        if (!token && c.hex) {
          try {
            key ??= chromiumCookieKey(browser);
            token = decryptChromiumCookie(Buffer.from(c.hex, "hex"), key);
          } catch {
            notes.push(`${browser.name}: could not read the browser key (Keychain on macOS, keyring on Linux; access denied or cancelled).`);
            break;
          }
        }
        if (token && (await checkSession(token))) {
          console.error(`Found a signed-in session in ${browser.name} (${c.profile}).`);
          return void (await saveVerified(token));
        }
        notes.push(`${browser.name} (${c.profile}): session found but it is expired. Sign in at https://factory.com/guild and retry.`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  throw new CliError(`No signed-in Guild session found in your browsers.${notes.length ? `\n${[...new Set(notes)].join("\n")}` : ""}\nSign in at https://factory.com/guild/submissions, then retry, or use: guild auth set`, 3);
}

// A delete on an id that cannot exist returns 404 for a live session and 401 otherwise.
async function checkSession(token) {
  try {
    const res = await api("DELETE", "/api/submissions/00000000-0000-4000-8000-000000000000", { token });
    return res.status === 404;
  } catch (e) {
    if (e.code === 3) return false;
    throw e;
  }
}

async function authStatus() {
  const token = await getToken();
  const ok = await checkSession(token);
  console.log(ok ? "Signed in. Session is valid." : `Session is expired or invalid. ${AUTH_HINT}`);
  if (!ok) process.exitCode = 3;
}

function authLogout() {
  rmSync(AUTH_FILE, { force: true });
  console.log("Removed saved session.");
}

async function uploadFile(path, token) {
  if (!existsSync(path)) throw new CliError(`File not found: ${path}`, 2);
  const size = statSync(path).size;
  const contentType = FILE_TYPES[extname(path).slice(1).toLowerCase()];
  if (!contentType) throw new CliError(`Unsupported file type. Use: ${Object.keys(FILE_TYPES).join(", ")}`, 2);
  if (size < 1) throw new CliError("File is empty.", 2);
  if (size > MAX_FILE_BYTES) throw new CliError("File is larger than 50 MB.", 2);
  const name = basename(path);
  const ticketRes = await api("POST", "/api/submissions/uploads", { token, body: { file_name: name, content_type: contentType, size } });
  const ticket = ticketRes.data;
  if (!ticketRes.ok || !ticket || !ticket.upload_url || !ticket.object_key) throw apiError(ticketRes);
  const put = await fetch(ticket.upload_url, { method: "PUT", headers: ticket.headers || {}, body: readFileSync(path) });
  if (!put.ok) throw new CliError(`File upload failed (HTTP ${put.status}).`);
  return { file_key: ticket.object_key, file_name: name };
}

async function submit(args) {
  const opts = parseArgs(args, {
    "-t": { key: "title" }, "--title": { key: "title" },
    "-d": { key: "description" }, "--description": { key: "description" },
    "--type": { key: "type" },
    "-f": { key: "file" }, "--file": { key: "file" },
    "--dry-run": { key: "dryRun", bool: true },
    "--json": { key: "json", bool: true },
  });
  const links = opts._.map(withHttps);
  const title = (opts.title || "").trim();
  const description = (opts.description || "").trim();
  const log = (...m) => { if (!opts.json) console.error(...m); };

  if (!title) throw new CliError("--title is required.", 2);
  if (Array.from(title).length > MAX_TITLE) throw new CliError(`Title is over ${MAX_TITLE} characters.`, 2);
  if (Array.from(description).length > MAX_DESCRIPTION) throw new CliError(`Description is over ${MAX_DESCRIPTION} characters.`, 2);
  if (links.length === 0 && !opts.file) throw new CliError("Provide at least one link or a --file.", 2);
  if (links.length > MAX_LINKS) throw new CliError(`At most ${MAX_LINKS} links per contribution.`, 2);
  if (new Set(links.map((l) => l.toLowerCase().replace(/#.*$/, "").replace(/\/+$/, ""))).size !== links.length) {
    throw new CliError("The same link was given twice.", 2);
  }
  for (const l of links) if (!validLink(l)) throw new CliError(`Invalid link (must be https://): ${l}`, 2);
  if (opts.type && !MANUAL_TYPES.includes(opts.type)) throw new CliError(`--type must be one of: ${MANUAL_TYPES.join(", ")}`, 2);
  if (opts.file && links.length > 1) throw new CliError("A file can only be attached to a single-link contribution.", 2);

  const token = await getToken();

  const items = [];
  for (const link of links.length ? links : [""]) {
    let suggestion = { activity: null, reason: "" };
    if (link) {
      const res = await api("POST", "/api/submissions/classify", {
        token,
        body: { title, link, ...(description ? { description } : {}), ...(opts.file ? { file_name: basename(opts.file) } : {}) },
      });
      if (res.ok && res.data && typeof res.data === "object") {
        const a = MANUAL_TYPES.includes(res.data.activity) ? res.data.activity : null;
        suggestion = { activity: a, reason: typeof res.data.reason === "string" ? res.data.reason : "" };
      } else if (res.status === 400) {
        throw apiError(res);
      }
    }
    items.push({ link, suggestion, activity: opts.type || suggestion.activity || null });
  }

  for (const it of items) {
    if (it.activity && NEEDS_LINK.has(it.activity) && !it.link) throw new CliError(`${it.activity} needs a link.`, 2);
    if (it.activity && NEEDS_DESCRIPTION.has(it.activity) && !description) {
      throw new CliError(`${it.activity} needs --description so reviewers can assess it.`, 2);
    }
  }

  const summary = items.map((it) => ({ link: it.link || null, type: it.activity, suggested_type: it.suggestion.activity, reason: it.suggestion.reason }));
  if (opts.dryRun) {
    if (opts.json) console.log(JSON.stringify({ dry_run: true, title, description: description || null, items: summary }, null, 2));
    else {
      console.log(`Dry run, nothing submitted.\nTitle: ${title}`);
      for (const s of summary) console.log(`- ${s.link ?? "(file)"}\n  type: ${s.type ?? "left for reviewers"}${s.reason ? `\n  why: ${s.reason}` : ""}`);
    }
    return;
  }

  const file = opts.file ? await uploadFile(opts.file, token) : null;
  const toItem = (it) => ({
    activity: it.activity,
    ...(it.suggestion.activity ? { suggested_activity: it.suggestion.activity } : {}),
    ...(it.link ? { link: it.link } : {}),
  });
  const base = { title, ...(description ? { description } : {}), ...(file ?? {}) };
  const body = items.length === 1 ? { ...base, ...toItem(items[0]) } : { ...base, items: items.map(toItem) };

  const res = await api("POST", "/api/submissions", { token, body });
  if (!res.ok) throw apiError(res);
  const id = res.data?.submission?.id ?? null;
  const groupId = res.data?.submission?.group_id ?? null;
  if (opts.json) console.log(JSON.stringify({ submitted: true, id, group_id: groupId, title, items: summary, response: res.data }, null, 2));
  else {
    console.log(`Submitted: ${title}${groupId ? ` (group id ${groupId})` : id ? ` (id ${id})` : ""}`);
    for (const s of summary) console.log(`- ${s.link ?? "(file)"} [${s.type ?? "type left for reviewers"}]`);
    console.log("Status: in review. The Guild Council awards points later.");
  }
}

async function withdraw(args) {
  const { _: rest, group } = parseArgs(args, { "--group": { key: "group", bool: true } });
  const id = rest[0];
  if (!id) throw new CliError("Usage: guild withdraw [--group] <id>", 2);
  const token = await getToken();
  const path = group ? `/api/submission-groups/${encodeURIComponent(id)}` : `/api/submissions/${encodeURIComponent(id)}`;
  const res = await api("DELETE", path, { token });
  if (!res.ok) throw apiError(res);
  console.log("Withdrawn.");
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return void console.log(HELP);
  if (cmd === "auth") {
    if (sub === "import") return authImport(rest);
    if (sub === "set") return authSet(rest);
    if (sub === "status") return authStatus();
    if (sub === "logout") return authLogout();
    throw new CliError("Usage: guild auth <import|set|status|logout>", 2);
  }
  const args = sub === undefined ? [] : [sub, ...rest];
  if (cmd === "submit") return submit(args);
  if (cmd === "withdraw") return withdraw(args);
  throw new CliError(`Unknown command: ${cmd}\n\n${HELP}`, 2);
}

main().catch((e) => {
  console.error(e instanceof CliError ? e.message : e);
  process.exit(e instanceof CliError ? e.code : 1);
});
