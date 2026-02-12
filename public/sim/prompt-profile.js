export const DEFAULT_PROMPT_PROFILE = {
  "value-pools": 1.05,
  "governance-control": 1.33,
  "data-platform": 1.05,
  "portfolio-discipline": 1.1,
  "people-change": 1.0,
  "human-agency": 1.32,
  "measurement-cadence": 1.5,
};

const KEYS = Object.keys(DEFAULT_PROMPT_PROFILE);

function sanitizeProfile(profile) {
  const output = { ...DEFAULT_PROMPT_PROFILE };
  if (!profile || typeof profile !== "object") {
    return output;
  }
  for (const key of KEYS) {
    const incoming = Number(profile[key]);
    if (Number.isFinite(incoming)) {
      output[key] = Math.min(1.5, Math.max(0.6, incoming));
    }
  }
  return output;
}

export function loadProfileFromDisk(baseDir) {
  return { ...DEFAULT_PROMPT_PROFILE };
}

export function resolvePromptProfile(profile) {
  return sanitizeProfile(profile);
}

