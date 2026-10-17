/**
 * Zotero ↔ dsh-papercover bidirectional sync engine.
 * Conflict policy: last-write-wins by Zotero version / scholar updatedAt.
 */
import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  IdeaCard, Paper, PaperCollection, PaperHighlight,
  ScholarConfig, ZoteroSyncDirection, ZoteroSyncResult, ZoteroSyncStatus,
} from '../shared/types.js';
import { createCard, createPaper, findDuplicate } from '../domain.js';
import type { PaperStore } from '../store.js';
import { canonicalPdfRel, safeName } from '../store.js';
import {
  ZoteroHttpClient, ZoteroHttpError, itemData, md5Hex, type ZoteroJsonObject,
} from './http.js';
import {
  appendConflict, findByScholar, findByZotero, loadMap, loadLastSync, saveLastSync, saveMap, upsertEntry,
  type ZoteroMapFile,
} from './map.js';
import { parseZoteroPositionJson } from '../shared/pdf-coords.js';

const IDEAS_COLLECTION = 'dsh-papercover/Ideas';
const NOTE_MARKER = '<!--dsh-scholar-note-->';
const CARD_MARKER = '<!--dsh-scholar-idea-->';
/**
 * 映射结构版本。抬高它会强制下一次同步做一次全量重扫（游标清零），
 * 用于修复那些「必须回看游标之前条目」的缺陷。
 * 3：高光标注改由 `itemType=annotation` 列举（附件的 /children 拿不到），
 *    老高光的版本号早已被游标越过，必须全量重扫才能补回来。
 * 4：重新开启 Zotero 高光导入（coordSpace=pdf + 阅读台 y 翻转）。
 */
const ZOTERO_MAP_SCHEMA = 4;

/**
 * Import Zotero highlights into the scholar annotation store.
 *
 * Zotero `annotationPosition.rects` are PDF user-space (origin bottom-left).
 * Imports are stored with `coordSpace: 'pdf'`; `PaperSidebarReader` flips
 * `top = pageHeight − y − h` at paint time using the live pdf.js page height.
 */
const IMPORT_ZOTERO_ANNOTATIONS = true;

/**
 * Zotero 10 的本地写密钥：点「允许」只够一次写入，点「始终允许」才可反复用。
 * 整库同步会连续写合集、论文、笔记，单次密钥在第一次认证时就被消耗。
 */
const WRITE_KEY_REJECTED =
  'Zotero 写密钥已失效。请重新授权，并在对话框中选择「始终允许」——单次允许在第一次写入后就会作废，无法完成整库同步。';

export function isRejectedWriteKey(err: unknown): boolean {
  if (err instanceof ZoteroHttpError && err.status === 401) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /invalid or expired api key/i.test(msg);
}

function recordPushError(result: ZoteroSyncResult, label: string, err: unknown): void {
  if (isRejectedWriteKey(err)) throw err;
  result.errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
}

export function defaultZoteroBaseUrl(cfg: ScholarConfig): string {
  return (cfg.zoteroBaseUrl?.trim() || 'http://127.0.0.1:23119/api').replace(/\/+$/, '');
}

export function makeClient(cfg: ScholarConfig): ZoteroHttpClient {
  return new ZoteroHttpClient({
    baseUrl: defaultZoteroBaseUrl(cfg),
    serverId: cfg.zoteroServerId?.trim() || undefined,
    apiKey: cfg.zoteroApiKey?.trim() || undefined,
  });
}

function emptyCounts() {
  return { papers: 0, collections: 0, notes: 0, cards: 0, pdfs: 0, annotations: 0 };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function yearFromDate(date: string): number | undefined {
  const m = /(\d{4})/.exec(date || '');
  return m ? Number(m[1]) : undefined;
}

function creatorsToAuthors(creators: unknown): string[] {
  if (!Array.isArray(creators)) return [];
  return creators.map((c) => {
    if (!c || typeof c !== 'object') return '';
    const o = c as { name?: string; firstName?: string; lastName?: string };
    if (o.name) return o.name.trim();
    return [o.firstName, o.lastName].filter(Boolean).join(' ').trim();
  }).filter(Boolean);
}

function authorsToCreators(authors: string[]): { creatorType: string; firstName: string; lastName: string }[] {
  return authors.map((a) => {
    const parts = a.trim().split(/\s+/);
    if (parts.length === 1) return { creatorType: 'author', firstName: '', lastName: parts[0]! };
    return { creatorType: 'author', firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! };
  });
}

function itemTypeFor(paper: Paper): string {
  if (paper.arxivId) return 'preprint';
  const v = (paper.venue || '').toLowerCase();
  if (/conference|workshop|symposium|proc\.|cvpr|iccv|neurips|icml|aaai|acl|emnlp/.test(v)) {
    return 'conferencePaper';
  }
  return 'journalArticle';
}

function tagsFromZotero(data: Record<string, unknown>): string[] {
  const tags = data.tags;
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => {
    if (typeof t === 'string') return t.trim();
    if (t && typeof t === 'object' && 'tag' in t) return String((t as { tag: unknown }).tag).trim();
    return '';
  }).filter(Boolean);
}

function tagsToZotero(tags: string[]): { tag: string }[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))].map((tag) => ({ tag }));
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function noteHtml(body: string, marker: string): string {
  const escaped = body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>');
  return `<div>${marker}<p>${escaped}</p></div>`;
}

function parseCardNote(html: string): { title: string; insight: string; meta: Record<string, string> } | null {
  if (!html.includes(CARD_MARKER)) return null;
  const text = stripHtml(html);
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const meta: Record<string, string> = {};
  const body: string[] = [];
  let title = '';
  for (const line of lines) {
    const m = /^\[(\w+)\]\s*(.*)$/.exec(line);
    if (m) {
      meta[m[1]!] = m[2] ?? '';
      continue;
    }
    if (!title) title = line;
    else body.push(line);
  }
  return { title: title || 'Idea', insight: body.join('\n'), meta };
}

