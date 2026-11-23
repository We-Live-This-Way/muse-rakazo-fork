import { parseServerHeaders } from "@rakazo/contracts";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import { defaultApiBase, normalizeApiBase } from "./endpoint";

const SAVED_SERVERS_KEY = "rakazo.saved_servers";
/** Written once the Maushaus entry has been seeded, so removing it never resurrects it. */
const SAVED_SERVERS_SEEDED_KEY = "rakazo.saved_servers_seeded";
export const MAX_SAVED_SERVERS = 5;
/** A label longer than this is truncated, not dropped. */
export const MAX_SAVED_SERVER_LABEL_LENGTH = 40;
/** The pre-filled server. The laptop server is never pre-filled: it is loopback-only. */
export const MAUSHAUS_API_BASE = "https://rakazo.example.com";
export const MAUSHAUS_LABEL = "Home server";

/**
 * A server the device has used before, with the custom headers it was configured with. `label`
 * is a display name the fork sets for a server (Maushaus); entries without one show their host.
 */
export type SavedServer = { apiBase: string; headers: Record<string, string>; label?: string };

let saved: SavedServer[] = [];
/** False until the stored list has been read, and while it could not be: an unread list is not an empty one. */
let readable = false;
let writes: Promise<unknown> = Promise.resolve();

/** Servers used before, most recent first; empty until `loadSavedServers` has read the device. */
export function savedServers(): SavedServer[] {
  return saved;
}

/** Trims a label and truncates an overlong one; an empty label is no label. */
function normalizeLabel(label: string): string | undefined {
  const trimmed = label.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_SAVED_SERVER_LABEL_LENGTH);
}

/** Keeps only entries that can be switched to as they are: an exact normalized origin and valid headers. */
function parseSavedServers(stored: string | null): SavedServer[] {
  if (!stored) return [];
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch (error) {
    console.warn("Saved servers could not be parsed", error);
    return [];
  }
  if (!Array.isArray(value)) return [];
  const entries: SavedServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const { apiBase, headers, label } = item as {
      apiBase?: unknown;
      headers?: unknown;
      label?: unknown;
    };
    if (typeof apiBase !== "string") continue;
    const normalized = normalizeApiBase(apiBase);
    const parsedHeaders = parseServerHeaders(headers);
    // A damaged entry is dropped, never switched to without the headers it needs.
    if (!normalized.ok || normalized.url !== apiBase || parsedHeaders === null) continue;
    const parsedLabel = typeof label === "string" ? normalizeLabel(label) : undefined;
    // A labeled default server is pinned by its row, which is the way back to it; an unlabeled
    // default is still covered by the "Use default server" button, so it stays unlisted.
    if (
      (apiBase === defaultApiBase() && !parsedLabel) ||
      entries.some((entry) => entry.apiBase === apiBase)
    ) {
      continue;
    }
    entries.push({
      apiBase,
      headers: parsedHeaders,
      ...(parsedLabel ? { label: parsedLabel } : {}),
    });
  }
  return entries.slice(0, MAX_SAVED_SERVERS);
}

/** True once the saved-servers list has been seeded, so a later launch can tell a first launch from a device that removed every server. */
export async function savedServersSeeded(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(SAVED_SERVERS_SEEDED_KEY)) !== null;
  } catch {
    return false;
  }
}

async function readSavedServers(): Promise<void> {
  let stored: string | null = null;
  try {
    stored = await SecureStore.getItemAsync(SAVED_SERVERS_KEY);
    readable = true;
  } catch (error) {
    // SecureStore is unavailable in some test / web hosts. Nothing is listed, and nothing is
    // written over what could not be read.
    readable = false;
    console.warn("Saved servers could not be read", error);
  }
  saved = parseSavedServers(stored);
  // A stored list, even a damaged one that parsed to nothing, is never overwritten with the seed.
  if (readable && stored === null) await seedSavedServers();
}

/**
 * Seeds the list with Maushaus the first time it is read with no stored list. The marker is a
 * separate key because an empty list deletes the list key, so "key absent" recurs after the user
 * removes the last entry and cannot by itself tell "never seeded" from "removed everything".
 * A failed seed write leaves the marker unwritten, so a later load retries.
 */
async function seedSavedServers(): Promise<void> {
  let seeded: string | null = null;
  try {
    seeded = await SecureStore.getItemAsync(SAVED_SERVERS_SEEDED_KEY);
  } catch {
    // An unreadable marker leaves the list alone; a later load retries.
    return;
  }
  if (seeded) return;
  const seed: SavedServer[] = [{ apiBase: MAUSHAUS_API_BASE, headers: {}, label: MAUSHAUS_LABEL }];
  if (!(await persist(seed))) return;
  saved = seed;
  await bestEffort(
    "mark the saved servers as seeded",
    SecureStore.setItemAsync(SAVED_SERVERS_SEEDED_KEY, "1"),
  );
}

async function persist(next: SavedServer[]): Promise<boolean> {
  try {
    if (next.length === 0) await SecureStore.deleteItemAsync(SAVED_SERVERS_KEY);
    else await SecureStore.setItemAsync(SAVED_SERVERS_KEY, JSON.stringify(next));
    return true;
  } catch (error) {
    // The caller decides what a failed write means; this only reports it.
    console.warn("Saved servers could not be written", error);
    return false;
  }
}

/** Runs one task at a time, so a read never publishes a list older than a write that landed. */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = writes.then(task);
  writes = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function loadSavedServers(): Promise<void> {
  return enqueue(readSavedServers);
}

/**
 * Runs one change at a time against the latest list; the list only changes when the write lands.
 * An update that returns null refuses the change without writing anything.
 */
function change(update: (current: SavedServer[]) => SavedServer[] | null): Promise<boolean> {
  return enqueue(async () => {
    if (!readable) await readSavedServers();
    if (!readable) return false;
    const next = update(saved);
    if (next === null) return false;
    if (!(await persist(next))) return false;
    saved = next;
    return true;
  });
}

/**
 * Remembers a server at the top of the list. `keepHeaders` is for a server being left: its
 * headers as the app read them may be missing, so a server already listed keeps the headers it
 * was saved with. A label passed in `options` is set; without one, an entry already listed keeps
 * the label it has. The default server is never listed unless it carries a label.
 */
export function recordSavedServer(
  apiBase: string,
  headers: Record<string, string>,
  options: { keepHeaders?: boolean; label?: string } = {},
) {
  return change((current) => {
    const existing = current.find((entry) => entry.apiBase === apiBase);
    const label = options.label !== undefined ? normalizeLabel(options.label) : existing?.label;
    if (apiBase === defaultApiBase() && !label) return null;
    const kept = options.keepHeaders ? existing : undefined;
    const entry: SavedServer = {
      apiBase,
      headers: kept?.headers ?? headers,
      ...(label ? { label } : {}),
    };
    return [entry, ...current.filter((entry) => entry.apiBase !== apiBase)].slice(
      0,
      MAX_SAVED_SERVERS,
    );
  });
}

/** Forgets one server and the headers and label kept for it. */
export function removeSavedServer(apiBase: string) {
  return change((current) => current.filter((entry) => entry.apiBase !== apiBase));
}
