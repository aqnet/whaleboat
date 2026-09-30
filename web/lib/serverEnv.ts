// Server-only settings. Secrets live in the repo-root .env.local, shared with
// scripts/ (AISStream, Supabase). Next only loads web/.env*, so read the root
// file here. Real environment variables win, as they do in production.

import { readFileSync } from "node:fs";
import { join } from "node:path";

let fileEnv: Record<string, string> | null = null;

function rootEnv(): Record<string, string> {
  if (fileEnv) return fileEnv;
  fileEnv = {};
  try {
    for (const line of readFileSync(join(process.cwd(), "..", ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\s]+)"?/);
      if (m) fileEnv[m[1]] = m[2];
    }
  } catch {
    // No root .env.local: fall back to process.env only.
  }
  return fileEnv;
}

export const serverEnv = (name: string): string | undefined => process.env[name] || rootEnv()[name];
