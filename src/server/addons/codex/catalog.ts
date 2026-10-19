import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexModel {
  value: string;
  displayName: string;
  efforts: string[];
}

/** The models the user's Codex offers, from the cache the Codex CLI keeps. Only model names, never its config or login. */
export function codexModels(file = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "models_cache.json")): CodexModel[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(data.models)) return [];
    return data.models
      .filter((model: any) => model.visibility === "list" && typeof model.slug === "string" && /^[a-zA-Z0-9._:-]{1,100}$/.test(model.slug))
      .map((model: any) => ({
        value: model.slug,
        displayName: typeof model.display_name === "string" ? model.display_name : model.slug,
        efforts: (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
          .map((level: any) => level.effort)
          .filter((value: any) => ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value)),
      }));
  } catch {
    return [];
  }
}
