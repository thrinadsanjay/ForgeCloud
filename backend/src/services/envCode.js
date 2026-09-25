/**
 * Short environment codes for hostnames (≤3 chars).
 * Prefer curated aliases; otherwise a consonant/word heuristic — never blind first-3.
 */

const KNOWN = {
  production: "prd",
  prod: "prd",
  prd: "prd",
  staging: "stg",
  stage: "stg",
  stg: "stg",
  development: "dev",
  develop: "dev",
  devel: "dev",
  dev: "dev",
  testing: "tst",
  test: "tst",
  tst: "tst",
  qa: "qa",
  uat: "uat",
  sandbox: "sbx",
  sbx: "sbx",
  integration: "int",
  int: "int",
  preprod: "ppd",
  "pre-prod": "ppd",
  "pre-production": "ppd",
  preproduction: "ppd",
  ppd: "ppd",
  homelab: "lab",
  "home-lab": "lab",
  lab: "lab",
  demo: "dmo",
  dmo: "dmo",
  disaster: "dr",
  "disaster-recovery": "dr",
  dr: "dr",
  recovery: "rcv",
  backup: "bck",
  management: "mgt",
  mgmt: "mgt",
  mgt: "mgt",
  shared: "shd",
  common: "cmn",
  corporate: "crp",
  corp: "crp",
  internal: "int",
  external: "ext",
  public: "pub",
  private: "pvt",
  dmz: "dmz",
  edge: "edg",
  core: "cor",
  research: "rsh",
  training: "trn",
  train: "trn",
  ci: "ci",
  cd: "cd",
  cicd: "cic",
};

const aiCache = new Map();

function slugify(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Consonant skeleton, first 3 letters (fallback when no alias). */
function consonantCode(slug) {
  const letters = slug.replace(/[^a-z]/g, "");
  if (!letters) return "env";
  if (letters.length <= 3) return letters;
  const cons = letters.replace(/[aeiouy]/g, "");
  if (cons.length >= 3) return cons.slice(0, 3);
  // Mix consonants + remaining letters to fill 3
  let out = cons;
  for (const ch of letters) {
    if (out.length >= 3) break;
    if (!out.includes(ch)) out += ch;
  }
  return (out || letters).slice(0, 3);
}

/**
 * Multi-word / hyphenated: take initials of significant parts, pad from last word.
 * e.g. home-lab → hl + a from lab → hla? Better: last meaningful part if short.
 */
function fromParts(slug) {
  const parts = slug.split("-").filter(Boolean);
  if (parts.length < 2) return null;
  // Prefer a known last segment (lab, prod, …)
  const last = parts[parts.length - 1];
  if (KNOWN[last]) return KNOWN[last];
  if (last.length <= 3) return last;
  // Initials of up to 3 parts
  const initials = parts.map((p) => p[0]).join("").slice(0, 3);
  if (initials.length === 3) return initials;
  return consonantCode(slug);
}

/**
 * Sync short code for hostnames. Always ≤3 lowercase alphanumeric chars.
 */
export function shortEnvCode(name) {
  const slug = slugify(name);
  if (!slug) return "env";
  if (KNOWN[slug]) return KNOWN[slug];
  if (slug.length <= 3) return slug;

  const fromCache = aiCache.get(slug);
  if (fromCache) return fromCache;

  const parts = fromParts(slug);
  if (parts) return parts.slice(0, 3);

  return consonantCode(slug);
}

/**
 * Optionally refine unknown long names via AI (cached). Falls back to shortEnvCode.
 */
export async function shortEnvCodeWithAi(name) {
  const slug = slugify(name);
  if (!slug) return "env";
  if (KNOWN[slug] || slug.length <= 3) return shortEnvCode(slug);
  if (aiCache.has(slug)) return aiCache.get(slug);

  try {
    const { completeText } = await import("./aiChatService.js");
    const prompt = [
      "Return ONLY a 3-letter lowercase hostname environment code for this environment name.",
      "Rules: exactly 3 letters a-z (or fewer only if the name itself is shorter).",
      "Prefer recognizable abbreviations (production→prd, staging→stg, homelab→lab, development→dev).",
      "Do not use the first three letters unless they form a good abbreviation.",
      `Environment name: ${name}`,
      "Code:",
    ].join("\n");
    const raw = await completeText(prompt, { timeoutMs: 8000 });
    const match = String(raw || "").toLowerCase().match(/[a-z]{2,3}/);
    if (match) {
      const code = match[0].slice(0, 3);
      aiCache.set(slug, code);
      return code;
    }
  } catch {
    /* fall through */
  }

  const fallback = shortEnvCode(slug);
  aiCache.set(slug, fallback);
  return fallback;
}

export function listKnownEnvCodes() {
  return { ...KNOWN };
}
