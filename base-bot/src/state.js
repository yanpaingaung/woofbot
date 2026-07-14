import { readFileSync, writeFileSync, existsSync } from "fs";

const STATE_FILE = process.env.STATE_FILE ?? "./state.json";

export function loadState() {
  if (!existsSync(STATE_FILE)) return { sinceId: null };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { sinceId: null };
  }
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