function cardToNoteBody(card: IdeaCard): string {
  const lines = [
    CARD_MARKER,
    card.title,
    '',
    card.insight,
    '',
    `[category] ${card.category}`,
    `[status] ${card.status}`,
    `[importance] ${card.importance}`,
    card.tags.length ? `[tags] ${card.tags.join(', ')}` : '',
    card.plain ? `[plain] ${card.plain}` : '',
    card.evidence ? `[evidence] ${card.evidence}` : '',
    card.notes ? `[notes] ${card.notes}` : '',
    `[scholarId] ${card.id}`,
  ].filter((x) => x !== undefined);
  return noteHtml(lines.join('\n'), CARD_MARKER);
}

function paperFromZotero(obj: ZoteroJsonObject, now: number): Paper | null {
  const data = itemData(obj);
  const itemType = str(data.itemType);
  if (!itemType || itemType === 'attachment' || itemType === 'note' || itemType === 'annotation') return null;
  const title = str(data.title).trim();
  if (!title) return null;
  const extra = str(data.extra);
  const url = str(data.url);
  const arxivFromExtra = /arXiv[:\s]+([0-9]+\.[0-9]+(v\d+)?)/i.exec(extra)?.[1]
    || /arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+(v\d+)?)/i.exec(url)?.[1];
  const doi = str(data.DOI) || str(data.doi) || undefined;
  const paper = createPaper({
    source: 'manual',
    title,
    authors: creatorsToAuthors(data.creators),
    year: yearFromDate(str(data.date)),
    venue: str(data.publicationTitle) || str(data.conferenceName) || str(data.proceedingsTitle) || undefined,
    arxivId: arxivFromExtra,
    doi,
    url: url || undefined,
    abstract: str(data.abstractNote) || undefined,
    tags: tagsFromZotero(data),
    notes: undefined,
  }, now);
  paper.zoteroKey = obj.key || str(data.key);
  paper.zoteroVersion = Number(obj.version ?? data.version) || 0;
  return paper;
}

function paperToZoteroData(paper: Paper, collectionKeys: string[]): Record<string, unknown> {
  const itemType = itemTypeFor(paper);
  const data: Record<string, unknown> = {
    itemType,
    title: paper.title,
    creators: authorsToCreators(paper.authors),
    abstractNote: paper.abstract || '',
    url: paper.url || '',
    tags: tagsToZotero(paper.tags),
    collections: collectionKeys,
    relations: {},
  };
  if (paper.year) data.date = String(paper.year);
  if (paper.doi) data.DOI = paper.doi;
  if (itemType === 'journalArticle' && paper.venue) data.publicationTitle = paper.venue;
  if (itemType === 'conferencePaper' && paper.venue) data.proceedingsTitle = paper.venue;
  if (itemType === 'preprint') {
    data.repository = 'arXiv';
    if (paper.arxivId) data.archiveID = paper.arxivId;
  }
  const extra: string[] = [];
  if (paper.arxivId) extra.push(`arXiv: ${paper.arxivId}`);
  if (paper.summary) extra.push(`Summary: ${paper.summary}`);
  if (extra.length) data.extra = extra.join('\n');
  return data;
}

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function readPdfBytes(store: PaperStore, paper: Paper): Promise<Buffer | null> {
  if (!paper.pdfPath) return null;
  const abs = join(store.dir, paper.pdfPath.replace(/\\/g, '/'));
  try {
    return await readFile(abs);
  } catch {
    return null;
  }
}

export async function getSyncStatus(cfg: ScholarConfig, store: PaperStore): Promise<ZoteroSyncStatus> {
  const baseUrl = defaultZoteroBaseUrl(cfg);
  const map = await loadMap(store.dir);
  const status: ZoteroSyncStatus = {
    reachable: false,
    hasWriteKey: Boolean(cfg.zoteroApiKey?.trim()),
    syncEnabled: Boolean(cfg.zoteroSyncEnabled),
    baseUrl,
    lastCursor: map.serverId ? { serverId: map.serverId, version: map.cursorVersion } : undefined,
    mapCounts: {
      papers: map.entries.filter((e) => e.kind === 'paper').length,
      collections: map.entries.filter((e) => e.kind === 'collection').length,
      cards: map.entries.filter((e) => e.kind === 'card').length,
      annotations: map.entries.filter((e) => e.kind === 'annotation').length,
    },
  };
  try {
    const client = makeClient(cfg);
    const info = await client.probe();
    status.reachable = true;
    status.serverId = info.serverId;
    status.zoteroVersion = info.zoteroVersion;
    status.apiVersion = info.apiVersion;
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  }
  status.lastSync = await loadLastSync(store.dir);
  return status;
}

export async function authorizeZotero(
  cfg: ScholarConfig,
  updateConfig: (patch: Partial<ScholarConfig>) => Promise<unknown>,
): Promise<{ key: string; remember: boolean; serverId: string }> {
  const client = makeClient(cfg);
  const result = await client.authorize('dsh-papercover / Research Desk');
  if (!result.remember) {
    throw new ZoteroHttpError(
      'Zotero 只授予了单次写权限。整库同步需要在对话框中选择「始终允许」，否则密钥在第一次写入后就会失效。',
      401,
    );
  }
  await updateConfig({
    zoteroApiKey: result.key,
    zoteroServerId: result.serverId,
    zoteroSyncEnabled: true,
  });
  return result;
}

