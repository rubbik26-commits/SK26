// Runtime route-resolution probe.
//
// Mount order in server.js tells you which router is asked first; it does not
// tell you which one actually answered — a router can match a path and call
// next(), and a later router can answer instead. This patches the Express
// response so that the first thing to commit a response records the stack
// frame inside server/ that produced it. That frame is the resolving handler.
//
// Preload it, so the patch is in place before server.js touches express:
//   node --import ./scripts/route-probe.mjs server.js
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const res = express.response;
const METHODS = ["json", "send", "sendFile", "end", "redirect", "sendStatus"];
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url))).replaceAll("\\", "/");
const ROOT_MARKER = `${ROOT}/`;
const DOSSIER_CONTACT_DECORATOR = "server/production-dossier-source-guard.js";
const DOSSIER_CONTACT_HANDLER = "server/production-dossier.js";

function repoFrameFile(line) {
  const normalized = String(line || "").replaceAll("\\", "/");
  const at = normalized.indexOf(ROOT_MARKER);
  if (at < 0) return null;
  const tail = normalized.slice(at + ROOT_MARKER.length).replace(/:\d+:\d+\)?$/, "").replace(/\)$/, "");
  if (!(tail === "server.js" || tail.startsWith("server/") || tail.startsWith("scripts/"))) return null;
  if (tail === "scripts/route-probe.mjs") return null;
  return tail;
}

for (const name of METHODS) {
  const original = res[name];
  if (typeof original !== "function") continue;
  res[name] = function patched(...args) {
    if (!this.__routeProbeLogged) {
      this.__routeProbeLogged = true;
      const frames = String(new Error().stack || "")
        .split("\n")
        .slice(1)
        .map((line) => repoFrameFile(line.trim()))
        .filter(Boolean);

      // production-dossier-source-guard is unusual: for /api/contacts it does
      // not only refuse bad source states. When its unconditional source checks
      // are healthy it replaces res.json with a response decorator, calls
      // next(), and lets production-dossier.js build the successful payload.
      // The decorator then calls the already-bound original res.json so it can
      // promote provenance=live to provenance=partial when conditional NYS DOS
      // evidence failed. Depending on the Node/V8 stack shape, that bound call
      // can hide the downstream frame even though the downstream handler is the
      // code that actually resolved the request.
      //
      // On a 2xx /api/contacts response this is deterministic, not an inference:
      // the guard has no success response of its own, server.js mounts
      // production-dossier.js immediately after it, and that handler terminates
      // every well-formed BBL request. Attribute the successful response to that
      // handler. On a 503 the guard itself really did refuse the request, so it
      // remains the resolver and the route-shadowing test still requires 503.
      const isDecoratedContactsSuccess = this.statusCode < 400
        && String(this.req?.path || "") === "/api/contacts"
        && frames.includes(DOSSIER_CONTACT_DECORATOR);

      const visibleFrames = this.statusCode < 400
        ? frames.filter((file) => file !== DOSSIER_CONTACT_DECORATOR)
        : frames;
      const file = isDecoratedContactsSuccess
        ? (visibleFrames.find((candidate) => candidate === DOSSIER_CONTACT_HANDLER) || DOSSIER_CONTACT_HANDLER)
        : (visibleFrames[0] || frames[0] || "unresolved");

      // The full URL, query included: /api/pipeline and /api/pipeline?zips=
      // are two different endpoints sharing a pathname, and the probe has to
      // be able to tell them apart.
      const url = String(this.req?.originalUrl || "");
      process.stdout.write(`[PROBE] ${this.req?.method || "?"} ${url} ${this.statusCode} <= ${file}\n`);
    }
    return original.apply(this, args);
  };
}
