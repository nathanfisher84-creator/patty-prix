// The Meme Pool: anyone can upload, anyone can download.
// Files live in Vercel Blob (project → Storage → Blob store; the
// BLOB_READ_WRITE_TOKEN env var is injected automatically) and are
// served from Vercel's blob domain — never from pattyprix.xyz itself.
//
// Security posture:
//  - the real file type is sniffed from magic bytes server-side; the
//    client's claimed type and filename are never trusted
//  - allow-list only: jpg png gif webp mp4 webm (no SVG or HTML — the
//    classic stored-XSS vectors for user uploads)
//  - 4MB cap, random server-generated names, forced contentType
//  - uploads rate-limited per visitor via the existing Upstash KV
//  - DELETE requires the ADMIN_KEY env secret (moderation)

import { createHash, randomBytes } from "crypto";
import { kvEnv, kvPipeline } from "./track.mjs";

const MAX_BYTES = 4 * 1024 * 1024;
const UPLOADS_PER_HOUR = 12;

// tests inject a fake via globalThis.__blobImpl; prod imports the SDK
const blobApi = () => globalThis.__blobImpl || import("@vercel/blob");

function sniff(buf) {
  if (buf.length < 16) return null;
  const b = buf;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { ext: "jpg", mime: "image/jpeg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (b.slice(0, 4).toString("latin1") === "GIF8") return { ext: "gif", mime: "image/gif" };
  if (b.slice(0, 4).toString("latin1") === "RIFF" && b.slice(8, 12).toString("latin1") === "WEBP") return { ext: "webp", mime: "image/webp" };
  if (b.slice(4, 8).toString("latin1") === "ftyp") return { ext: "mp4", mime: "video/mp4" }; // mp4 / mov family
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { ext: "webm", mime: "video/webm" };
  return null;
}

async function readBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body, "binary");
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BYTES + 1024) return null; // over the cap, stop reading
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, x-admin-key");
  res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(501).json({ error: "meme pool not configured — add a Blob store in Vercel" });
  }

  try {
    const blob = await blobApi();

    if (req.method === "GET") {
      const { blobs } = await blob.list({ prefix: "memes/", limit: 100 });
      // names start with an inverted timestamp, so list order = newest first
      res.setHeader("cache-control", "s-maxage=30");
      return res.status(200).json({
        memes: blobs.map((b) => ({
          url: b.url,
          name: b.pathname.split("/").pop(),
          size: b.size,
          uploadedAt: b.uploadedAt
        }))
      });
    }

    if (req.method === "DELETE") {
      const admin = process.env.ADMIN_KEY;
      if (!admin || req.headers["x-admin-key"] !== admin) {
        return res.status(401).json({ error: "admin key required" });
      }
      const url = String(req.query?.url || "");
      let parsed;
      try { parsed = new URL(url); } catch { return res.status(400).json({ error: "bad url" }); }
      if (!parsed.hostname.endsWith("blob.vercel-storage.com") || !parsed.pathname.startsWith("/memes/")) {
        return res.status(400).json({ error: "not a meme pool file" });
      }
      await blob.del(url);
      return res.status(200).json({ ok: true });
    }

    if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

    // uploads: rate-limit per visitor when KV is configured
    const kv = kvEnv();
    if (kv) {
      const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const rl = "mprl:" + createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex").slice(0, 12);
      const gate = await kvPipeline([["INCR", rl], ["EXPIRE", rl, 3600]], kv);
      if (Number(gate[0]?.result) > UPLOADS_PER_HOUR) {
        return res.status(429).json({ error: "upload limit reached — try again in an hour" });
      }
    }

    const buf = await readBody(req);
    if (!buf) return res.status(413).json({ error: "too big — 4MB max" });
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: "too big — 4MB max" });
    if (buf.length < 100) return res.status(400).json({ error: "empty upload" });

    const type = sniff(buf);
    if (!type) {
      return res.status(415).json({ error: "jpg, png, gif, webp, mp4 or webm only" });
    }

    // inverted-timestamp name keeps the listing newest-first; the random
    // tail stops guessing/overwriting. Nothing user-supplied in the path.
    const name = "memes/" + String(20000000000000 - Date.now()) + "-" +
      randomBytes(5).toString("hex") + "." + type.ext;
    const saved = await blob.put(name, buf, {
      access: "public",
      contentType: type.mime,
      addRandomSuffix: false,
      cacheControlMaxAge: 31536000
    });
    return res.status(200).json({ ok: true, url: saved.url, name: name.split("/").pop(), size: buf.length });
  } catch (err) {
    return res.status(502).json({ error: String(err && err.message || err) });
  }
}
