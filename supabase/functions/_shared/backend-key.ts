type EnvGet = (name: string) => string | undefined;

const CONFIGURATION_ERROR = "Backend credential configuration is invalid";

// The selector is not a credential. An explicit selector must never fall back
// to legacy/default credentials when its configured key cannot be selected.
export function getBackendKey(envGet: EnvGet): string {
  try {
    const name = envGet("V3_BACKEND_KEY_NAME");
    if (name === undefined) {
      // Temporary compatibility for deploying before the operator sets a selector.
      const legacy = envGet("SUPABASE_SERVICE_ROLE_KEY");
      if (typeof legacy === "string" && legacy.length > 0 && legacy.trim() === legacy) return legacy;
      throw new Error(CONFIGURATION_ERROR);
    }

    if (typeof name !== "string" || name.length === 0 || name.trim() !== name) {
      throw new Error(CONFIGURATION_ERROR);
    }
    const raw = envGet("SUPABASE_SECRET_KEYS");
    const keys: unknown = typeof raw === "string" ? JSON.parse(raw) : null;
    if (keys === null || typeof keys !== "object" || Array.isArray(keys) || !Object.hasOwn(keys, name)) {
      throw new Error(CONFIGURATION_ERROR);
    }
    const key: unknown = (keys as Record<string, unknown>)[name];
    if (typeof key !== "string" || !key.startsWith("sb_secret_") || key.length <= "sb_secret_".length ||
      /[^A-Za-z0-9_-]/.test(key)) {
      throw new Error(CONFIGURATION_ERROR);
    }
    return key;
  } catch {
    // Parsing/env errors may contain secret values. Expose only a fixed message.
    throw new Error(CONFIGURATION_ERROR);
  }
}
