/**
 * Persistent Zotero ↔ dsh-papercover identity map under paperDir/zotero-map.json.
 */
import { readFile, writeFile, rename, unlink, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface MapEntry {
  scholarId: string;
  zoteroKey: string;
  zoteroVersion: number;
  /** scholar updatedAt at last successful sync */
  scholarUpdatedAt: number;
  kind: 'paper' | 'collection' | 'card' | 'note' | 'annotation' | 'attachment';
  /** parent paper id for notes/annotations/attachments */
  parentScholarId?: string;
  contentHash?: string;
}

export interface ZoteroMapFile {
  serverId: string;
  library: string;
  cursorVersion: number;
  entries: MapEntry[];
  updatedAt: number;
  /**
   * 同步器的映射结构版本。低于当前版本的映射会在下次同步时做一次全量重扫
   * （见 engine.ts 的 ZOTERO_MAP_SCHEMA）：有些修复必须回头看游标之下的旧条目，
   * 例如「高光标注挂在 PDF 附件下」被修好之前，老高光的版本号早已被游标越过。
   */
  schemaVersion?: number;
}

export function emptyMap(serverId = '', library = 'user/0'): ZoteroMapFile {
  return { serverId, library, cursorVersion: 0, entries: [], updatedAt: Date.now() };
}

export async function loadMap(paperDir: string): Promise<ZoteroMapFile> {
  try {
    const raw = JSON.parse(await readFile(join(paperDir, 'zotero-map.json'), 'utf8')) as ZoteroMapFile;
    if (!raw || !Array.isArray(raw.entries)) return emptyMap();
    return {
      serverId: raw.serverId ?? '',
      library: raw.library ?? 'user/0',
      cursorVersion: Number(raw.cursorVersion) || 0,
      entries: raw.entries.filter((e) => e && e.scholarId && e.zoteroKey),
      updatedAt: raw.updatedAt || Date.now(),
      schemaVersion: Number(raw.schemaVersion) || 0,
    };
  } catch {
    return emptyMap();
  }
}

export async function saveMap(paperDir: string, map: ZoteroMapFile): Promise<void> {
  const file = join(paperDir, 'zotero-map.json');
  const next = { ...map, updatedAt: Date.now() };
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export function findByScholar(map: ZoteroMapFile, kind: MapEntry['kind'], scholarId: string): MapEntry | undefined {
  return map.entries.find((e) => e.kind === kind && e.scholarId === scholarId);
}

export function findByZotero(map: ZoteroMapFile, kind: MapEntry['kind'], zoteroKey: string): MapEntry | undefined {
  return map.entries.find((e) => e.kind === kind && e.zoteroKey === zoteroKey);
}

export function upsertEntry(map: ZoteroMapFile, entry: MapEntry): void {
  const i = map.entries.findIndex((e) => e.kind === entry.kind && e.scholarId === entry.scholarId);
  if (i >= 0) map.entries[i] = entry;
  else map.entries.push(entry);
}

export async function appendConflict(
  paperDir: string,
  row: Record<string, unknown>,
): Promise<void> {
  await mkdir(paperDir, { recursive: true });
  await appendFile(
    join(paperDir, 'sync-conflicts.jsonl'),
    `${JSON.stringify({ ...row, at: Date.now() })}\n`,
    'utf8',
  );
}

const LAST_SYNC_FILE = 'zotero-last-sync.json';

/** Persist the latest sync run summary for status UI. */
export async function saveLastSync(
  paperDir: string,
  result: import('../shared/types.js').ZoteroSyncResult,
): Promise<void> {
  await mkdir(paperDir, { recursive: true });
  const file = join(paperDir, LAST_SYNC_FILE);
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  const payload = { ...result, finishedAt: result.finishedAt ?? Date.now() };
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function loadLastSync(
  paperDir: string,
): Promise<import('../shared/types.js').ZoteroSyncResult | null> {
  try {
    const raw = JSON.parse(await readFile(join(paperDir, LAST_SYNC_FILE), 'utf8')) as import('../shared/types.js').ZoteroSyncResult;
    if (!raw || typeof raw.ok !== 'boolean') return null;
    return raw;
  } catch {
    return null;
  }
}
