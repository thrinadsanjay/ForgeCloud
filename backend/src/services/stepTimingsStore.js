import { prisma, fireAndForget } from "../db/client.js";

const BUFFER = Number(process.env.ETA_BUFFER || 1.25);
const MIN_ETA_SEC = 2;
const EMA_ALPHA = 0.35;

let templates = {};

export async function hydrateStepTimings() {
  const rows = await prisma.stepTiming.findMany();
  templates = {};
  for (const row of rows) {
    if (!templates[row.templateKey]) templates[row.templateKey] = {};
    templates[row.templateKey][row.stepKey] = {
      avgSec: row.avgSec,
      lastSec: row.lastSec,
      samples: row.samples,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function persistTiming(templateKey, stepKey, rec) {
  fireAndForget(
    prisma.stepTiming.upsert({
      where: { templateKey_stepKey: { templateKey, stepKey } },
      create: {
        templateKey,
        stepKey,
        avgSec: rec.avgSec,
        lastSec: rec.lastSec,
        samples: rec.samples,
        updatedAt: new Date(rec.updatedAt),
      },
      update: {
        avgSec: rec.avgSec,
        lastSec: rec.lastSec,
        samples: rec.samples,
        updatedAt: new Date(rec.updatedAt),
      },
    }),
    "step-timing"
  );
}

export function etaFor(templateKey, stepKey, defaultSec) {
  const rec = templates[templateKey]?.[stepKey];
  const base = rec && rec.samples > 0 ? rec.avgSec : defaultSec;
  return Math.max(MIN_ETA_SEC, Math.ceil(base * BUFFER));
}

export function recordDuration(templateKey, stepKey, sec) {
  if (!templateKey || !stepKey || !(sec >= 0)) return;
  if (!templates[templateKey]) templates[templateKey] = {};
  const prev = templates[templateKey][stepKey];
  const avgSec = prev && prev.samples > 0
    ? Math.round(prev.avgSec * (1 - EMA_ALPHA) + sec * EMA_ALPHA)
    : Math.round(sec);
  const rec = {
    avgSec,
    lastSec: Math.round(sec),
    samples: (prev?.samples || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  templates[templateKey][stepKey] = rec;
  persistTiming(templateKey, stepKey, rec);
}

export function allTimings() {
  return templates;
}
