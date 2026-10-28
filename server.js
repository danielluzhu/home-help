// Home Help: a small shared page for whoever is helping at your place (pet sitting, plant
// watering, house watching...). Everything you'd want to change lives in site.json, which you
// can edit by hand or from the page's edit mode. The server also stores what visitors add:
// schedule sign-ups, task sign-offs, photos, comments.
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const PORT = Number(process.env.PORT || 3000);
const here = (p) => new URL(p, import.meta.url).pathname;
const PAGE = here("./index.html");
const SITE = here("./site.json");
const PHOTO_DIR = here("./photos/");
// Everything visitors add lives in data/, which is kept out of git.
const DATA_DIR = process.env.DATA_DIR || here("./data/");
const UPLOAD_DIR = DATA_DIR.replace(/\/?$/, "/") + "uploads/";
mkdirSync(UPLOAD_DIR, { recursive: true });

// Set EDIT_PASSWORD to require a password for the page's edit mode; without it anyone can edit.
const EDIT_PASSWORD = process.env.EDIT_PASSWORD || "";

const DEFAULT_TIMES = ["Morning", "Midday", "Afternoon", "Evening", "Flexible"];

// site.json is read fresh on each use, so edits show up on the next page load without a restart.
function site() {
  try { return JSON.parse(readFileSync(SITE, "utf8")); } catch { return {}; }
}
const timesOf = (s) => (Array.isArray(s.schedule?.times) && s.schedule.times.length ? s.schedule.times : DEFAULT_TIMES);
// Info cards with a "photoSlot" let visitors add one photo of their own (e.g. where the vacuum is).
const slotsOf = (s) => (s.info || []).map((c) => c.photoSlot).filter(Boolean);