export async function runSync(opts: {
  store: PaperStore;
  cfg: ScholarConfig;
  direction: ZoteroSyncDirection;
  updateConfig?: (patch: Partial<ScholarConfig>) => Promise<unknown>;
}): Promise<ZoteroSyncResult> {
  const started = Date.now();
  const result: ZoteroSyncResult = {
    ok: true,
    direction: opts.direction,
    pulled: emptyCounts(),
    pushed: emptyCounts(),
    conflicts: 0,
    errors: [],
    durationMs: 0,
  };
  const library = opts.cfg.zoteroLibrary?.trim() || 'user/0';
  let client = makeClient(opts.cfg);
  let map = await loadMap(opts.store.dir);

  try {
    const info = await client.probe();
    if (map.serverId && map.serverId !== info.serverId) {
      // Different Zotero DB — reset map
      map = { serverId: info.serverId, library, cursorVersion: 0, entries: [], updatedAt: Date.now() };
    } else {
      map.serverId = info.serverId;
      map.library = library;
    }
    if (opts.updateConfig && opts.cfg.zoteroServerId !== info.serverId) {
      await opts.updateConfig({ zoteroServerId: info.serverId });
    }
    client = client.withAuth({
      serverId: info.serverId,
      apiKey: opts.cfg.zoteroApiKey?.trim() || undefined,
    });

    if (opts.direction === 'pull' || opts.direction === 'both') {
      await pullAll({ store: opts.store, client, map, library, result });
    }
    if (opts.direction === 'push' || opts.direction === 'both') {
      if (!opts.cfg.zoteroApiKey?.trim()) {
        result.errors.push('缺少写权限：请先在设置中授权 Zotero（Zotero 10+），并在对话框中选择「始终允许」。');
      } else {
        try {
          await pushAll({ store: opts.store, client, map, library, result });
        } catch (err) {
          if (!isRejectedWriteKey(err)) throw err;
          if (opts.updateConfig) {
            try {
              await opts.updateConfig({ zoteroApiKey: '' });
            } catch (clearErr) {
              // Dropping the burned key is best-effort; the sync error still stands.
              console.warn('[dsh-scholar] failed to clear expired Zotero key:', clearErr instanceof Error ? clearErr.message : clearErr);
            }
          }
          result.ok = false;
          result.errors.push(WRITE_KEY_REJECTED);
        }
      }
    }

    await saveMap(opts.store.dir, map);
    result.cursor = { serverId: map.serverId, version: map.cursorVersion };
  } catch (err) {
    result.ok = false;
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  result.durationMs = Date.now() - started;
  result.ok = result.ok && result.errors.length === 0;
  result.finishedAt = Date.now();
  try {
    await saveLastSync(opts.store.dir, result);
  } catch { /* status file is best-effort */ }
  return result;
}

async function pullAll(ctx: {
  store: PaperStore;
  client: ZoteroHttpClient;
  map: ZoteroMapFile;
  library: string;
  result: ZoteroSyncResult;
}): Promise<void> {
  const { store, client, map, library, result } = ctx;
  const now = Date.now();

  // 一次性迁移：在「标注挂在 PDF 附件下」这条链路修好之前，老高光的版本号早已被
  // 游标越过，增量同步再也看不到它们。抬升 schema 版本并把游标清零，让本次同步做
  // 一次全量重扫——论文会被逐个重新访问，从而补回附件里的高光。
  if ((map.schemaVersion ?? 0) < ZOTERO_MAP_SCHEMA) {
    map.cursorVersion = 0;
    map.schemaVersion = ZOTERO_MAP_SCHEMA;
  }

  // Collections
  const zCols = await client.listCollections(library);
  const keyToColId = new Map<string, string>();
  for (const zc of zCols) {
    const data = itemData(zc);
    const name = str(data.name).trim();
    if (!name) continue;
    const key = zc.key || str(data.key);
    const version = Number(zc.version ?? data.version) || 0;
    const mapped = findByZotero(map, 'collection', key);
    let col: PaperCollection | undefined;
    if (mapped) col = store.collections.get(mapped.scholarId);
    if (!col) {
      col = [...store.collections.values()].find((c) => c.name.toLowerCase() === name.toLowerCase());
    }
    if (!col) {
      const created = await store.upsertCollection(name);
      col = created.collection;
      result.pulled.collections++;
    } else if (col.name !== name || col.zoteroKey !== key) {
      const next = await store.patchCollection(col.id, {
        name, zoteroKey: key, zoteroVersion: version, updatedAt: now,
      });
      col = next ?? col;
      result.pulled.collections++;
    }
    keyToColId.set(key, col.id);
    upsertEntry(map, {
      kind: 'collection',
      scholarId: col.id,
      zoteroKey: key,
      zoteroVersion: version,
      scholarUpdatedAt: col.updatedAt,
    });
  }
  await store.persistCollections();

  // Items (top-level research items); incremental when cursor is set
  const since = map.cursorVersion > 0 ? map.cursorVersion : 0;
  const items = await client.listItemsSince(library, since)
    .catch(() => client.listAllItems(library).catch(() => client.listItems(library)));
  let maxVersion = map.cursorVersion;
  for (const obj of items) {
    const data = itemData(obj);
    const itemType = str(data.itemType);
    const key = obj.key || str(data.key);
    const version = Number(obj.version ?? data.version) || 0;
    if (version > maxVersion) maxVersion = version;

    // Child-type changes in incremental mode → refresh parent paper children
    if (itemType === 'attachment' || itemType === 'note' || itemType === 'annotation') {
      const parentKey = str(data.parentItem);
      if (!parentKey) continue;
      // 标注/附件的 parentItem 是 PDF 附件而不是论文：附件条目本身就记着所属论文
      // （kind='attachment', scholarId=paper.id），只按 'paper' 查会永远落空，
      // 于是增量同步里新划的高光被静默丢掉。
      const parentMapped = findByZotero(map, 'paper', parentKey)
        ?? findByZotero(map, 'attachment', parentKey);
      const parentPaper = parentMapped ? store.papers.get(parentMapped.scholarId) : undefined;
      if (parentPaper) {
        await pullChildren({ store, client, map, library, paper: parentPaper, parentKey, result, now });
      }
      continue;
    }
    if (!itemType) continue;

    const incoming = paperFromZotero(obj, now);
    if (!incoming) continue;

    // Map collections
    const zColKeys = Array.isArray(data.collections) ? data.collections.map(String) : [];
    const collectionIds = zColKeys.map((k) => keyToColId.get(k)).filter((x): x is string => !!x);
    if (collectionIds.length) incoming.collectionIds = collectionIds;

    const mapped = findByZotero(map, 'paper', key);
    let existing = mapped ? store.papers.get(mapped.scholarId) : undefined;
    if (!existing) {
      existing = findDuplicate(store.papers.values(), {
        title: incoming.title,
        arxivId: incoming.arxivId,
        doi: incoming.doi,
      });
    }

    if (existing) {
      const zTime = zoteroDateMs(data);
      const mappedVer = mapped?.zoteroVersion ?? -1;
      // Unchanged on Zotero side since last sync
      if (mappedVer === version && existing.zoteroKey === key) {
        await pullChildren({ store, client, map, library, paper: existing, parentKey: key, result, now });
        continue;
      }
      // Scholar edited after last sync and is newer than Zotero — keep local, log conflict
      if (mapped && existing.updatedAt > mapped.scholarUpdatedAt && existing.updatedAt > zTime && mappedVer === version) {
        await pullChildren({ store, client, map, library, paper: existing, parentKey: key, result, now });
        continue;
      }
      if (mapped && existing.updatedAt > zTime && mappedVer !== version) {
        await appendConflict(store.dir, {
          kind: 'paper', scholarId: existing.id, zoteroKey: key,
          winner: 'scholar', loser: { title: incoming.title, version },
        });
        result.conflicts++;
        upsertEntry(map, {
          kind: 'paper', scholarId: existing.id, zoteroKey: key, zoteroVersion: version,
          scholarUpdatedAt: existing.updatedAt,
        });
        await pullChildren({ store, client, map, library, paper: existing, parentKey: key, result, now });
        continue;
      }
      const merged: Paper = {
        ...existing,
        title: incoming.title || existing.title,
        authors: incoming.authors.length ? incoming.authors : existing.authors,
        year: incoming.year ?? existing.year,
        venue: incoming.venue ?? existing.venue,
        arxivId: incoming.arxivId ?? existing.arxivId,
        doi: incoming.doi ?? existing.doi,
        url: incoming.url ?? existing.url,
        abstract: incoming.abstract ?? existing.abstract,
        tags: incoming.tags.length ? incoming.tags : existing.tags,
        collectionIds: collectionIds.length ? collectionIds : existing.collectionIds,
        zoteroKey: key,
        zoteroVersion: version,
        updatedAt: now,
      };
      await store.upsertPaper(merged);
      result.pulled.papers++;
      upsertEntry(map, {
        kind: 'paper', scholarId: merged.id, zoteroKey: key, zoteroVersion: version,
        scholarUpdatedAt: merged.updatedAt,
      });
      await pullChildren({ store, client, map, library, paper: merged, parentKey: key, result, now });
    } else {
      await store.upsertPaper(incoming);
      result.pulled.papers++;
      upsertEntry(map, {
        kind: 'paper', scholarId: incoming.id, zoteroKey: key, zoteroVersion: version,
        scholarUpdatedAt: incoming.updatedAt,
      });
      await pullChildren({ store, client, map, library, paper: incoming, parentKey: key, result, now });
    }
  }

  // 高光标注：它们是普通 item（parentItem 指向 PDF 附件），但 **不会** 出现在附件的
  // /children 里——实测 Zotero 7 本地 API 对该端点返回空数组，只能按 itemType 单独列举，
  // 再经附件映射找回所属论文。目前默认关闭，原因见 IMPORT_ZOTERO_ANNOTATIONS。
  if (IMPORT_ZOTERO_ANNOTATIONS) {
    try {
      const annotations = await client.listAnnotations(library, since);
      for (const obj of annotations) {
        const data = itemData(obj);
        const parentKey = str(data.parentItem);
        if (!parentKey) continue;
        const mapped = findByZotero(map, 'attachment', parentKey)
          ?? findByZotero(map, 'paper', parentKey);
        const paper = mapped ? store.papers.get(mapped.scholarId) : undefined;
        if (!paper) continue;
        await applyZoteroAnnotation({ store, map, paper, obj, result, now });
        const v = Number(obj.version ?? data.version) || 0;
        if (v > maxVersion) maxVersion = v;
      }
    } catch (err) {
      result.errors.push(`annotations: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  map.cursorVersion = Math.max(map.cursorVersion, maxVersion);

  // Also advance cursor from library versions endpoint when available
  try {
    const vers = await client.getVersions(library, 0);
    for (const v of Object.values(vers)) {
      const n = Number(v);
      if (n > map.cursorVersion) map.cursorVersion = n;
    }
  } catch { /* optional */ }
}

function zoteroDateMs(data: Record<string, unknown>): number {
  const dm = str(data.dateModified) || str(data.dateAdded);
  const t = Date.parse(dm);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Parse Zotero `annotationPosition` into pageIndex + `[x,y,w,h]` in **PDF** space
 * (origin bottom-left). The reader flips to viewport space when painting.
 */
export function parseAnnotationPosition(data: Record<string, unknown>): { rects?: number[][]; pageIndex: number } {
  return parseZoteroPositionJson(str(data.annotationPosition));
}

/** 把一条 Zotero 标注并入所属论文的高光文件（新增或更新）。 */
async function applyZoteroAnnotation(ctx: {
  store: PaperStore;
  map: ZoteroMapFile;
  paper: Paper;
  obj: ZoteroJsonObject;
  result: ZoteroSyncResult;
  now: number;
}): Promise<void> {
  // 回退期间任何路径都不得写入高光（另一个调用点是附件的 children 跳转）。
  if (!IMPORT_ZOTERO_ANNOTATIONS) return;
  const { store, map, paper, obj, result, now } = ctx;
  const data = itemData(obj);
  const key = obj.key || str(data.key);
  const version = Number(obj.version ?? data.version) || 0;
  const text = str(data.annotationText) || str(data.text) || '';
  const comment = str(data.annotationComment) || str(data.comment) || undefined;
  const color = str(data.annotationColor) || str(data.color) || undefined;
  const pos = parseAnnotationPosition(data);
  const page = Number(str(data.annotationPageLabel) || str(data.pageLabel)) || (pos.pageIndex + 1);
  if (!text && !comment) return;

  const file = await store.getAnnotations(paper.id);
  const mapped = findByZotero(map, 'annotation', key);
  let hit = mapped ? file.highlights.find((h) => h.id === mapped.scholarId) : undefined;
  if (!hit) hit = file.highlights.find((h) => h.zoteroKey === key);

  if (!hit) {
    const hl: PaperHighlight = {
      id: `hl_${Date.now().toString(36)}${randomUUID().slice(0, 4)}`,
      page, text, comment, color, rects: pos.rects, coordSpace: 'pdf', zoteroKey: key,
      createdAt: now, updatedAt: now,
    };
    file.highlights.push(hl);
    file.updatedAt = now;
    await store.saveAnnotations(file);
    result.pulled.annotations++;
    upsertEntry(map, {
      kind: 'annotation', scholarId: hl.id, zoteroKey: key, zoteroVersion: version,
      scholarUpdatedAt: now, parentScholarId: paper.id,
    });
    return;
  }

  // 几何也算变化：Zotero 里重新划过（文字没变、框变了）时同样要刷到阅读台。
  const rectsChanged = JSON.stringify(hit.rects ?? null) !== JSON.stringify(pos.rects ?? null);
  if (hit.zoteroKey !== key || hit.text !== text || rectsChanged) {
    hit.text = text || hit.text;
    hit.comment = comment ?? hit.comment;
    hit.color = color ?? hit.color;
    hit.page = page || hit.page;
    if (pos.rects) {
      hit.rects = pos.rects;
      hit.coordSpace = 'pdf';
    }
    hit.zoteroKey = key;
    hit.updatedAt = now;
    file.updatedAt = now;
    await store.saveAnnotations(file);
    result.pulled.annotations++;
    upsertEntry(map, {
      kind: 'annotation', scholarId: hit.id, zoteroKey: key, zoteroVersion: version,
      scholarUpdatedAt: now, parentScholarId: paper.id,
    });
  }
}

async function pullChildren(ctx: {
  store: PaperStore;
  client: ZoteroHttpClient;
  map: ZoteroMapFile;
  library: string;
  paper: Paper;
  parentKey: string;
  result: ZoteroSyncResult;
  now: number;
  /**
   * 只处理 annotation 子项。附件那一层跳转用它：附件之下只可能有高光，
   * 这样既不会误入附件/笔记分支，也不可能递归回附件形成环。
   */
  annotationsOnly?: boolean;
}): Promise<void> {
  const { store, client, map, library, paper, parentKey, result, now, annotationsOnly = false } = ctx;
  let children: ZoteroJsonObject[] = [];
  try {
    children = await client.getChildren(parentKey, library);
  } catch (err) {
    result.errors.push(`children ${parentKey}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  for (const child of children) {
    const data = itemData(child);
    const itemType = str(data.itemType);
    const key = child.key || str(data.key);
    const version = Number(child.version ?? data.version) || 0;
    if (annotationsOnly && itemType !== 'annotation') continue;

    if (itemType === 'attachment') {
      // Zotero 的高光标注是 **PDF 附件** 的子项，不是论文的子项。不跳这一层，
      // 用户在 Zotero 里划的高光永远不会进入阅读台——附件先取自己的标注，再处理 PDF。
      await pullChildren({ store, client, map, library, paper, parentKey: key, result, now, annotationsOnly: true });
      const contentType = str(data.contentType);
      const linkMode = str(data.linkMode);
      if (!contentType.includes('pdf') && !str(data.filename).toLowerCase().endsWith('.pdf')) continue;
      if (linkMode === 'linked_file') {
        // Record path only — no copy
        const path = str(data.path);
        if (path && !paper.pdfPath) {
          // skip linked files into store
        }
        upsertEntry(map, {
          kind: 'attachment', scholarId: paper.id, zoteroKey: key, zoteroVersion: version,
          scholarUpdatedAt: paper.updatedAt, parentScholarId: paper.id,
        });
        continue;
      }
      // Pull stored PDF when scholar is missing the file
      const needPull = !paper.pdfPath || !(await pathExists(join(store.dir, paper.pdfPath)));
      if (needPull) {
        const fileUrl = await client.attachmentFileUrl(key, library);
        if (fileUrl) {
          try {
            let bytes: Buffer | null = null;
            if (fileUrl.startsWith('file://') || /^[A-Za-z]:\\/.test(fileUrl) || fileUrl.startsWith('/')) {
              const fsPath = fileUrl.startsWith('file://')
                ? decodeURIComponent(fileUrl.replace(/^file:\/\//, '').replace(/^\/([A-Za-z]:)/, '$1'))
                : fileUrl;
              bytes = await readFile(fsPath);
            } else {
              const res = await fetch(fileUrl);
              if (res.ok) bytes = Buffer.from(await res.arrayBuffer());
            }
            if (bytes && bytes.subarray(0, 4).toString('latin1') === '%PDF') {
              const rel = canonicalPdfRel(paper.id);
              const abs = join(store.dir, rel);
              await mkdir(join(store.dir, 'attachments'), { recursive: true });
              const tmp = `${abs}.${randomUUID().slice(0, 8)}.tmp`;
              await writeFile(tmp, bytes);
              await rename(tmp, abs);
              const next: Paper = { ...paper, pdfPath: rel, updatedAt: now };
              await store.upsertPaper(next);
              Object.assign(paper, next);
              result.pulled.pdfs++;
              upsertEntry(map, {
                kind: 'attachment', scholarId: paper.id, zoteroKey: key, zoteroVersion: version,
                scholarUpdatedAt: next.updatedAt, parentScholarId: paper.id,
                contentHash: md5Hex(bytes),
              });
            }
          } catch (err) {
            result.errors.push(`pdf pull ${key}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      continue;
    }

    if (itemType === 'note') {
      const html = str(data.note);
      const text = stripHtml(html);
      if (html.includes(CARD_MARKER) || text.includes(CARD_MARKER.replace(/[<>!-]/g, ''))) {
        const parsed = parseCardNote(html);
        if (parsed) {
          const scholarId = parsed.meta.scholarId;
          let card = scholarId ? store.cards.get(scholarId) : undefined;
          const mapped = findByZotero(map, 'card', key);
          if (!card && mapped) card = store.cards.get(mapped.scholarId);
          if (!card) {
            card = createCard({
              title: parsed.title,
              insight: parsed.insight || parsed.title,
              paperId: paper.id,
              category: (parsed.meta.category as IdeaCard['category']) || 'other',
              status: (parsed.meta.status as IdeaCard['status']) || 'pending',
              importance: Number(parsed.meta.importance) || 3,
              tags: (parsed.meta.tags || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean),
              plain: parsed.meta.plain,
              evidence: parsed.meta.evidence,
              notes: parsed.meta.notes,
            }, now);
            card.zoteroKey = key;
            card.zoteroVersion = version;
            await store.upsertCard(card);
            result.pulled.cards++;
          } else if ((card.zoteroVersion ?? -1) !== version) {
            const next: IdeaCard = {
              ...card,
              title: parsed.title || card.title,
              insight: parsed.insight || card.insight,
              paperId: paper.id,
              zoteroKey: key,
              zoteroVersion: version,
              updatedAt: now,
            };
            await store.upsertCard(next);
            result.pulled.cards++;
            card = next;
          }
          upsertEntry(map, {
            kind: 'card', scholarId: card.id, zoteroKey: key, zoteroVersion: version,
            scholarUpdatedAt: card.updatedAt, parentScholarId: paper.id,
          });
        }
      } else {
        // Main paper note
        const noteText = text;
        if (noteText && (!paper.notes || (paper.zoteroVersion ?? 0) < version)) {
          const next: Paper = { ...paper, notes: noteText, updatedAt: now };
          await store.upsertPaper(next);
          Object.assign(paper, next);
          result.pulled.notes++;
        }
        upsertEntry(map, {
          kind: 'note', scholarId: paper.id, zoteroKey: key, zoteroVersion: version,
          scholarUpdatedAt: paper.updatedAt, parentScholarId: paper.id,
        });
      }
      continue;
    }

    if (itemType === 'annotation') {
      await applyZoteroAnnotation({ store, map, paper, obj: child, result, now });
    }
  }
}

async function pushAll(ctx: {
  store: PaperStore;
  client: ZoteroHttpClient;
  map: ZoteroMapFile;
  library: string;
  result: ZoteroSyncResult;
}): Promise<void> {
  const { store, client, map, library, result } = ctx;

  // Ensure Ideas collection
  let ideasKey = findByScholar(map, 'collection', '__ideas__')?.zoteroKey;
  if (!ideasKey) {
    const existing = [...store.collections.values()].find((c) => c.name === IDEAS_COLLECTION);
    const mapped = existing ? findByScholar(map, 'collection', existing.id) : undefined;
    ideasKey = mapped?.zoteroKey;
  }
  if (!ideasKey) {
    try {
      const created = await client.createCollections([{ name: IDEAS_COLLECTION }], library);
      const first = Object.values(created.successful)[0];
      if (first) {
        ideasKey = first.key;
        const col = await store.upsertCollection(IDEAS_COLLECTION);
        upsertEntry(map, {
          kind: 'collection',
          scholarId: col.collection.id,
          zoteroKey: first.key,
          zoteroVersion: created.version,
          scholarUpdatedAt: col.collection.updatedAt,
        });
        // also mark synthetic
        upsertEntry(map, {
          kind: 'collection',
          scholarId: '__ideas__',
          zoteroKey: first.key,
          zoteroVersion: created.version,
          scholarUpdatedAt: Date.now(),
        });
        result.pushed.collections++;
      }
    } catch (err) {
      recordPushError(result, 'ideas collection', err);
    }
  }

  // Push collections
  for (const col of store.listCollections()) {
    if (col.name === IDEAS_COLLECTION) continue;
    const mapped = findByScholar(map, 'collection', col.id);
    try {
      if (!mapped) {
        const created = await client.createCollections([{ name: col.name }], library);
        const first = Object.values(created.successful)[0];
        if (first) {
          await store.patchCollection(col.id, {
            zoteroKey: first.key, zoteroVersion: created.version,
          });
          upsertEntry(map, {
            kind: 'collection', scholarId: col.id, zoteroKey: first.key,
            zoteroVersion: created.version, scholarUpdatedAt: col.updatedAt,
          });
          result.pushed.collections++;
        }
      } else if (col.updatedAt > mapped.scholarUpdatedAt) {
        const ver = await client.patchCollection(mapped.zoteroKey, { name: col.name }, mapped.zoteroVersion, library);
        await store.patchCollection(col.id, { zoteroVersion: ver });
        upsertEntry(map, {
          kind: 'collection', scholarId: col.id, zoteroKey: mapped.zoteroKey,
          zoteroVersion: ver, scholarUpdatedAt: col.updatedAt,
        });
        result.pushed.collections++;
      }
    } catch (err) {
      recordPushError(result, `push collection ${col.name}`, err);
    }
  }

  const colKeyById = new Map<string, string>();
  for (const e of map.entries.filter((x) => x.kind === 'collection')) {
    colKeyById.set(e.scholarId, e.zoteroKey);
  }

  // Push papers
  for (const paper of store.papers.values()) {
    const mapped = findByScholar(map, 'paper', paper.id);
    const collectionKeys = (paper.collectionIds ?? [])
      .map((id) => colKeyById.get(id))
      .filter((x): x is string => !!x);
    try {
      if (!mapped) {
        const data = paperToZoteroData(paper, collectionKeys);
        const created = await client.createItems([data], library);
        const first = Object.values(created.successful)[0];
        if (!first) {
          const fail = Object.values(created.failed)[0];
          result.errors.push(`push paper ${paper.id}: ${fail || 'unknown'}`);
          continue;
        }
        const key = first.key;
        const version = created.version;
        await store.upsertPaper({ ...paper, zoteroKey: key, zoteroVersion: version });
        upsertEntry(map, {
          kind: 'paper', scholarId: paper.id, zoteroKey: key, zoteroVersion: version,
          scholarUpdatedAt: paper.updatedAt,
        });
        result.pushed.papers++;
        await pushPaperChildren({ store, client, map, library, paper: { ...paper, zoteroKey: key, zoteroVersion: version }, parentKey: key, ideasKey, result });
      } else if (paper.updatedAt > mapped.scholarUpdatedAt || (paper.zoteroVersion ?? 0) !== mapped.zoteroVersion) {
        const data = paperToZoteroData(paper, collectionKeys);
        const ver = await client.patchItem(mapped.zoteroKey, data, mapped.zoteroVersion, library);
        await store.upsertPaper({ ...paper, zoteroKey: mapped.zoteroKey, zoteroVersion: ver });
        upsertEntry(map, {
          kind: 'paper', scholarId: paper.id, zoteroKey: mapped.zoteroKey, zoteroVersion: ver,
          scholarUpdatedAt: paper.updatedAt,
        });
        result.pushed.papers++;
        await pushPaperChildren({ store, client, map, library, paper: { ...paper, zoteroKey: mapped.zoteroKey, zoteroVersion: ver }, parentKey: mapped.zoteroKey, ideasKey, result });
      } else {
        await pushPaperChildren({ store, client, map, library, paper: { ...paper, zoteroKey: mapped.zoteroKey, zoteroVersion: mapped.zoteroVersion }, parentKey: mapped.zoteroKey, ideasKey, result });
      }
    } catch (err) {
      recordPushError(result, `push paper ${paper.id}`, err);
    }
  }

  // Orphan idea cards (no paper) → Ideas collection notes
  for (const card of store.cards.values()) {
    if (card.paperId && store.papers.has(card.paperId)) continue;
    const mapped = findByScholar(map, 'card', card.id);
    try {
      if (!mapped && ideasKey) {
        const data = {
          itemType: 'note',
          note: cardToNoteBody(card),
          parentItem: '',
          collections: [ideasKey],
          tags: tagsToZotero(card.tags),
          relations: {},
        };
        // Standalone notes use collections not parentItem
        delete (data as { parentItem?: string }).parentItem;
        const created = await client.createItems([data], library);
        const first = Object.values(created.successful)[0];
        if (first) {
          await store.upsertCard({ ...card, zoteroKey: first.key, zoteroVersion: created.version });
          upsertEntry(map, {
            kind: 'card', scholarId: card.id, zoteroKey: first.key, zoteroVersion: created.version,
            scholarUpdatedAt: card.updatedAt,
          });
          result.pushed.cards++;
        }
      } else if (mapped && card.updatedAt > mapped.scholarUpdatedAt) {
        const ver = await client.patchItem(mapped.zoteroKey, {
          note: cardToNoteBody(card),
          tags: tagsToZotero(card.tags),
        }, mapped.zoteroVersion, library);
        await store.upsertCard({ ...card, zoteroKey: mapped.zoteroKey, zoteroVersion: ver });
        upsertEntry(map, {
          kind: 'card', scholarId: card.id, zoteroKey: mapped.zoteroKey, zoteroVersion: ver,
          scholarUpdatedAt: card.updatedAt,
        });
        result.pushed.cards++;
      }
    } catch (err) {
      recordPushError(result, `push card ${card.id}`, err);
    }
  }
}

async function pushPaperChildren(ctx: {
  store: PaperStore;
  client: ZoteroHttpClient;
  map: ZoteroMapFile;
  library: string;
  paper: Paper;
  parentKey: string;
  ideasKey?: string;
  result: ZoteroSyncResult;
}): Promise<void> {
  const { store, client, map, library, paper, parentKey, result } = ctx;

  // Notes
  if (paper.notes?.trim()) {
    const mapped = findByScholar(map, 'note', paper.id);
    const noteBody = noteHtml(`${NOTE_MARKER}\n${paper.notes}`, NOTE_MARKER);
    try {
      if (!mapped) {
        const created = await client.createItems([{
          itemType: 'note',
          note: noteBody,
          parentItem: parentKey,
          tags: [],
          relations: {},
        }], library);
        const first = Object.values(created.successful)[0];
        if (first) {
          upsertEntry(map, {
            kind: 'note', scholarId: paper.id, zoteroKey: first.key, zoteroVersion: created.version,
            scholarUpdatedAt: paper.updatedAt, parentScholarId: paper.id,
          });
          result.pushed.notes++;
        }
      } else if (paper.updatedAt > mapped.scholarUpdatedAt) {
        const ver = await client.patchItem(mapped.zoteroKey, { note: noteBody }, mapped.zoteroVersion, library);
        upsertEntry(map, {
          kind: 'note', scholarId: paper.id, zoteroKey: mapped.zoteroKey, zoteroVersion: ver,
          scholarUpdatedAt: paper.updatedAt, parentScholarId: paper.id,
        });
        result.pushed.notes++;
      }
    } catch (err) {
      recordPushError(result, `push note ${paper.id}`, err);
    }
  }

  // Cards linked to this paper
  for (const card of store.cards.values()) {
    if (card.paperId !== paper.id) continue;
    const mapped = findByScholar(map, 'card', card.id);
    try {
      if (!mapped) {
        const created = await client.createItems([{
          itemType: 'note',
          note: cardToNoteBody(card),
          parentItem: parentKey,
          tags: tagsToZotero(card.tags),
          relations: {},
        }], library);
        const first = Object.values(created.successful)[0];
        if (first) {
          await store.upsertCard({ ...card, zoteroKey: first.key, zoteroVersion: created.version });
          upsertEntry(map, {
            kind: 'card', scholarId: card.id, zoteroKey: first.key, zoteroVersion: created.version,
            scholarUpdatedAt: card.updatedAt, parentScholarId: paper.id,
          });
          result.pushed.cards++;
        }
      } else if (card.updatedAt > mapped.scholarUpdatedAt) {
        const ver = await client.patchItem(mapped.zoteroKey, {
          note: cardToNoteBody(card),
          tags: tagsToZotero(card.tags),
        }, mapped.zoteroVersion, library);
        await store.upsertCard({ ...card, zoteroKey: mapped.zoteroKey, zoteroVersion: ver });
        upsertEntry(map, {
          kind: 'card', scholarId: card.id, zoteroKey: mapped.zoteroKey, zoteroVersion: ver,
          scholarUpdatedAt: card.updatedAt, parentScholarId: paper.id,
        });
        result.pushed.cards++;
      }
    } catch (err) {
      recordPushError(result, `push card ${card.id}`, err);
    }
  }

  // PDF attachment
  const bytes = await readPdfBytes(store, paper);
  if (bytes) {
    const mapped = findByScholar(map, 'attachment', paper.id);
    const hash = md5Hex(bytes);
    try {
      if (!mapped) {
        const created = await client.createItems([{
          itemType: 'attachment',
          linkMode: 'imported_file',
          title: basename(paper.pdfPath || `${paper.id}.pdf`),
          contentType: 'application/pdf',
          filename: basename(paper.pdfPath || `${safeName(paper.id)}.pdf`),
          parentItem: parentKey,
          tags: [],
          relations: {},
        }], library);
        const first = Object.values(created.successful)[0];
        if (first) {
          await client.uploadFile({
            attachmentKey: first.key,
            filename: basename(paper.pdfPath || `${safeName(paper.id)}.pdf`),
            bytes,
            mtimeMs: paper.updatedAt,
            library,
            ifNoneMatch: true,
          });
          upsertEntry(map, {
            kind: 'attachment', scholarId: paper.id, zoteroKey: first.key, zoteroVersion: created.version,
            scholarUpdatedAt: paper.updatedAt, parentScholarId: paper.id, contentHash: hash,
          });
          result.pushed.pdfs++;
        }
      } else if (mapped.contentHash !== hash) {
        await client.uploadFile({
          attachmentKey: mapped.zoteroKey,
          filename: basename(paper.pdfPath || `${safeName(paper.id)}.pdf`),
          bytes,
          mtimeMs: paper.updatedAt,
          library,
          ifMatchMd5: mapped.contentHash,
        }).catch(async () => client.uploadFile({
          attachmentKey: mapped.zoteroKey,
          filename: basename(paper.pdfPath || `${safeName(paper.id)}.pdf`),
          bytes,
          mtimeMs: paper.updatedAt,
          library,
          ifNoneMatch: true,
        }));
        upsertEntry(map, {
          ...mapped, contentHash: hash, scholarUpdatedAt: paper.updatedAt,
        });
        result.pushed.pdfs++;
      }
    } catch (err) {
      recordPushError(result, `push pdf ${paper.id}`, err);
    }
  }

  // Annotations — need parent attachment key
  const att = findByScholar(map, 'attachment', paper.id);
  if (att) {
    const file = await store.getAnnotations(paper.id);
    for (const hl of file.highlights) {
      const mapped = findByScholar(map, 'annotation', hl.id) || (hl.zoteroKey ? findByZotero(map, 'annotation', hl.zoteroKey) : undefined);
      try {
        const data: Record<string, unknown> = {
          itemType: 'annotation',
          parentItem: att.zoteroKey,
          annotationType: 'highlight',
          annotationText: hl.text,
          annotationComment: hl.comment || '',
          annotationColor: hl.color || '#ffd400',
          annotationPageLabel: String(hl.page),
          tags: [],
          relations: {},
        };
        if (!mapped) {
          const created = await client.createItems([data], library);
          const first = Object.values(created.successful)[0];
          if (first) {
            hl.zoteroKey = first.key;
            hl.updatedAt = Date.now();
            await store.saveAnnotations(file);
            upsertEntry(map, {
              kind: 'annotation', scholarId: hl.id, zoteroKey: first.key, zoteroVersion: created.version,
              scholarUpdatedAt: hl.updatedAt, parentScholarId: paper.id,
            });
            result.pushed.annotations++;
          }
        } else if (hl.updatedAt > mapped.scholarUpdatedAt) {
          const ver = await client.patchItem(mapped.zoteroKey, {
            annotationText: hl.text,
            annotationComment: hl.comment || '',
            annotationColor: hl.color || '#ffd400',
            annotationPageLabel: String(hl.page),
          }, mapped.zoteroVersion, library);
          upsertEntry(map, {
            kind: 'annotation', scholarId: hl.id, zoteroKey: mapped.zoteroKey, zoteroVersion: ver,
            scholarUpdatedAt: hl.updatedAt, parentScholarId: paper.id,
          });
          result.pushed.annotations++;
        }
      } catch (err) {
        recordPushError(result, `push annotation ${hl.id}`, err);
      }
    }
  }
}
