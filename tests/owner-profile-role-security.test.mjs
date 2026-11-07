import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(path.join(root, rel), "utf8");

test("authenticated users cannot self-promote cre_profiles.role", () => {
  const sql = read("supabase/migrations/202608190001_lock_cre_profile_role_and_close_anon_canvass.sql");
  assert.match(sql, /revoke update on table public\.cre_profiles from authenticated/i);
  assert.match(sql, /grant update \(display_name, report_identity, updated_at\) on table public\.cre_profiles to authenticated/i);
  assert.doesNotMatch(sql, /grant update \([^)]*role/i,
    "role must not be writable by an authenticated browser session");
});

test("anonymous sessions have no direct canvass table privileges", () => {
  const sql = read("supabase/migrations/202608190001_lock_cre_profile_role_and_close_anon_canvass.sql");
  assert.match(sql, /revoke all privileges on table public\.cre_canvass from anon/i);
});