// Short arrays and objects stay on one line, so site.json stays easy to edit by hand.
function inline(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(inline).join(", ") + "]";
  const kv = Object.entries(v).map(([k, x]) => JSON.stringify(k) + ": " + inline(x));
  return kv.length ? "{ " + kv.join(", ") + " }" : "{}";
}
function pretty(v, ind = "") {
  const one = inline(v);
  if (v === null || typeof v !== "object" || (ind && one.length + ind.length <= 140)) return one;
  const next = ind + "  ", arr = Array.isArray(v);
  const items = arr ? v.map((x) => next + pretty(x, next)) : Object.entries(v).map(([k, x]) => next + JSON.stringify(k) + ": " + pretty(x, next));
  if (!items.length) return one;
  // At the top, a blank line before each section.
  const body = items.map((line, i) => (i && !ind && !arr && /^\s*"[^"]*": [[{]/.test(line) ? "\n" : "") + line).join(",\n");
  return (arr ? "[" : "{") + "\n" + body + "\n" + ind + (arr ? "]" : "}");
}
// Write to a temporary file first, so a crash mid-write can't leave site.json half written.
function writeSite(s) {
  writeFileSync(SITE + ".tmp", pretty(s) + "\n");
  renameSync(SITE + ".tmp", SITE);
}
// The password travels URI-encoded, since headers can only carry plain ASCII.
function canEdit(req) {
  if (!EDIT_PASSWORD) return true;
  let given = "";
  try { given = decodeURIComponent(req.headers.get("x-edit-password") || ""); } catch {}
  const a = Buffer.from(given), b = Buffer.from(EDIT_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const db = new Database(DATA_DIR.replace(/\/?$/, "/") + "home-help.db", { create: true });
db.run("PRAGMA journal_mode = WAL");
// Any number of helpers per day, each with a rough time of day.
db.run(`CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,             -- 'YYYY-MM-DD'
  name TEXT NOT NULL,
  time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Photos visitors upload: slot '' is the shared gallery, otherwise an info card's photoSlot.
db.run(`CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',  -- who uploaded it, if they said
  slot TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Sign-offs for tasks (feed the dog, water the ferns...): who did it, and on which day.
db.run(`CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,             -- task id from site.json
  date TEXT NOT NULL,             -- 'YYYY-MM-DD'
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// Comments on photos; a reply points at the comment it answers through parent.
db.run(`CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo TEXT NOT NULL,            -- file name: one of your photos, or an upload
  parent INTEGER,                 -- comment being replied to; NULL for a comment on the photo itself
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_RE = /^[A-Za-z0-9_-]{1,40}$/;
const PHOTO_RE = /^[A-Za-z0-9._ -]+\.(jpe?g|png|webp|gif|svg)$/i;
const UPLOAD_RE = /^up-[a-z0-9-]+\.jpg$/;
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,40}$/;
const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
const TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

const json = (body, status = 200) => Response.json(body, { status });
const clean = (v, max) => String(v ?? "").trim().slice(0, max);

function state() {
  let photos = [];
  try { photos = readdirSync(PHOTO_DIR).filter((f) => PHOTO_RE.test(f)); } catch {}
  return {
    reservations: db.query("SELECT id, date, name, time FROM reservations ORDER BY date, id").all(),
    photos,
    uploads: db.query("SELECT id, file, name, slot FROM photos ORDER BY id").all(),
    chores: db.query("SELECT id, task, date, name FROM chores ORDER BY date DESC, id DESC").all(),
    comments: db.query("SELECT id, photo, parent, name, body, created_at FROM comments ORDER BY id").all(),
    editLocked: !!EDIT_PASSWORD,
  };
}

// Removes a comment and every reply under it.
function deleteThread(id) {
  db.query(`WITH RECURSIVE t(id) AS (SELECT ? UNION SELECT c.id FROM comments c JOIN t ON c.parent = t.id)
    DELETE FROM comments WHERE id IN (SELECT id FROM t)`).run(id);
}
// Whether a photo can be commented on: one listed in site.json's gallery, or a visitor's gallery upload.
function photoExists(f) {
  if (UPLOAD_RE.test(f)) return !!db.query("SELECT 1 FROM photos WHERE file = ? AND slot = ''").get(f);
  return (site().gallery?.photos || []).includes(f);
}
function removeUpload(row) {
  db.query("DELETE FROM photos WHERE id = ?").run(row.id);
  rmSync(UPLOAD_DIR + row.file, { force: true });
  db.query("DELETE FROM comments WHERE photo = ?").run(row.file);
}

// Validates a reservation body; returns { name, time } or an error code.
async function readReservation(req) {
  const body = await req.json().catch(() => ({}));
  const times = timesOf(site());
  const name = clean(body.name, 60);
  const time = times.includes(body.time) ? body.time : times[times.length - 1];
  if (!name) return { error: "name_required" };
  return { name, time, dates: body.dates };
}

// Name the decoder from the file's first bytes, so ImageMagick never guesses
// a format (SVG, MVG, ...) from untrusted input.
function sniff(b) {
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (ascii(0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "webp";
  if (ascii(0, 4) === "GIF8") return "gif";
  if (ascii(4, 4) === "ftyp" && /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(ascii(8, 4))) return "heic";
  return null;
}

// Re-encode as a resized JPEG: fixes rotation and strips metadata such as GPS location.
// Needs ImageMagick's `convert` (or `magick`) on the machine.
const MAGICK = Bun.which("magick") ? ["magick"] : ["convert"];
// Visitors' photos go to data/uploads/; photos added in edit mode go to photos/ with yours.
async function savePhoto(file, dir = UPLOAD_DIR, prefix = "up") {
  if (file.size > MAX_PHOTO_BYTES) return { error: "too_big" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fmt = sniff(bytes);
  if (!fmt) return { error: "not_an_image" };
  const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}.jpg`;
  let proc;
  try {
    proc = Bun.spawn([...MAGICK, `${fmt}:-[0]`, "-auto-orient", "-resize", "1600x1600>", "-strip", "-quality", "85", `jpeg:${dir}${name}`],
      { stdin: bytes, stdout: "ignore", stderr: "ignore" });
  } catch { return { error: "no_imagemagick" }; }
  const timer = setTimeout(() => proc.kill(), 30000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) { rmSync(dir + name, { force: true }); return { error: "unreadable" }; }
  return { file: name };
}

const file = async (path, type) => {
  const f = Bun.file(path);
  return (await f.exists()) ? new Response(f, type ? { headers: { "Content-Type": type } } : undefined) : new Response("Not found", { status: 404 });
};

Bun.serve({
  port: PORT,
  maxRequestBodySize: 10 * MAX_PHOTO_BYTES,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/" || pathname === "/index.html") return file(PAGE, "text/html; charset=utf-8");
    // Sent as-is so the page can point out a typo in it, rather than the server failing to start.
    if (pathname === "/site.json") return new Response(Bun.file(SITE), { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    if (pathname === "/favicon.svg") return file(here("./favicon.svg"), "image/svg+xml");

    if (pathname.startsWith("/photos/")) {
      const f = decodeURIComponent(pathname.slice(8));
      if (!PHOTO_RE.test(f) || f.startsWith(".")) return new Response("Not found", { status: 404 });
      return file(PHOTO_DIR + f, TYPES[f.split(".").pop().toLowerCase()]);
    }
    if (pathname.startsWith("/uploads/")) {
      const f = decodeURIComponent(pathname.slice(9));
      if (!UPLOAD_RE.test(f)) return new Response("Not found", { status: 404 });
      return file(UPLOAD_DIR + f, "image/jpeg");
    }

    if (pathname === "/api/state" && req.method === "GET") return json(state());

    // Edit mode: replace or remove top-level parts of site.json ({set: {who: {...}, info: null}}).
    if (pathname === "/api/site/check" && req.method === "POST") return json({ ok: canEdit(req) }, canEdit(req) ? 200 : 401);
    if (pathname === "/api/site" && req.method === "PATCH") {
      if (!canEdit(req)) return json({ error: "password" }, 401);
      const b = await req.json().catch(() => null);
      const set = b && b.set;
      if (!set || typeof set !== "object" || Array.isArray(set) || !Object.keys(set).every((k) => KEY_RE.test(k))) return json({ error: "bad_request" }, 400);
      // Don't overwrite a hand edit that has a typo in it; it needs fixing by hand first.
      let cur;
      try { cur = JSON.parse(readFileSync(SITE, "utf8")); } catch { return json({ error: "site_json_broken" }, 409); }
      for (const [k, v] of Object.entries(set)) { if (v === null) delete cur[k]; else cur[k] = v; }
      writeSite(cur);
      return json({ site: cur });
    }
    // Edit mode: upload your own photos into photos/ (up to 20 at a time).
    if (pathname === "/api/site/photos" && req.method === "POST") {
      if (!canEdit(req)) return json({ error: "password" }, 401);
      const form = await req.formData().catch(() => null);
      const files = form ? form.getAll("photos").filter((f) => f instanceof Blob).slice(0, 20) : [];
      if (!files.length) return json({ error: "no_files" }, 400);
      const saved = [];
      for (const f of files) { const r = await savePhoto(f, PHOTO_DIR, "p"); if (r.file) saved.push(r.file); }
      return json({ ...state(), files: saved, failed: files.length - saved.length }, saved.length ? 200 : 400);
    }

    // Anyone can add photos to the gallery (up to 10 at a time) and remove uploaded ones.
    // A slot photo (one per slot) replaces the previous one.
    if (pathname === "/api/photos" && req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const slot = form ? String(form.get("slot") ?? "") : "";
      if (slot && !slotsOf(site()).includes(slot)) return json({ error: "bad_slot" }, 400);
      const files = form ? form.getAll("photos").filter((f) => f instanceof Blob).slice(0, slot ? 1 : 10) : [];
      if (!files.length) return json({ error: "no_files" }, 400);
      const name = clean(form.get("name"), 60);
      let failed = 0;
      for (const f of files) {
        const r = await savePhoto(f);
        if (r.error) { failed++; continue; }
        if (slot) for (const old of db.query("SELECT id, file FROM photos WHERE slot = ?").all(slot)) removeUpload(old);
        db.query("INSERT INTO photos (file, name, slot) VALUES (?, ?, ?)").run(r.file, name, slot);
      }
      return json({ ...state(), failed }, failed === files.length ? 400 : 200);
    }
    const ph = /^\/api\/photos\/(\d+)$/.exec(pathname);
    if (ph && req.method === "DELETE") {
      const row = db.query("SELECT id, file FROM photos WHERE id = ?").get(Number(ph[1]));
      if (row) removeUpload(row);
      return json(state());
    }

    // Comment on a photo, or reply to a comment on it; anyone can remove a comment (and its replies).
    if (pathname === "/api/comments" && req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      const photo = String(b.photo ?? ""), parent = b.parent == null ? null : Number(b.parent);
      const name = clean(b.name, 60), text = clean(b.body, 1000);
      if (!name) return json({ error: "name_required" }, 400);
      if (!text) return json({ error: "body_required" }, 400);
      if (!photoExists(photo)) return json({ error: "no_photo", ...state() }, 404);
      if (parent !== null && !db.query("SELECT 1 FROM comments WHERE id = ? AND photo = ?").get(parent, photo))
        return json({ error: "gone", ...state() }, 404);
      db.query("INSERT INTO comments (photo, parent, name, body) VALUES (?, ?, ?, ?)").run(photo, parent, name, text);
      return json(state());
    }
    const cm = /^\/api\/comments\/(\d+)$/.exec(pathname);
    if (cm && req.method === "DELETE") { deleteThread(Number(cm[1])); return json(state()); }

    // Sign off a task as done on a given day; anyone can remove a sign-off made by mistake.
    if (pathname === "/api/chores" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const task = String(body.task ?? ""), date = String(body.date ?? ""), name = clean(body.name, 60);
      if (!name) return json({ error: "name_required" }, 400);
      if (!TASK_RE.test(task) || !DATE_RE.test(date)) return json({ error: "bad_request" }, 400);
      db.query("INSERT INTO chores (task, date, name) VALUES (?, ?, ?)").run(task, date, name);
      return json(state());
    }
    const ch = /^\/api\/chores\/(\d+)$/.exec(pathname);
    if (ch && req.method === "DELETE") {
      db.query("DELETE FROM chores WHERE id = ?").run(Number(ch[1]));
      return json(state());
    }

    // Sign up for one or more days under one name and time of day.
    if (pathname === "/api/reservations" && req.method === "POST") {
      const r = await readReservation(req);
      if (r.error) return json({ error: r.error }, 400);
      const dates = Array.isArray(r.dates) ? [...new Set(r.dates)] : [];
      if (!dates.length || dates.length > 120 || !dates.every((d) => DATE_RE.test(d))) return json({ error: "bad_dates" }, 400);
      const insert = db.query("INSERT INTO reservations (date, name, time) VALUES (?, ?, ?)");
      db.transaction(() => { for (const d of dates) insert.run(d, r.name, r.time); })();
      return json(state());
    }
    const m = /^\/api\/reservations\/(\d+)$/.exec(pathname);
    if (m) {
      const id = Number(m[1]);
      if (req.method === "DELETE") {
        db.query("DELETE FROM reservations WHERE id = ?").run(id);
        return json(state());
      }
      if (req.method === "PUT") {
        const r = await readReservation(req);
        if (r.error) return json({ error: r.error }, 400);
        const res = db.query("UPDATE reservations SET name = ?, time = ?, updated_at = datetime('now') WHERE id = ?").run(r.name, r.time, id);
        if (!res.changes) return json({ error: "gone", ...state() }, 404);
        return json(state());
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Home Help running on http://localhost:${PORT}`);
