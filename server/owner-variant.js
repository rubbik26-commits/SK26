// Deployment variant switch.
//
// The reconstruction is being completed as the full OWNER product first. The
// immutable frontend decides whether to expose owner-only surfaces from
// /api/pinecone-status.owner, while the backend independently protects the
// corresponding endpoints with gateRole(). In an owner build, the normal site
// credential therefore has to resolve to the owner tier; otherwise the same
// compiled application silently renders the reduced member product even though
// this deployment is intended to be the Owner version.
//
// Later user deployments can set APP_VARIANT=user. Nothing is removed from the
// codebase: the existing SITE_PASSWORD/member and OWNER_PASSWORD/owner split is
// restored simply by selecting that variant.
export function normalizeAppVariant(env = process.env) {
  const raw = String(env.APP_VARIANT || "owner").trim().toLowerCase();
  const variant = raw === "user" ? "user" : "owner";

  if (variant === "owner" && env.SITE_PASSWORD) {
    // gateRole() checks the owner token before the member token. Making the
    // owner credential identical to SITE_PASSWORD therefore promotes a valid
    // site session to owner without weakening the outer password wall.
    env.OWNER_PASSWORD = env.SITE_PASSWORD;
  }

  return variant;
}

export function appVariant(env = process.env) {
  return String(env.APP_VARIANT || "owner").trim().toLowerCase() === "user" ? "user" : "owner";
}
