/**
 * dsh-scholar — REST routes under /scholar/* (host half).
 *
 * NOTE: routes must NOT live under /api — dsh-client-connection owns the
 * /api prefix (RPC bridge) and would swallow them.
 *
 * POST/PUT bodies are forced to application/json. Validation uses schemastery schemas.
 */
import type { Context } from '@deepseek-ai/cordis';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver';
import z from 'schemastery';
import type { CardQuery, CardSort, EvidenceQuery, KnowledgeGraph, Paper, PaperHighlight, PaperQuery, PaperSort, ProjectQuery, ReadStatus, ScholarConfig } from './shared/types.js';
import { EVIDENCE_KINDS } from './shared/types.js';
import type { PaperStore } from './store.js';
import {
  allCardTags, allPaperTags, assertRebuildAllowed, conceptId, conceptSubgraph, filterCards, filterEvidences,
  filterPapers, filterProjects, mergeGraph, safeName,
} from './store.js';
import { applyCardPatch, applyEvidencePatch, applyPaperPatch, applyProjectPatch, createCard, createEvidence, createPaper, createProject, findDuplicate, findSimilarCards } from './domain.js';
import { fetchMetadata } from './metadata.js';
import { getRelatedReport, citeSyncPatch } from './related.js';
import { createReadEngine } from './read/engine.js';
import type { PaperOutcome } from './read/engine.js';
import { runCompare, runCompareEntries } from './read/compare.js';
import { renderCompareHtml } from './read/render.js';
import { archiveReadResult } from './read/archive.js';
import { loadSession, appendQA } from './read/session.js';
import { extractPdfFigures } from './read/figures.js';
import { createFigureReader } from './read/vlm.js';
import { createAsker as createAskerRoute } from './read/ask.js';
import { formatReaderNotes } from './read/catalog.js';
import { bodyMatchIds, indexPdfFile } from './textcache.js';
import { translateAcademicSelection } from './read/translate.js';
import { readScholarPdfjs } from './pdfjs-assets.js';
import { createJobAbort, type AbortLike, isLlmCatalogService, isRecord } from './read/types.js';
import { authorizeZotero, getSyncStatus, runSync } from './zotero/engine.js';
import { loadMap } from './zotero/map.js';
import type { ZoteroSyncDirection } from './shared/types.js';
import { searchOpenAlex } from './search.js';
import { ingestSearchHit, importBibtexBlob, syncAllToObsidian, syncPaperToObsidian } from './workflow.js';
import {
  getTabletShare,
  mintTabletShare,
  tabletShareBases,
  tabletShareQrSvg,
} from './tabletShare.js';
import { decideChoiceWithPrefer, scholarPreferFromConfig } from './jev-prefer.js';

const PDF_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Resolve a paper's PDF on disk.
 * Metadata may store human-readable names (`attachments/Depth Anything V2.pdf`)
 * from imports; uploads use `attachments/<safeName(id)>.pdf`. Always honor
 * `pdfPath` when present, and never escape the store root.
 */
function resolvePaperPdf(storeDir: string, paper: Pick<Paper, 'id' | 'pdfPath'>): { abs: string; rel: string } | null {
  const root = resolve(storeDir);
  const tryRel = (rel: string): { abs: string; rel: string } | null => {
    const abs = resolve(storeDir, rel);
    const inside = relative(root, abs);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    return { abs, rel: inside.split('\\').join('/') };
  };
  if (paper.pdfPath?.trim()) {
    const hit = tryRel(paper.pdfPath.trim());
    if (hit) return hit;
  }
  return tryRel(join('attachments', `${safeName(paper.id)}.pdf`));
}

/* ---------- UI 启动的后台精读：内存进度注册表（单活动 run，新 run 替换旧 run） ---------- */
export interface ReadRunPaper {
  title: string;
  paperId?: string;
  state: 'pending' | 'running' | 'ok' | 'fail';
  /** 失败时的阶段标签（如「学术精读第 2/5 段」） */
  failedPhase?: string;
  error?: string;
}
export interface ReadRunState {
  id: number;
  mode: 'paper' | 'quick';
  light: boolean;
  focus: string;
  paperIds: string[];
  total: number;
  skipped: number;
  startedAt: number;
  finishedAt: number | null;
  ok: number;
  fail: number;
  papers: ReadRunPaper[];
  /** 引擎 onProgress 的最新一行（"解析 PDF 32%""学术精读第 2/5 段"…） */
  phase: string;
  /** 最后一次失败的原因（供横幅展示，截断 200 字） */
  error: string;
  /** 是否可对失败篇 retry / light 续跑 */
  retryable: boolean;
  suggestLight: boolean;
}
let readRun: ReadRunState | null = null;
let readRunSeq = 0;
/** F12:活动 run 的取消信号——新 run 启动前必须先确认旧 run 已结束或被取消,
 * 防止后台任务重叠消耗模型额度且 UI 只见最后一个;/scholar/read/cancel 可中止。 */
let activeSignal: AbortLike | null = null;
let activeAbort: (() => void) | null = null;
function readRunBusy(): ReadRunState | null {
  if (readRun && readRun.finishedAt === null) return readRun;
  return null;
}
type ReadJobDesc = {
  mode: 'paper' | 'quick';
  light: boolean;
  focus: string;
  autoCompare: boolean;
  paperIds: string[];
};
const readWaiters: ReadJobDesc[] = [];
function beginRunAbort(): AbortLike {
  const job = createJobAbort();
  activeSignal = job.handle;
  activeAbort = job.abort;
  return job.handle;
}
function endRunAbort(): void {
  activeSignal = null;
  activeAbort = null;
}

const PaperInputSchema = z.object({
  title: z.string().required(),
  authors: z.array(z.string()).default([]),
  year: z.number().step(1).min(1900).max(2100),
  venue: z.string().default(''),
  arxivId: z.string().default(''),
  doi: z.string().default(''),
  url: z.string().default(''),
  abstract: z.string().default(''),
  summary: z.string().default(''),
  tags: z.array(z.string()).default([]),
  importance: z.number().step(1).min(1).max(5),
  readStatus: z.union(['want', 'reading', 'done']).default('want'),
  lifecycle: z.union([
    'inbox', 'saved', 'pdf_verified', 'reading', 'read',
    'annotated', 'distilled', 'linked', 'cited', 'archived',
  ]),
  notes: z.string().default(''),
});

/**
 * PUT / dup+update 专用的部分更新 schema：所有字段可选、无默认值——
 * 未提交的字段不会出现在输出里，applyPatch 视为"保持不变"而不是"清空"。
 * （带 default 的全量 schema 会把缺字段填满，PUT {importance:5} 会静默清空 summary/tags。）
 * 导出供冒烟/手工验证脚本直接使用。
 */
export const PaperPatchInputSchema = z.object({
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().step(1).min(1900).max(2100),
  venue: z.string(),
  arxivId: z.string(),
  doi: z.string(),
  url: z.string(),
  abstract: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  importance: z.number().step(1).min(1).max(5),
  readStatus: z.union(['want', 'reading', 'done']),
  lifecycle: z.union([
    'inbox', 'saved', 'pdf_verified', 'reading', 'read',
    'annotated', 'distilled', 'linked', 'cited', 'archived',
  ]),
  notes: z.string(),
});

const CardInputSchema = z.object({
  title: z.string().required(),
  insight: z.string().required(),
  paperId: z.string().default(''),
  category: z.union(['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other']).default('other'),
  tags: z.array(z.string()).default([]),
  importance: z.number().step(1).min(1).max(5).default(3),
  status: z.union(['pending', 'validated', 'adopted', 'dropped']).default('pending'),
  notes: z.string().default(''),
  evidence: z.string().default(''),
  researchQuestion: z.string().default(''),
  hypothesis: z.string().default(''),
  modulesToChange: z.string().default(''),
  dataset: z.string().default(''),
  baseline: z.string().default(''),
  metrics: z.string().default(''),
  risks: z.string().default(''),
  validationResult: z.string().default(''),
});

/** PUT 卡片的部分更新 schema（语义同 PaperPatchInputSchema，无默认值；导出供验证脚本使用）。 */
const CardPatchInputSchema = z.object({
  title: z.string(),
  insight: z.string(),
  paperId: z.string(),
  category: z.union(['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other']),
  tags: z.array(z.string()),
  importance: z.number().step(1).min(1).max(5),
  status: z.union(['pending', 'validated', 'adopted', 'dropped']),
  notes: z.string(),
  evidence: z.string(),
  evidenceIds: z.array(z.string()),
  researchQuestion: z.string(),
  hypothesis: z.string(),
  modulesToChange: z.string(),
  dataset: z.string(),
  baseline: z.string(),
  metrics: z.string(),
  risks: z.string(),
  validationResult: z.string(),
});

const EvidenceInputSchema = z.object({
  claim: z.string().required(),
  paperId: z.string().required(),
  page: z.number().step(1).min(1),
  section: z.string().default(''),
  quotation: z.string().default(''),
  figureOrEquation: z.string().default(''),
  annotationId: z.string().default(''),
  kind: z.union(['author_claim', 'experiment_result', 'inference', 'unverified_transfer']).default('author_claim'),
  confidence: z.number().step(1).min(1).max(5).default(3),
});

const ProjectInputSchema = z.object({
  title: z.string().required(),
  summary: z.string().default(''),
  researchQuestions: z.array(z.string()).default([]),
  paperIds: z.array(z.string()).default([]),
  evidenceIds: z.array(z.string()).default([]),
  ideaCardIds: z.array(z.string()).default([]),
  openProblems: z.array(z.string()).default([]),
});

const ProjectPatchInputSchema = z.object({
  title: z.string(),
  summary: z.string(),
  researchQuestions: z.array(z.string()),
  paperIds: z.array(z.string()),
  evidenceIds: z.array(z.string()),
  ideaCardIds: z.array(z.string()),
  openProblems: z.array(z.string()),
});

/**
 * schemastery 对未提交的可选数组字段会隐式填 []（等效默认值，实测确认），
 * 会把 patch 语义破坏成"清空该字段"。这里把校验输出裁剪为"实际出现在
 * 提交 body 里的字段"：既保留类型校验，又保证 PUT 只动用户提交的字段。
 */
export function pickSubmitted<S extends (data: any) => object>(schema: S, body: Record<string, any>): Partial<ReturnType<S>> {
  const out = { ...(schema(body) as Record<string, unknown>) };
  for (const k of Object.keys(out)) {
    if (!(k in body)) delete out[k];
  }
  return out as Partial<ReturnType<S>>;
}

/** Electron 桌面页来源是 dsh-app://app。网站无法伪造这个 Origin。 */
function isDesktopAppOrigin(origin: URL): boolean {
  return origin.protocol === 'dsh-app:' && origin.hostname === 'app';
}

function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    // F02:严格媒体类型——分号前主类型必须精确等于 application/json;includes 匹配
    // 可被 "text/plain;application/json" 绕过(浏览器简单请求不需预检即可携带)
    const ct = String(req.headers['content-type'] ?? '');
    if (ct.split(';')[0].trim().toLowerCase() !== 'application/json') {
      reject(new Error('请求必须是 application/json'));
      return;
    }
    // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
    const hostRaw = String(req.headers.host ?? '').toLowerCase();
    let hostName = hostRaw;
    if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
    else if (hostName.includes(':')) hostName = hostName.split(':')[0];
    // R17:IPv6 loopback 统一去方括号比较(WHATWG hostname 对 IPv6 带 [::1])
    const normHost = hostName.replace(/^\[/, '').replace(/\]$/, '');
    if (hostName && !['localhost', '127.0.0.1', '::1'].includes(normHost)) {
      reject(new Error('非法 Host'));
      return;
    }
    // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的
    // 简单 CSRF 因此被拒;无 Origin 的非浏览器客户端放行(loopback 对端已校验)
    const origin = String(req.headers.origin ?? '');
    if (origin) {
      try {
        const o = new URL(origin);
        const oHost = (o.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
        const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
        const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
        // 桌面壳的 POST 仍要求 TCP 对端是本机。
        if (isDesktopAppOrigin(o) ? !isLoopbackPeer(req) : (!loopback || !sameOrigin)) {
          reject(new Error('跨源请求被拒绝'));
          return;
        }
      } catch {
        reject(new Error('非法 Origin'));
        return;
      }
    }
    // F10:按字节缓冲、超限即断流、结束时一次性 UTF-8 解码——逐 chunk 字符串拼接会把多字节汉字拆坏
    const chunks: Buffer[] = [];
    let bytes = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      chunks.push(chunk);
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        over = true;
        req.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}
function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/octet-stream')) {
      reject(new Error('上传必须是 application/octet-stream'));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`文件过大（上限 ${Math.floor(maxBytes / 1024 / 1024)}MB）`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, code: number, payload: unknown): void {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** 403 unless loopback。0.1.5 的 Web 认证门不覆盖
 * 插件命名路由,/scholar/* 需要自己的本机围栏 */
function guardRoute(req: import('node:http').IncomingMessage, res: ServerResponse): boolean {
  // F02:Host 必须是回环域——DNS rebinding 把外域解析到 127.0.0.1 时 Host 是外域名
  const hostRaw = String(req.headers.host ?? '').toLowerCase();
  let hostName = hostRaw;
  if (hostName.startsWith('[')) hostName = hostName.slice(1, hostName.includes(']') ? hostName.indexOf(']') : undefined);
  else if (hostName.includes(':')) hostName = hostName.split(':')[0];
  if (hostName && !['localhost', '127.0.0.1', '::1'].includes(hostName)) {
    sendJson(res, 403, { error: '非法 Host' });
    return false;
  }
  // F02:浏览器跨源请求的 Origin 必须与 Host 同源——本机其他端口的页面发起的简单 CSRF 因此被拒
  const origin = String(req.headers.origin ?? '');
  if (origin) {
    try {
      const o = new URL(origin);
      const oHost = (o.hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
      const loopback = oHost === 'localhost' || oHost === '127.0.0.1' || oHost === '::1';
      const sameOrigin = o.host === hostRaw || (oHost === hostName && !o.port && !hostRaw.includes(':'));
      if (!isDesktopAppOrigin(o) && (!loopback || !sameOrigin)) {
        sendJson(res, 403, { error: '跨源请求被拒绝' });
        return false;
      }
    } catch {
      sendJson(res, 403, { error: '非法 Origin' });
      return false;
    }
  }
  if (isLoopbackPeer(req)) return true;
  sendJson(res, 403, { error: '仅允许本机(loopback)访问' });
  return false;
}

function num(s: string | null): number | undefined {
  if (s === null || s === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function pathInfo(req: IncomingMessage, prefix: string): { rest: string; params: URLSearchParams } {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return { rest: u.pathname.slice(prefix.length), params: u.searchParams };
}

export function registerScholarRoutes(
  ctx: Context,
  getStore: () => Promise<PaperStore>,
  getConfig: () => ScholarConfig,
  updateConfig: (patch: Partial<ScholarConfig>) => Promise<{ migrate?: {
    migrated: boolean;
    from: string;
    to: string;
    mode: string;
    moved: number;
    skipped: number;
    removedOld: boolean;
    message: string;
  } }>,
): void {
  /* ---------- config ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/config',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, { config: getConfig() });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as {
            paperDir?: unknown; defaultTags?: unknown; fetchProxy?: unknown; openalexEmail?: unknown;
            researchFocus?: unknown; llmProvider?: unknown; llmModel?: unknown; preferFallback?: unknown;
            jevDecide?: unknown; preferProvider?: unknown; preferModel?: unknown;
            preferBaseURL?: unknown; preferApiKeyEnv?: unknown;
            vlmFigures?: unknown;
            zoteroSyncEnabled?: unknown; zoteroBaseUrl?: unknown; zoteroLibrary?: unknown;
            zoteroApiKey?: unknown; zoteroServerId?: unknown;
            obsidianVault?: unknown; obsidianSubdir?: unknown;
          };
          if (typeof body.paperDir !== 'string' || !body.paperDir.trim()) {
            return sendJson(res, 400, { error: 'paperDir 必须是非空字符串' });
          }
          const patch: Partial<ScholarConfig> = { paperDir: body.paperDir.trim() };
          if (Array.isArray(body.defaultTags)) {
            patch.defaultTags = body.defaultTags.filter((t): t is string => typeof t === 'string');
          }
          if (body.fetchProxy === undefined || typeof body.fetchProxy === 'string') {
            patch.fetchProxy = typeof body.fetchProxy === 'string' ? body.fetchProxy.trim() : '';
          }
          if (body.openalexEmail === undefined || typeof body.openalexEmail === 'string') {
            patch.openalexEmail = typeof body.openalexEmail === 'string' ? body.openalexEmail.trim() : '';
          }
          if (body.researchFocus === undefined || typeof body.researchFocus === 'string') {
            patch.researchFocus = typeof body.researchFocus === 'string' ? body.researchFocus.slice(0, 2000) : '';
          }
          if (body.llmProvider === undefined || typeof body.llmProvider === 'string') {
            patch.llmProvider = typeof body.llmProvider === 'string' ? body.llmProvider.trim().slice(0, 120) : '';
          }
          if (body.llmModel === undefined || typeof body.llmModel === 'string') {
            patch.llmModel = typeof body.llmModel === 'string' ? body.llmModel.trim().slice(0, 200) : '';
          }
          if (typeof body.preferFallback === 'boolean') patch.preferFallback = body.preferFallback;
          if (typeof body.jevDecide === 'boolean') patch.jevDecide = body.jevDecide;
          if (body.preferProvider === undefined || typeof body.preferProvider === 'string') {
            patch.preferProvider = typeof body.preferProvider === 'string' ? body.preferProvider.trim().slice(0, 120) : '';
          }
          if (body.preferModel === undefined || typeof body.preferModel === 'string') {
            patch.preferModel = typeof body.preferModel === 'string' ? body.preferModel.trim().slice(0, 200) : '';
          }
          if (body.preferBaseURL === undefined || typeof body.preferBaseURL === 'string') {
            patch.preferBaseURL = typeof body.preferBaseURL === 'string' ? body.preferBaseURL.trim().slice(0, 400) : '';
          }
          if (body.preferApiKeyEnv === undefined || typeof body.preferApiKeyEnv === 'string') {
            patch.preferApiKeyEnv = typeof body.preferApiKeyEnv === 'string' ? body.preferApiKeyEnv.trim().slice(0, 120) : '';
          }
          if (body.vlmFigures === 'off' || body.vlmFigures === 'auto') {
            patch.vlmFigures = body.vlmFigures;
          }
          if (typeof body.zoteroSyncEnabled === 'boolean') patch.zoteroSyncEnabled = body.zoteroSyncEnabled;
          if (typeof body.zoteroBaseUrl === 'string') patch.zoteroBaseUrl = body.zoteroBaseUrl.trim();
          if (typeof body.zoteroLibrary === 'string') patch.zoteroLibrary = body.zoteroLibrary.trim() || 'user/0';
          if (typeof body.zoteroApiKey === 'string') patch.zoteroApiKey = body.zoteroApiKey.trim();
          if (typeof body.zoteroServerId === 'string') patch.zoteroServerId = body.zoteroServerId.trim();
          if (body.obsidianVault === undefined || typeof body.obsidianVault === 'string') {
            patch.obsidianVault = typeof body.obsidianVault === 'string' ? body.obsidianVault.trim() : '';
          }
          if (body.obsidianSubdir === undefined || typeof body.obsidianSubdir === 'string') {
            patch.obsidianSubdir = typeof body.obsidianSubdir === 'string' && body.obsidianSubdir.trim()
              ? body.obsidianSubdir.trim()
              : 'Scholar';
          }
          const result = await updateConfig(patch);
          sendJson(res, 200, { ok: true, config: getConfig(), migrate: result.migrate });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- LLM catalog for scholar model picker ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/llm-catalog',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const cfg = getConfig();
        const configured = {
          provider: (cfg.llmProvider ?? '').trim(),
          model: (cfg.llmModel ?? '').trim(),
        };
        let agentDefault: { provider: string; model: string } | null = null;
        const sel = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined;
        if (sel && typeof sel.currentSelection === 'function') {
          const s = sel.currentSelection();
          if (isRecord(s) && typeof s.provider === 'string' && typeof s.model === 'string') {
            agentDefault = { provider: s.provider, model: s.model };
          }
        }
        const source = configured.provider && configured.model
          ? 'config'
          : agentDefault
            ? 'agent-default'
            : 'none';
        const effective = source === 'config'
          ? configured
          : source === 'agent-default'
            ? agentDefault
            : { provider: '', model: '' };

        type CatalogModel = { id: string; name: string };
        type CatalogProvider = { id: string; name: string; models: CatalogModel[] };
        const providers: CatalogProvider[] = [];
        const llm = (ctx as { llm?: unknown }).llm;
        if (isLlmCatalogService(llm)) {
          const raw = llm.listProviders();
          for (const p of Array.isArray(raw) ? raw : []) {
            const id = typeof p === 'string'
              ? p
              : (isRecord(p) && typeof p.id === 'string' ? p.id : null);
            if (!id) continue;
            const name = typeof p === 'string'
              ? p
              : (isRecord(p) && typeof p.name === 'string' ? p.name : id);
            let models: CatalogModel[] = [];
            try {
              const ms = await llm.listModels(id);
              models = (Array.isArray(ms) ? ms : []).flatMap((m) => {
                if (typeof m === 'string') return [{ id: m, name: m }];
                if (isRecord(m) && typeof m.id === 'string') {
                  return [{ id: m.id, name: typeof m.name === 'string' ? m.name : m.id }];
                }
                return [];
              });
            } catch {
              models = [];
            }
            providers.push({ id, name, models });
          }
        }
        sendJson(res, 200, { providers, configured, agentDefault, effective, source });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- Optional Jev / System One probe (settings UI) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/jev-probe',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = JSON.parse((await readBody(req)) || '{}') as { text?: unknown };
        const sample = typeof body.text === 'string' && body.text.trim()
          ? body.text.trim().slice(0, 500)
          : 'Probe: choose whether this sample is about literature study.';
        const prefer = scholarPreferFromConfig(getConfig());
        if (!prefer.jevDecide || !prefer.preferProvider || !prefer.preferModel) {
          return sendJson(res, 400, {
            ok: false,
            error: 'Enable Jev and set provider/model in Scholar → Jev API settings first.',
          });
        }
        const detailed = await decideChoiceWithPrefer(
          ctx as never,
          prefer,
          sample,
          {
            id: 'scholar_jev_probe',
            instructions: 'Pick the best label for this short sample. Reply with one option id only.',
            options: {
              study: 'Paper reading / literature study',
              other: 'Something else',
            },
          },
        );
        sendJson(res, 200, {
          ok: detailed.ok,
          value: detailed.ok ? detailed.value : undefined,
          provider: detailed.ok ? detailed.provider : prefer.preferProvider,
          model: detailed.ok ? detailed.model : prefer.preferModel,
          role: detailed.ok ? detailed.role : undefined,
          error: detailed.ok ? undefined : detailed.error,
          attempts: detailed.attempts,
          prefer: {
            jevDecide: prefer.jevDecide,
            preferProvider: prefer.preferProvider,
            preferModel: prefer.preferModel,
            preferBaseURL: prefer.preferBaseURL,
            preferApiKeyEnv: prefer.preferApiKeyEnv,
          },
        });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- Zotero bidirectional sync ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/zotero/status',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        sendJson(res, 200, await getSyncStatus(getConfig(), store));
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/zotero/authorize',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const result = await authorizeZotero(getConfig(), updateConfig);
        sendJson(res, 200, { ok: true, ...result, config: getConfig() });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/zotero/sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = JSON.parse(await readBody(req) || '{}') as { direction?: string };
        const direction = (['pull', 'push', 'both'].includes(body.direction ?? '')
          ? body.direction
          : 'both') as ZoteroSyncDirection;
        const store = await getStore();
        const result = await runSync({
          store,
          cfg: getConfig(),
          direction,
          updateConfig,
        });
        sendJson(res, result.ok ? 200 : 207, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/zotero/map',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        sendJson(res, 200, { map: await loadMap(store.dir) });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- OpenAlex keyword search ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/search',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method === 'GET') {
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
          const q = params.get('q') ?? '';
          const cfg = getConfig();
          const result = await searchOpenAlex({
            q,
            proxy: cfg.fetchProxy,
            email: cfg.openalexEmail,
            perPage: num(params.get('limit')) ?? 12,
          });
          return sendJson(res, 200, result);
        }
        if (req.method === 'POST') {
          // One-click ingest from a search hit
          const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const title = typeof body.title === 'string' ? body.title.trim() : '';
          if (!title) return sendJson(res, 400, { error: '缺少 title' });
          const store = await getStore();
          const out = await ingestSearchHit(store, getConfig(), {
            title,
            authors: Array.isArray(body.authors) ? body.authors.filter((a): a is string => typeof a === 'string') : [],
            year: typeof body.year === 'number' ? body.year : undefined,
            venue: typeof body.venue === 'string' ? body.venue : undefined,
            doi: typeof body.doi === 'string' ? body.doi : undefined,
            arxivId: typeof body.arxivId === 'string' ? body.arxivId : undefined,
            url: typeof body.url === 'string' ? body.url : undefined,
            abstract: typeof body.abstract === 'string' ? body.abstract : undefined,
          }, { fetchPdf: body.fetchPdf !== false });
          return sendJson(res, out.created ? 201 : 200, out);
        }
        return sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- BibTeX import ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/bibtex/import',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const body = JSON.parse(await readBody(req)) as { bibtex?: unknown; text?: unknown };
        const raw = typeof body.bibtex === 'string' ? body.bibtex
          : typeof body.text === 'string' ? body.text : '';
        if (!raw.trim()) return sendJson(res, 400, { error: '缺少 bibtex 文本' });
        if (raw.length > 2 * 1024 * 1024) return sendJson(res, 400, { error: 'BibTeX 过大（≤2MB）' });
        const store = await getStore();
        const result = await importBibtexBlob(store, getConfig(), raw);
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- Obsidian vault sync ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/obsidian/sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        const result = await syncAllToObsidian(store, getConfig());
        sendJson(res, result.errors.length && !result.written ? 400 : 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- stats ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/stats',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        sendJson(res, 200, { ...store.stats(), dir: store.dir });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- PDF 附件命名规范化（可手动重跑；启动时 init 已自动执行） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/attachments/normalize',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        const result = await store.normalizePdfAttachments();
        sendJson(res, 200, result);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- metadata fetch (arXiv / DOI) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/fetch',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
        const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const meta = await fetchMetadata(params.get('input') ?? '', getConfig().fetchProxy || undefined);
        sendJson(res, 200, { meta });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- collections (folders) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/collections',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest } = pathInfo(req, '/scholar/collections');

        if (!rest || rest === '/') {
          if (req.method === 'GET') {
            sendJson(res, 200, { collections: store.listCollections() });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as { name?: unknown; color?: unknown };
            if (typeof body.name !== 'string' || !body.name.trim()) {
              return sendJson(res, 400, { error: 'name 必须是非空字符串' });
            }
            const { collection, existed } = await store.upsertCollection(
              body.name,
              typeof body.color === 'string' && body.color ? body.color : undefined,
            );
            sendJson(res, existed ? 200 : 201, { created: !existed, collection });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as { name?: unknown; color?: unknown };
          const next = await store.renameCollection(id, {
            name: typeof body.name === 'string' ? body.name : undefined,
            color: typeof body.color === 'string' ? body.color : undefined,
          });
          if (!next) return sendJson(res, 404, { error: '分区不存在' });
          sendJson(res, 200, { collection: next });
          return;
        }
        if (req.method === 'DELETE') {
          // membership is stripped from papers; papers themselves are kept
          const ok = await store.deleteCollection(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '分区不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- papers ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/papers',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/papers');

        if (!rest) {
          if (req.method === 'GET') {
            const query: PaperQuery = {
              q: params.get('q') || undefined,
              tag: params.get('tag') || undefined,
              yearFrom: num(params.get('yearFrom')),
              yearTo: num(params.get('yearTo')),
              importance: num(params.get('importance')),
              collection: params.get('collection') || undefined,
              unfiled: params.get('unfiled') === '1' || undefined,
              readStatus: (params.get('readStatus') as ReadStatus) || undefined,
              sort: (params.get('sort') as PaperSort) || undefined,
            };
            // 可选分页：limit/offset（均须为非负整数）；不传 = 全量（默认行为不变）
            const limit = num(params.get('limit'));
            const offset = num(params.get('offset'));
            const badPage = [limit, offset].some((v) => v !== undefined && (!Number.isInteger(v) || v < 0));
            if (badPage) return sendJson(res, 400, { error: 'limit/offset 必须是非负整数' });
            let bodyHitIds: Set<string> | undefined;
            if (query.q && query.q.trim().length >= 2) {
              try { bodyHitIds = await bodyMatchIds(store.dir, query.q); } catch { /* 正文索引不可用时只搜元数据 */ }
            }
            const papers = filterPapers([...store.papers.values()], { ...query, bodyHitIds });
            const page = limit !== undefined || offset !== undefined
              ? papers.slice(offset ?? 0, (offset ?? 0) + (limit ?? papers.length))
              : papers;
            // lite=1：侧栏计数 / BibTeX 索引用，去掉 abstract/summary/notes 降带宽
            const lite = params.get('lite') === '1';
            const out = lite
              ? page.map((p) => ({
                  id: p.id, title: p.title, authors: p.authors, year: p.year, venue: p.venue,
                  tags: p.tags, importance: p.importance, readStatus: p.readStatus,
                  collectionIds: p.collectionIds, pdfPath: p.pdfPath, createdAt: p.createdAt,
                  arxivId: p.arxivId, doi: p.doi, url: p.url,
                }))
              : page;
            sendJson(res, 200, {
              papers: out,
              total: papers.length,
              tags: allPaperTags(store.papers.values()),
            });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req)) as Record<string, any>;
            const input = PaperInputSchema(body);
            // collection membership: only meaningful when caller sends explicit arrays
            const wantCol = Array.isArray(body.collectionIds) || Array.isArray(body.collectionNames);
            const colIds = Array.isArray(body.collectionIds)
              ? store.filterExistingCollectionIds(body.collectionIds as string[])
              : Array.isArray(body.collectionNames)
                ? await store.ensureCollectionNames(body.collectionNames as string[])
                : undefined;

            const dup = findDuplicate(store.papers.values(), input);
            if (dup && !body.update) {
              sendJson(res, 200, { created: false, duplicate: true, paper: dup });
              return;
            }
            if (dup) {
              // 更新走部分更新语义：只合并实际提交的字段，未提交字段保持不变
              const patch = pickSubmitted(PaperPatchInputSchema, body);
              const paper = await store.updatePaperTx(dup.id, cur => applyPaperPatch(cur, {
                ...patch,
                ...(wantCol ? { collectionIds: colIds ?? [] } : {}),
              }));
              if (!paper) return sendJson(res, 404, { error: '论文已删除，请重新保存' });
              sendJson(res, 200, { created: false, duplicate: true, updated: true, paper });
              return;
            }
            const tags = [...new Set([...(getConfig().defaultTags ?? []), ...input.tags])];
            const paper = createPaper({
              ...input, tags, source: 'manual',
              ...(colIds !== undefined ? { collectionIds: colIds } : {}),
            });
            await store.upsertPaper(paper);
            sendJson(res, 201, { created: true, paper });
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        /* ---------- sidecar 查询（透镜 focus 的上下文论文迷你摘要） ---------- */
        const sidecarMatch = /^\/(.+)\/sidecar$/i.exec(rest);
        if (sidecarMatch) {
          if (req.method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return; }
          const pid = decodeURIComponent(sidecarMatch[1]);
          if (!store.papers.get(pid)) return sendJson(res, 404, { error: '论文不存在' });
          try {
            const sidecars = (await readdir(join(store.dir, 'reports')))
              .filter((f) => f.startsWith(`${safeName(pid)}-`) && f.endsWith('.json'))
              .sort();
            const last = sidecars[sidecars.length - 1];
            if (!last) return sendJson(res, 200, { sidecar: null });
            const sc = JSON.parse(await readFile(join(store.dir, 'reports', last), 'utf8'));
            return sendJson(res, 200, { sidecar: sc });
          } catch {
            return sendJson(res, 200, { sidecar: null });
          }
        }

        /* ---------- reading reports (list / serve / delete) ---------- */
        const reportsMatch = /^\/(.+)\/reports(?:\/([^/]+))?$/i.exec(rest);
        if (reportsMatch) {
          const pid = decodeURIComponent(reportsMatch[1]);
          if (!store.papers.get(pid)) return sendJson(res, 404, { error: '论文不存在' });
          const prefix = `${safeName(pid)}-`;
          const reportsDir = join(store.dir, 'reports');

          if (req.method === 'GET' && !reportsMatch[2]) {
            try {
              // 模式解析只读文件头尾各 4KB（新报告 meta 在头；旧报告副标题在头、
              // "精读引擎（" 在尾）——避免为拿模式整读 1.9MB 级大报告
              const readHeadTail = async (f: string): Promise<string> => {
                const full = join(reportsDir, f);
                const st = await stat(full);
                const { open } = await import('node:fs/promises');
                const h = await open(full, 'r');
                try {
                  const headBuf = Buffer.alloc(4096);
                  const tailBuf = Buffer.alloc(4096);
                  await h.read(headBuf, 0, 4096, 0);
                  await h.read(tailBuf, 0, 4096, Math.max(0, st.size - 4096));
                  return headBuf.toString('utf8') + '\n' + tailBuf.toString('utf8');
                } finally {
                  await h.close();
                }
              };
              const files = (await Promise.all(
                (await readdir(reportsDir))
                  .filter((f) => f.endsWith('.html')
                    && (f.startsWith(prefix) || (f.startsWith('cmp-') && f.includes(prefix.replace(/-$/, '')))))
                  .map(async (f) => {
                    const st = await stat(join(reportsDir, f));
                    let mode: 'paper' | 'quick' | 'compare' | '' = '';
                    if (f.startsWith('cmp-')) mode = 'compare';
                    else {
                      try {
                        const fh = await readHeadTail(f);
                        const meta = /<meta name="scholar-report" content="(\w+)">/.exec(fh.slice(0, 4200));
                        if (meta) mode = meta[1] === 'quick' ? 'quick' : 'paper';
                        else if (/精读引擎（(paper|quick)/.test(fh)) mode = /精读引擎（quick/.test(fh) ? 'quick' : 'paper';
                        else if (/学术论文精读/.test(fh)) mode = 'paper';
                        else if (/速读/.test(fh)) mode = 'quick';
                      } catch { /* 读不了就空模式，不阻塞列表 */ }
                    }
                    return { file: f, size: st.size, savedAt: st.mtimeMs, mode };
                  }),
              )).sort((a, b) => b.savedAt - a.savedAt);
              return sendJson(res, 200, { reports: files });
            } catch {
              return sendJson(res, 200, { reports: [] });
            }
          }

          if (req.method === 'GET' && reportsMatch[2]) {
            const fname = safeName(decodeURIComponent(reportsMatch[2]));
            const isFig = fname.startsWith(prefix) && /-fig\d+\.(jpg|png)$/i.test(fname);
            const belongs = fname.startsWith(prefix)
              || (fname.startsWith('cmp-') && fname.includes(prefix.replace(/-$/, '')) && /^cmp-[\w.-]+-\d{9,15}\.html$/.test(fname));
            if (!belongs || (!fname.endsWith('.html') && !isFig)) {
              return sendJson(res, 400, { error: '非法的报告文件名' });
            }
            try {
              const data = await readFile(join(reportsDir, fname));
              res.statusCode = 200;
              if (isFig) {
                res.setHeader('content-type', fname.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg');
                res.setHeader('x-content-type-options', 'nosniff');
                res.setHeader('content-length', data.length);
                res.end(data);
              } else {
                // Harden CJK+Latin prose for legacy reports (no justify / stretch gaps).
                const PROSE_FIX =
                  '<style id="sch-prose-fix">body,p,.tldr,.card,.sc-body,.ev,li,td,blockquote,.sc-body p{'
                  + 'text-align:start!important;text-justify:none!important;'
                  + 'word-spacing:normal!important;letter-spacing:normal!important;'
                  + 'overflow-wrap:break-word;word-break:normal}</style>';
                let html = data.toString('utf8');
                if (!html.includes('id="sch-prose-fix"')) {
                  html = /<\/head>/i.test(html)
                    ? html.replace(/<\/head>/i, `${PROSE_FIX}</head>`)
                    : `${PROSE_FIX}${html}`;
                }
                const out = Buffer.from(html, 'utf8');
                res.setHeader('content-type', 'text/html; charset=utf-8');
                // 报告 HTML 可能含模型生成内容：禁用脚本；allow-same-origin 让外链附图
                // （/scholar/.../reports/*-figN.jpg）按同源带上会话 cookie，避免沙箱唯一源导致图 401/空白。
                res.setHeader('content-security-policy', 'sandbox allow-same-origin');
                res.setHeader('x-content-type-options', 'nosniff');
                res.setHeader('content-length', out.length);
                res.end(out);
              }
            } catch {
              return sendJson(res, 404, { error: '报告文件不存在' });
            }
            return;
          }

          // 删除单份报告（自有报告锚定前缀+时间戳；对比报告锚定 cmp-+本论文 id+时间戳，杜绝路径穿越）
          if (req.method === 'DELETE' && reportsMatch[2]) {
            const fname = safeName(decodeURIComponent(reportsMatch[2]));
            const belongs = (fname.startsWith(prefix) && /^[\w.-]+-\d{9,15}\.html$/.test(fname))
              || (fname.startsWith('cmp-') && fname.includes(prefix.replace(/-$/, '')) && /^cmp-[\w.-]+-\d{9,15}\.html$/.test(fname));
            if (!belongs) {
              return sendJson(res, 400, { error: '非法的报告文件名' });
            }
            try {
              await unlink(join(reportsDir, fname));
              // 顺带清理同名 sidecar（对比原料 JSON）与附图 -figN.jpg/png
              await unlink(join(reportsDir, fname.replace(/\.html$/, '.json'))).catch(() => {});
              if (fname.endsWith('.html') && fname.startsWith(prefix)) {
                const base = fname.slice(0, -'.html'.length);
                try {
                  for (const f of await readdir(reportsDir)) {
                    if (f.startsWith(`${base}-fig`) && /\.(jpg|png)$/i.test(f)) {
                      await unlink(join(reportsDir, f)).catch(() => {});
                    }
                  }
                } catch { /* 附图清理失败不影响删除成功 */ }
              }
              return sendJson(res, 200, { ok: true, deleted: fname });
            } catch {
              return sendJson(res, 404, { error: '报告文件不存在' });
            }
          }

          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- PDF attachment (upload / open) ---------- */
        const pdfMatch = /^\/(.+)\/pdf$/i.exec(rest);
        if (pdfMatch) {
          const pid = decodeURIComponent(pdfMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          // Prefer existing pdfPath (may be a human-readable import name); else canonical safeName.
          const resolved = resolvePaperPdf(store.dir, paper);
          const relPdf = resolved?.rel ?? `attachments/${safeName(pid)}.pdf`;
          const file = resolved?.abs ?? join(store.dir, 'attachments', `${safeName(pid)}.pdf`);

          if (req.method === 'PUT') {
            try {
              const buf = await readRawBody(req, PDF_MAX_BYTES);
              if (buf.length === 0) return sendJson(res, 400, { error: '空文件' });
              // 魔数校验：坏文件入档会让后面的精研读不到 PDF
              if (buf.subarray(0, 4).toString('latin1') !== '%PDF') {
                return sendJson(res, 400, { error: '文件内容不是有效的 PDF（缺少 %PDF 魔数）' });
              }
              const saved = await store.commitPaperArtifacts([paper], async () => {
                await mkdir(join(store.dir, 'attachments'), { recursive: true });
                const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
                await writeFile(tmp, buf);
                await rename(tmp, file).catch(async (err: unknown) => {
                  await unlink(tmp).catch(() => {});
                  throw err;
                });
                return { pdfPath: relPdf };
              }, { id: pid, apply: cur => ({ ...cur, pdfPath: relPdf, updatedAt: Date.now() }) });
              if (!saved) return sendJson(res, 404, { error: '论文不存在' });
              void indexPdfFile(store.dir, pid, file).catch(() => {});
              return sendJson(res, 200, { ok: true, pdfPath: saved.pdfPath });
            } catch (err) {
              return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
            }
          }

          if (req.method === 'GET') {
            if (!paper.pdfPath) return sendJson(res, 404, { error: '该论文没有 PDF 附件' });
            try {
              const info = await stat(file);
              res.statusCode = 200;
              res.setHeader('content-type', 'application/pdf');
              res.setHeader('x-content-type-options', 'nosniff');
              res.setHeader('content-length', info.size);
              // 读取中途失败（文件被删/锁定）时收尾响应，而不是未捕获异常或挂死
              const stream = createReadStream(file);
              stream.on('error', (err) => {
                if (res.headersSent) res.end();
                else sendJson(res, 500, { error: `PDF 读取失败: ${err instanceof Error ? err.message : String(err)}` });
              });
              stream.pipe(res);
            } catch {
              sendJson(res, 404, { error: 'PDF 文件丢失（可重新上传）' });
            }
            return;
          }

          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- One-tap tablet share (mint; public GET is separate) ---------- */
        const tabletShareMatch = /^\/(.+)\/tablet-share$/i.exec(rest);
        if (tabletShareMatch) {
          const pid = decodeURIComponent(tabletShareMatch[1]);
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          if (!paper.pdfPath) return sendJson(res, 404, { error: '该论文没有 PDF 附件' });
          const resolved = resolvePaperPdf(store.dir, paper);
          if (!resolved) return sendJson(res, 404, { error: 'PDF 文件丢失（可重新上传）' });
          try {
            await stat(resolved.abs);
          } catch {
            return sendJson(res, 404, { error: 'PDF 文件丢失（可重新上传）' });
          }
          const port = Number(ctx.webServer.port) || 3080;
          const bindHost = String(ctx.webServer.host ?? '127.0.0.1');
          const bases = tabletShareBases(port, bindHost);
          const minted = mintTabletShare({
            paperId: pid,
            absPath: resolved.abs,
            title: paper.title || pid,
            bases,
          });
          // Always include loopback URL so the PC can preview; tablets need LAN bases.
          const loopUrl = `http://127.0.0.1:${port}/scholar/tablet-share/${minted.token}`;
          const urls = minted.urls.length > 0 ? minted.urls : [loopUrl];
          const primaryUrl = minted.primaryUrl ?? urls[0]!;
          let qrSvg: string | null = null;
          try {
            qrSvg = await tabletShareQrSvg(primaryUrl);
          } catch {
            qrSvg = null;
          }
          return sendJson(res, 200, {
            token: minted.token,
            expiresAt: minted.expiresAt,
            urls,
            primaryUrl,
            lanBound: bases.length > 0,
            bindHost,
            qrSvg,
            title: paper.title || pid,
          });
        }

        /* ---------- PDF annotations (highlights) ---------- */
        const annMatch = /^\/(.+)\/annotations$/i.exec(rest);
        if (annMatch) {
          const pid = decodeURIComponent(annMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          if (req.method === 'GET') {
            const file = await store.getAnnotations(pid);
            return sendJson(res, 200, file);
          }
          if (req.method === 'PUT') {
            const body = JSON.parse(await readBody(req)) as { highlights?: unknown };
            if (!Array.isArray(body.highlights)) return sendJson(res, 400, { error: 'highlights 必须是数组' });
            const highlights = body.highlights.map((h, i): PaperHighlight => {
              const o = (h && typeof h === 'object') ? h as Record<string, unknown> : {};
              const now = Date.now();
              const space: PaperHighlight['coordSpace'] =
                o.coordSpace === 'pdf' || o.coordSpace === 'viewport' ? o.coordSpace : undefined;
              const row: PaperHighlight = {
                id: typeof o.id === 'string' && o.id ? o.id : `hl_${now.toString(36)}${i}`,
                page: Number(o.page) || 1,
                text: String(o.text ?? ''),
                createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
                updatedAt: now,
              };
              if (typeof o.comment === 'string') row.comment = o.comment;
              if (typeof o.color === 'string') row.color = o.color;
              if (Array.isArray(o.rects)) row.rects = o.rects as number[][];
              if (space) row.coordSpace = space;
              if (typeof o.zoteroKey === 'string') row.zoteroKey = o.zoteroKey;
              return row;
            }).filter((h) => h.text.trim() || h.comment?.trim());
            const saved = await store.saveAnnotations({ paperId: pid, highlights, updatedAt: Date.now() });
            try {
              const paper = store.papers.get(pid);
              if (paper) await syncPaperToObsidian(store, paper, getConfig());
            } catch { /* Obsidian best-effort */ }
            return sendJson(res, 200, saved);
          }
          if (req.method === 'POST') {
            // Append one highlight from selection; optional asEvidence elevates to Evidence
            const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
            const text = String(body.text ?? '').trim();
            if (!text) return sendJson(res, 400, { error: '空选段' });
            const now = Date.now();
            const file = await store.getAnnotations(pid);
            const hl = {
              id: `hl_${now.toString(36)}${randomUUID().slice(0, 4)}`,
              page: Number(body.page) || 1,
              text,
              comment: typeof body.comment === 'string' ? body.comment : undefined,
              color: typeof body.color === 'string' ? body.color : '#ffd400',
              rects: Array.isArray(body.rects) ? body.rects as number[][] : undefined,
              coordSpace: body.coordSpace === 'pdf' || body.coordSpace === 'viewport'
                ? body.coordSpace as 'pdf' | 'viewport'
                : 'viewport' as const,
              createdAt: now,
              updatedAt: now,
            };
            file.highlights.push(hl);
            file.updatedAt = now;
            const saved = await store.saveAnnotations(file);
            try {
              if (paper) await syncPaperToObsidian(store, paper, getConfig());
            } catch { /* Obsidian best-effort */ }
            let evidence = null;
            if (body.asEvidence === true) {
              evidence = createEvidence({
                claim: (typeof body.claim === 'string' && body.claim.trim()) ? body.claim.trim() : (hl.comment?.trim() || text.slice(0, 200)),
                paperId: pid,
                page: hl.page,
                quotation: text,
                annotationId: hl.id,
                kind: (EVIDENCE_KINDS as readonly string[]).includes(String(body.kind))
                  ? body.kind as import('./shared/types.js').EvidenceKind
                  : 'author_claim',
                confidence: typeof body.confidence === 'number' ? body.confidence : 3,
              });
              await store.upsertEvidence(evidence);
            }
            return sendJson(res, 200, { highlight: hl, file: saved, ...(evidence ? { evidence } : {}) });
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }

        /* ---------- related papers (OpenAlex discovery, 10min cached) ---------- */
        const relatedMatch = /^\/(.+)\/related$/i.exec(rest);
        if (relatedMatch) {
          if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
          const pid = decodeURIComponent(relatedMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          const report = await getRelatedReport(paper, [...store.papers.values()], getConfig().fetchProxy || undefined);
          return sendJson(res, 200, report);
        }

        /* ---------- Obsidian note for one paper ---------- */
        const obsMatch = /^\/(.+)\/obsidian$/i.exec(rest);
        if (obsMatch) {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
          const pid = decodeURIComponent(obsMatch[1]);
          const paper = store.papers.get(pid);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          const path = await syncPaperToObsidian(store, paper, getConfig());
          if (!path) return sendJson(res, 400, { error: '未配置 Obsidian vault 路径' });
          return sendJson(res, 200, { ok: true, path });
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const paper = store.papers.get(id);
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          // Absolute PDF path when the file exists. The desk reader uses /scholar/papers/:id/pdf.
          let pdfAbsolutePath: string | undefined;
          const resolved = resolvePaperPdf(store.dir, paper);
          if (resolved) {
            try {
              const st = await stat(resolved.abs);
              if (st.isFile()) pdfAbsolutePath = resolved.abs;
            } catch {
              /* missing on disk — omit */
            }
          }
          sendJson(res, 200, {
            paper: pdfAbsolutePath ? { ...paper, pdfAbsolutePath } : paper,
          });
          return;
        }
        if (req.method === 'PUT') {
          const existing = store.papers.get(id);
          if (!existing) return sendJson(res, 404, { error: '论文不存在' });
          const body = JSON.parse(await readBody(req)) as Record<string, any>;
          // PUT 为部分更新语义：只合并实际提交的字段，未提交字段（如 summary/tags）保持不变
          const input = pickSubmitted(PaperPatchInputSchema, body);
          const colIds = Array.isArray(body.collectionIds)
            ? store.filterExistingCollectionIds(body.collectionIds as string[])
            : Array.isArray(body.collectionNames)
              ? await store.ensureCollectionNames(body.collectionNames as string[])
              : undefined;
          // F07:事务化部分更新——持锁内基于最新记录 patch,并发编辑不再互相覆盖
          const paper = await store.updatePaperTx(id, (cur) => applyPaperPatch(cur, {
            ...input,
            ...(colIds !== undefined ? { collectionIds: colIds } : {}),
          }));
          if (!paper) return sendJson(res, 404, { error: '论文不存在' });
          sendJson(res, 200, { paper });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.deletePaper(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '论文不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- idea cards ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/cards',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/cards');

        if (!rest) {
          if (req.method === 'GET') {
            const query: CardQuery = {
              q: params.get('q') || undefined,
              category: (params.get('category') as CardQuery['category']) || undefined,
              tag: params.get('tag') || undefined,
              importance: num(params.get('importance')),
              status: (params.get('status') as CardQuery['status']) || undefined,
              paperId: params.get('paperId') || undefined,
              sort: (params.get('sort') as CardSort) || undefined,
            };
            const cards = filterCards([...store.cards.values()], query);
            sendJson(res, 200, { cards, tags: allCardTags(store.cards.values()) });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const input = CardInputSchema(body);
            if (input.paperId && !store.papers.has(input.paperId)) {
              return sendJson(res, 400, { error: `论文 ${input.paperId} 不在论文库中` });
            }
            const relIds = Array.isArray(body.relatedCardIds)
              ? store.filterExistingCardIds(body.relatedCardIds as string[])
              : undefined;
            const card = createCard({
              ...input, paperId: input.paperId || undefined,
              ...(relIds !== undefined ? { relatedCardIds: relIds } : {}),
              ...(body.plain !== undefined ? { plain: String(body.plain) } : {}),
              ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}),
              ...(body.evidence !== undefined ? { evidence: String(body.evidence) } : {}),
            });
            await store.upsertCard(card);
            // 相似卡提醒（非阻塞）：手动建卡同样提示可能的重复沉淀
            const similar = findSimilarCards([...store.cards.values()], card.title, { excludeId: card.id, paperId: card.paperId });
            sendJson(res, 201, { created: true, card, ...(similar.length ? { similar } : {}) });
            return;
          }
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }

        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const card = store.cards.get(id);
          if (!card) return sendJson(res, 404, { error: '卡片不存在' });
          sendJson(res, 200, { card });
          return;
        }
        if (req.method === 'PUT') {
          const existing = store.cards.get(id);
          if (!existing) return sendJson(res, 404, { error: '卡片不存在' });
          const body = JSON.parse(await readBody(req));
          // PUT 为部分更新语义：只合并实际提交的字段（与工具层 idea_card_update 一致）
          const input = pickSubmitted(CardPatchInputSchema, body);
          if (input.paperId && !store.papers.has(input.paperId)) {
            return sendJson(res, 400, { error: `论文 ${input.paperId} 不在论文库中` });
          }
          const relIds = Array.isArray(body.relatedCardIds)
            ? store.filterExistingCardIds(body.relatedCardIds as string[])
            : undefined;
          const card = applyCardPatch(existing, {
            ...input,
            ...(relIds !== undefined ? { relatedCardIds: relIds } : {}),
            ...(body.plain !== undefined ? { plain: String(body.plain) } : {}),
            ...(Array.isArray(body.steps) ? { steps: body.steps as string[] } : {}),
          });
          await store.upsertCard(card);
          sendJson(res, 200, { card });
          return;
        }
        if (req.method === 'DELETE') {
          const ok = await store.deleteCard(id);
          sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '卡片不存在' });
          return;
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- evidences ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/evidences',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/evidences');
        if (!rest) {
          if (req.method === 'GET') {
            const query: EvidenceQuery = {
              q: params.get('q') || undefined,
              paperId: params.get('paperId') || undefined,
              kind: (params.get('kind') as EvidenceQuery['kind']) || undefined,
              projectId: params.get('projectId') || undefined,
            };
            sendJson(res, 200, { evidences: filterEvidences(store.listEvidences(), query) });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const input = EvidenceInputSchema(body);
            if (!store.papers.has(input.paperId)) {
              return sendJson(res, 400, { error: `论文 ${input.paperId} 不在论文库中` });
            }
            const evidence = createEvidence({
              ...input,
              section: input.section || undefined,
              quotation: input.quotation || undefined,
              figureOrEquation: input.figureOrEquation || undefined,
              annotationId: input.annotationId || undefined,
              ideaCardIds: Array.isArray(body.ideaCardIds) ? body.ideaCardIds as string[] : undefined,
              projectIds: Array.isArray(body.projectIds) ? body.projectIds as string[] : undefined,
            });
            await store.upsertEvidence(evidence);
            sendJson(res, 201, { created: true, evidence });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        const id = decodeURIComponent(rest.slice(1));
        if (!id || id.includes('/')) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const evidence = store.getEvidence(id);
          if (!evidence) return sendJson(res, 404, { error: '证据不存在' });
          return sendJson(res, 200, { evidence });
        }
        if (req.method === 'PUT') {
          const existing = store.getEvidence(id);
          if (!existing) return sendJson(res, 404, { error: '证据不存在' });
          const body = JSON.parse(await readBody(req));
          const evidence = applyEvidencePatch(existing, {
            ...(typeof body.claim === 'string' ? { claim: body.claim } : {}),
            ...(typeof body.paperId === 'string' ? { paperId: body.paperId } : {}),
            ...(body.page !== undefined ? { page: Number(body.page) } : {}),
            ...(body.section !== undefined ? { section: String(body.section) } : {}),
            ...(body.quotation !== undefined ? { quotation: String(body.quotation) } : {}),
            ...(body.figureOrEquation !== undefined ? { figureOrEquation: String(body.figureOrEquation) } : {}),
            ...(body.annotationId !== undefined ? { annotationId: String(body.annotationId) } : {}),
            ...(body.kind !== undefined ? { kind: body.kind } : {}),
            ...(body.confidence !== undefined ? { confidence: Number(body.confidence) } : {}),
            ...(Array.isArray(body.ideaCardIds) ? { ideaCardIds: body.ideaCardIds as string[] } : {}),
            ...(Array.isArray(body.projectIds) ? { projectIds: body.projectIds as string[] } : {}),
          });
          await store.upsertEvidence(evidence);
          return sendJson(res, 200, { evidence });
        }
        if (req.method === 'DELETE') {
          const ok = await store.deleteEvidence(id);
          return sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '证据不存在' });
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- research projects ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/projects',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        const { rest, params } = pathInfo(req, '/scholar/projects');
        if (!rest) {
          if (req.method === 'GET') {
            const query: ProjectQuery = { q: params.get('q') || undefined };
            sendJson(res, 200, { projects: filterProjects(store.listProjects(), query) });
            return;
          }
          if (req.method === 'POST') {
            const body = JSON.parse(await readBody(req));
            const input = ProjectInputSchema(body);
            const project = createProject(input);
            await store.upsertProject(project);
            sendJson(res, 201, { created: true, project });
            return;
          }
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        const segments = rest.slice(1).split('/').filter(Boolean);
        const id = decodeURIComponent(segments[0] ?? '');
        const sub = segments[1] ?? '';
        if (!id) return sendJson(res, 404, { error: 'not found' });

        // POST /scholar/projects/:id/link — merge ids into project
        if (sub === 'link' && req.method === 'POST') {
          const existing = store.getProject(id);
          if (!existing) return sendJson(res, 404, { error: '项目不存在' });
          const body = JSON.parse(await readBody(req)) as {
            paperIds?: string[]; evidenceIds?: string[]; ideaCardIds?: string[];
          };
          const project = applyProjectPatch(existing, {
            paperIds: [...existing.paperIds, ...(Array.isArray(body.paperIds) ? body.paperIds : [])],
            evidenceIds: [...existing.evidenceIds, ...(Array.isArray(body.evidenceIds) ? body.evidenceIds : [])],
            ideaCardIds: [...existing.ideaCardIds, ...(Array.isArray(body.ideaCardIds) ? body.ideaCardIds : [])],
          });
          await store.upsertProject(project);
          return sendJson(res, 200, { project });
        }

        if (sub) return sendJson(res, 404, { error: 'not found' });
        if (req.method === 'GET') {
          const project = store.getProject(id);
          if (!project) return sendJson(res, 404, { error: '项目不存在' });
          return sendJson(res, 200, { project });
        }
        if (req.method === 'PUT') {
          const existing = store.getProject(id);
          if (!existing) return sendJson(res, 404, { error: '项目不存在' });
          const body = JSON.parse(await readBody(req));
          const input = pickSubmitted(ProjectPatchInputSchema, body);
          const project = applyProjectPatch(existing, input);
          await store.upsertProject(project);
          return sendJson(res, 200, { project });
        }
        if (req.method === 'DELETE') {
          const ok = await store.deleteProject(id);
          return sendJson(res, ok ? 200 : 404, ok ? { deleted: true } : { error: '项目不存在' });
        }
        sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- tag auto-sync (heuristic, no AI) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph/auto-sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        const knownIds = new Set(store.papers.keys());
        const papers = [...store.papers.values()];
        // 双同步：论文标签→概念（旧）+ 卡片→想法节点/derives_from/uses/related（新）
        const paperPatch = store.tagSyncPatch(papers);
        const cardPatch = store.cardSyncPatch([...store.cards.values()], papers);
        let graph = mergeGraph(store.graph, paperPatch, 'append', knownIds);
        graph = mergeGraph(graph, cardPatch, 'append', knownIds);
        await store.saveGraph(graph);
        sendJson(res, 200, {
          addedNodes: paperPatch.nodes.length + cardPatch.nodes.length,
          addedEdges: paperPatch.edges.length + cardPatch.edges.length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- citation sync (OpenAlex, cites edges only between library papers) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph/cite-sync',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
        const store = await getStore();
        // 全库扫描可能要几十秒（OpenAlex 逐篇解析），客户端需有等待态
        const result = await citeSyncPatch([...store.papers.values()], store.graph.edges, getConfig().fetchProxy || undefined);
        const graph = result.addedEdges.length
          ? mergeGraph(store.graph, { nodes: [], edges: result.addedEdges }, 'append', new Set(store.papers.keys()))
          : store.graph;
        await store.saveGraph(graph);
        sendJson(res, 200, {
          addedEdges: result.addedEdges.length,
          scanned: result.scanned,
          resolved: result.resolved,
          missCount: result.misses.length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- knowledge graph ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/graph',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const store = await getStore();
        if (req.method === 'GET') {
          sendJson(res, 200, { graph: store.graph });
          return;
        }
        if (req.method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as {
            nodes?: unknown; edges?: unknown; mode?: unknown; force?: unknown;
          };
          if (!Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
            return sendJson(res, 400, { error: 'nodes 与 edges 必须是数组' });
          }
          const mode = body.mode === 'rebuild' ? 'rebuild' : 'append';
          // idea 节点是 cardSync 的系统产物（id=卡片 id）：外部提交的 idea 节点
          // 若不对应真实卡片一律丢弃，防止幻影节点混入（"查看卡片"会 404）
          const rawNodes = body.nodes as KnowledgeGraph['nodes'];
          const droppedIdeas = rawNodes.filter((n) => n?.kind === 'idea' && !store.cards.has(n.id)).length;
          const incoming = {
            nodes: rawNodes.filter((n) => !(n?.kind === 'idea' && !store.cards.has(n.id))),
            edges: body.edges as KnowledgeGraph['edges'],
          };
          // rebuild 保护：缩减型 rebuild（详见 assertRebuildAllowed）需 force=true 显式确认
          if (mode === 'rebuild') {
            try {
              assertRebuildAllowed(store.graph, incoming.nodes.length + incoming.edges.length, body.force === true);
            } catch (err) {
              return sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
            }
          }
          const knownPapers = new Set(store.papers.keys());
          const graph = mergeGraph(store.graph, incoming, mode, knownPapers);
          // rebuild 前把旧图谱备份为 graph.json.bak（保留一代）
          await (mode === 'rebuild' ? store.saveGraphRebuild(graph) : store.saveGraph(graph));
          sendJson(res, 200, { graph, ...(droppedIdeas ? { droppedIdeaNodes: droppedIdeas } : {}) });
          return;
        }
          sendJson(res, 405, { error: 'method not allowed' });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ==================== 精读引擎（自有）：直跑 / 进度 / 追问 / 会话 / VLM 探针 ==================== */
  const preferredModel = () => {
    const c = getConfig();
    const provider = (c.llmProvider ?? '').trim();
    const model = (c.llmModel ?? '').trim();
    return provider && model ? { provider, model } : null;
  };
  const preferFallback = () => getConfig().preferFallback !== false;

  /* pdf.js for the in-sidebar reader. Assets stay inside pdfjs-dist. */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/pdfjs',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const { rest } = pathInfo(req, '/scholar/pdfjs');
      let hit: { body: Buffer; contentType: string } | null;
      try {
        hit = await readScholarPdfjs(rest);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!hit) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', hit.contentType);
      res.setHeader('cache-control', 'public, max-age=86400');
      res.setHeader('content-length', String(hit.body.length));
      res.end(req.method === 'HEAD' ? undefined : hit.body);
    },
  } satisfies WebRoute));

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/translate',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      try {
        const body = JSON.parse(await readBody(req)) as { text?: unknown; context?: unknown; domain?: unknown };
        const result = await translateAcademicSelection(ctx, body, preferredModel, preferFallback());
        sendJson(res, 200, result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = message.includes('没有要翻译') || message.includes('选区过长') ? 400 : 502;
        sendJson(res, code, { error: message });
      }
    },
  } satisfies WebRoute));
  const readEngine = (ctx as { llm?: unknown }).llm
    ? createReadEngine(ctx as never, preferredModel, preferFallback)
    : null;
  const figureReader = createFigureReader(ctx as never, preferredModel, preferFallback);
  const asker = (ctx as { llm?: unknown }).llm ? createAskerRoute(ctx as never, preferredModel, preferFallback) : null;

  async function persistReadQueue(dir: string): Promise<void> {
    await writeFile(join(dir, 'read-run.json'), JSON.stringify({
      run: readRun,
      queue: readWaiters,
      savedAt: Date.now(),
    }), 'utf8').catch(() => {});
  }

  /** 顺序执行一批精读。进行中的批次把后来的请求放进 readWaiters，结束时自动接下一批。 */
  async function launchReadJob(desc: ReadJobDesc): Promise<void> {
    if (!readEngine) return;
    const run: ReadRunState = {
      id: ++readRunSeq,
      mode: desc.mode,
      light: desc.light,
      focus: desc.focus,
      paperIds: desc.paperIds,
      total: desc.paperIds.length,
      skipped: 0,
      startedAt: Date.now(),
      finishedAt: null,
      ok: 0,
      fail: 0,
      papers: desc.paperIds.map((id) => ({ title: id, paperId: id, state: 'pending' as const })),
      phase: '准备中…',
      error: '',
      retryable: false,
      suggestLight: false,
    };
    readRun = run;
    const job = createJobAbort();
    activeSignal = job.handle;
    activeAbort = job.abort;
    const signal = job.handle;
    const { mode, light, focus, autoCompare } = desc;
    try {
      const store = await getStore();
      await persistReadQueue(store.dir);
      const papers = desc.paperIds
        .map((id) => store.papers.get(id))
        .filter((p): p is Paper => !!p?.pdfPath);
      run.papers = papers.map((p) => ({ title: p.title, paperId: p.id, state: 'pending' as const }));
      run.paperIds = papers.map((p) => p.id);
      run.total = papers.length;
      run.skipped = desc.paperIds.length - papers.length;
      if (papers.length === 0) throw new Error('排队的论文都没有 PDF');
      const paperOutcomes: Array<{ paper: Paper; outcome: PaperOutcome }> = [];
      for (let i = 0; i < papers.length; i++) {
        if (signal.aborted) break;
        const p = papers[i]!;
        run.papers[i]!.state = 'running';
        run.phase = '准备中…';
        try {
          await store.setPaperLifecycle(p.id, 'reading');
          const notes = formatReaderNotes((await store.getAnnotations(p.id)).highlights);
          const outcome = await readEngine.readSync(
            { path: `${store.dir}/${p.pdfPath}`, mode, light, focus, vlm: getConfig().vlmFigures !== 'off', readerNotes: notes },
            (line) => { run.phase = line; },
            signal,
          );
          if (signal.aborted) throw new Error('任务已取消');
          const archived = await archiveReadResult(store, p, outcome, { focusNote: focus ? '带关注重点' : '' });
          if (!archived.file) throw new Error('论文已删除，精读结果未保存');
          if (outcome.kind === 'paper') paperOutcomes.push({ paper: p, outcome });
          run.ok++;
          run.papers[i]!.state = 'ok';
          console.log(`[dsh-scholar] 精读归档 ${run.ok}/${papers.length}: ${p.title.slice(0, 50)}`);
        } catch (err) {
          run.fail++;
          run.papers[i]!.state = 'fail';
          const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
          run.papers[i]!.failedPhase = run.phase || undefined;
          run.papers[i]!.error = msg;
          run.error = msg;
          run.retryable = true;
          run.suggestLight = !light;
          console.error(`[dsh-scholar] 精读失败 ${p.title.slice(0, 50)}:`, err instanceof Error ? err.message : err);
        }
        run.phase = '';
      }
      if (autoCompare && paperOutcomes.length >= 2 && !signal.aborted) {
        try {
          run.phase = '生成横向对比报告…';
          const cmp = await runCompare(ctx, paperOutcomes.map((x) => x.outcome), focus, signal, preferredModel, preferFallback);
          const cmpFile = `cmp-${paperOutcomes.map((x) => safeName(x.paper.id)).join('--')}-${Date.now()}.html`;
          const committed = await store.commitPaperArtifacts(paperOutcomes.map(x => x.paper), async () => {
            await mkdir(join(store.dir, 'reports'), { recursive: true });
            await writeFile(join(store.dir, 'reports', cmpFile),
              renderCompareHtml(cmp, {
                title: `横向对比：${paperOutcomes.map((x) => x.paper.title.slice(0, 24)).join(' × ')}`,
                sub: `${paperOutcomes.length} 篇 · ${mode === 'quick' ? '速读' : '学术深读'}产物 · ${new Date().toISOString().slice(0, 10)}`,
              }), 'utf8');
            return true;
          });
          if (!committed) throw new Error('参与对比的论文已删除');
          run.phase = '';
          console.log(`[dsh-scholar] 对比报告归档: ${cmpFile.slice(0, 80)}`);
        } catch (err) {
          run.phase = '';
          console.error('[dsh-scholar] 对比报告失败:', err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      if (!run.error) run.error = String(err instanceof Error ? err.message : err).slice(0, 200);
      if (run.ok === 0) run.fail = Math.max(run.fail, 1);
    } finally {
      run.finishedAt = Date.now();
      activeSignal = null;
      activeAbort = null;
      console.log(`[dsh-scholar] 批量精读结束：成功 ${run.ok} / 失败 ${run.fail}`);
      const next = readWaiters.shift();
      if (next) {
        void launchReadJob(next);
      } else {
        try { await persistReadQueue((await getStore()).dir); } catch { /* 进度落盘失败不影响结果 */ }
      }
    }
  }

  let restorePromise: Promise<void> | null = null;
  function restoreReadQueue(): Promise<void> {
    if (!restorePromise) restorePromise = (async () => {
      try {
        const store = await getStore();
        const raw = JSON.parse(await readFile(join(store.dir, 'read-run.json'), 'utf8')) as {
          run?: ReadRunState; queue?: ReadJobDesc[];
        };
        const jobs: ReadJobDesc[] = [];
        if (raw.run && raw.run.finishedAt == null) {
          const ids = (raw.run.papers ?? []).filter((p) => p.state !== 'ok' && p.paperId).map((p) => p.paperId!);
          const use = ids.length > 0 ? ids : (raw.run.paperIds ?? []);
          if (use.length > 0) {
            jobs.push({
              mode: raw.run.mode === 'quick' ? 'quick' : 'paper',
              light: !!raw.run.light,
              focus: raw.run.focus ?? '',
              autoCompare: false,
              paperIds: use,
            });
          }
        }
        for (const q of raw.queue ?? []) {
          if (!q || !Array.isArray(q.paperIds)) continue;
          const paperIds = q.paperIds.filter((id) => typeof id === 'string');
          if (paperIds.length === 0) continue;
          jobs.push({
            mode: q.mode === 'quick' ? 'quick' : 'paper',
            light: !!q.light,
            focus: typeof q.focus === 'string' ? q.focus : '',
            autoCompare: q.autoCompare === true,
            paperIds,
          });
        }
        if (jobs.length === 0 || !readEngine) return;
        if (readRunBusy()) {
          readWaiters.push(...jobs);
          return;
        }
        const [first, ...rest] = jobs;
        readWaiters.push(...rest);
        if (first) void launchReadJob(first);
      } catch { /* 没有未完成的精读 */ }
    })();
    return restorePromise;
  }
  void restoreReadQueue();

  /* ---------- 精读直跑（面板「启动精读」→ 一个后台任务顺序读 N 篇，逐篇归档） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/run',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!readEngine) {
        sendJson(res, 503, { error: '精读引擎不可用（宿主缺少 llm 服务）' });
        return;
      }
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as {
          paperIds?: unknown; mode?: unknown; focus?: unknown; light?: unknown; autoCompare?: unknown;
        };
        const mode = body.mode === 'quick' ? 'quick' : 'paper';
        const light = body.light === true;
        const autoCompare = body.autoCompare === true;
        const paperIds = Array.isArray(body.paperIds)
          ? [...new Set(body.paperIds.filter((x): x is string => typeof x === 'string'))]
          : [];
        const badPaper = paperIds.find((id) => !store.papers.has(id));
        if (badPaper) return sendJson(res, 400, { error: `论文不存在: ${badPaper}` });
        if (paperIds.length < 1 || paperIds.length > 10) {
          return sendJson(res, 400, { error: '对象论文数量必须是 1-10 篇' });
        }
        const focus = typeof body.focus === 'string' ? body.focus.trim().slice(0, 2400) : '';
        const papers = paperIds.map((id) => store.papers.get(id)!).filter((p) => p.pdfPath);
        const missing = paperIds.length - papers.length;
        if (papers.length === 0) {
          return sendJson(res, 400, { error: '所选论文均无 PDF（arXiv 论文可在对话中重新保存触发下载，或在详情页手动上传）' });
        }
        // UI 直调无对话 agent，官方 jobs 不可用（绑定 agent）——脱离任务系统后台执行：
        // 不阻塞 HTTP，逐篇归档报告+回填 summary，结果直接落在库里。
        // 进度写入内存注册表并落盘。已有精读时后来的批次排队，当前批次结束后自动开始。
        const desc: ReadJobDesc = {
          mode, light, focus, autoCompare, paperIds: papers.map((p) => p.id),
        };
        await restoreReadQueue();
        if (readRunBusy()) {
          readWaiters.push(desc);
          try { await persistReadQueue(store.dir); } catch { /* 排队信息没写上盘也不拦这次请求 */ }
          return sendJson(res, 200, {
            ok: true, detached: true, queued: true, position: readWaiters.length,
            started: papers.length, skipped: missing,
            label: `已排队（第 ${readWaiters.length} 批，当前精读结束后自动开始）`,
          });
        }
        void launchReadJob(desc);
        sendJson(res, 200, {
          ok: true, detached: true, started: papers.length, skipped: missing,
          label: `${papers.length} 篇·${mode === 'quick' ? '速读' : light ? '轻量深读' : '学术深读'}`,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 直接对比已有成果（不重读）：读 sidecar JSON，无则回退论文 summary+abstract ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/compare',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      if (!(ctx as { llm?: unknown }).llm) return sendJson(res, 503, { error: '对比引擎不可用（宿主缺少 llm 服务）' });
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperIds?: unknown; focus?: unknown };
        const paperIds = Array.isArray(body.paperIds)
          ? [...new Set(body.paperIds.filter((x): x is string => typeof x === 'string'))]
          : [];
        if (paperIds.length < 2 || paperIds.length > 10) return sendJson(res, 400, { error: '对比需要选 2-10 篇论文' });
        const bad = paperIds.find((id) => !store.papers.has(id));
        if (bad) return sendJson(res, 400, { error: `论文不存在: ${bad}` });
        const focus = typeof body.focus === 'string' ? body.focus.trim().slice(0, 2400) : '';
        // 进度注册（横幅可见）
        const papers = paperIds.map((id) => store.papers.get(id)!);
        const run: ReadRunState = {
          id: ++readRunSeq, mode: 'paper', light: false, focus, paperIds,
          total: 1, skipped: 0,
          startedAt: Date.now(), finishedAt: null, ok: 0, fail: 0,
          papers: [{ title: `直接对比 ${papers.length} 篇（已有成果）`, state: 'running' }],
          phase: '组装对比原料…', error: '',
          retryable: false, suggestLight: false,
        };
        // F12:上一 run 未结束/未取消时拒绝重叠启动(旧任务会在后台默默烧额度)
        const busy = readRunBusy();
        if (busy) {
          return sendJson(res, 409, { error: "已有精读任务进行中(#" + busy.id + ")", run: busy });
        }
        readRun = run;
        const job = createJobAbort();
        activeSignal = job.handle;
        activeAbort = job.abort;
        const signal = job.handle;
        void (async () => {
          try {
            const reportsDir = join(store.dir, 'reports');
            const entries: Array<{ title: string; digest: string }> = [];
            const usedSidecar: boolean[] = [];
            for (const p of papers) {
              // 最新 sidecar（深读归档时存的对比原料）
              let entry: { title: string; digest: string } | null = null;
              try {
                const sidecars = (await readdir(reportsDir))
                  .filter((f) => f.startsWith(`${safeName(p.id)}-`) && f.endsWith('.json'))
                  .sort();
                const last = sidecars[sidecars.length - 1];
                if (last) {
                  const sc = JSON.parse(await readFile(join(reportsDir, last), 'utf8')) as import('./read/compare.js').CompareSidecar;
                  if (sc && typeof sc.title === 'string' && (sc.summary || sc.items?.length)) {
                    const { digestOfSidecar } = await import('./read/compare.js');
                    entry = { title: sc.title, digest: digestOfSidecar(sc) };
                  }
                }
              } catch { /* 读不了走回退 */ }
              if (!entry) {
                // 回退：论文的 AI 总结 + 摘要（库内现成数据）
                const parts = [`【${p.title}】`, p.summary, p.abstract ? p.abstract.slice(0, 1200) : ''].filter(Boolean);
                entry = { title: p.title, digest: parts.join('\n') };
                usedSidecar.push(false);
              } else usedSidecar.push(true);
              entries.push(entry);
            }
            run.phase = '生成横向对比报告…';
            const cmp = await runCompareEntries(ctx, entries, focus, signal, preferredModel, preferFallback);
            const cmpFile = `cmp-${papers.map((p) => safeName(p.id)).join('--')}-${Date.now()}.html`;
            const committed = await store.commitPaperArtifacts(papers, async () => {
              await mkdir(reportsDir, { recursive: true });
              await writeFile(join(reportsDir, cmpFile), renderCompareHtml(cmp, {
                title: `横向对比：${papers.map((p) => p.title.slice(0, 24)).join(' × ')}`,
                sub: `${papers.length} 篇 · 已有精读成果（${usedSidecar.filter(Boolean).length}/${papers.length} 篇有结构化原料，其余用摘要回退） · ${new Date().toISOString().slice(0, 10)}`,
              }), 'utf8');
              return true;
            });
            if (!committed) throw new Error('参与对比的论文已删除');
            run.ok = 1;
            run.papers[0]!.state = 'ok';
            run.phase = '';
            console.log(`[dsh-scholar] 直接对比归档: ${cmpFile.slice(0, 80)}`);
          } catch (err) {
            run.fail = 1;
            run.papers[0]!.state = 'fail';
            run.error = String(err instanceof Error ? err.message : err).slice(0, 200);
            run.phase = '';
            console.error('[dsh-scholar] 直接对比失败:', err instanceof Error ? err.message : err);
          } finally {
            run.finishedAt = Date.now();
            activeSignal = null;
            activeAbort = null;
          }
        })();
        sendJson(res, 200, { ok: true, detached: true, started: papers.length, label: `直接对比 ${papers.length} 篇` });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 精读进度查询：面板轮询（running 时 1.5s 一拍） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/status',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      await restoreReadQueue();
      sendJson(res, 200, { run: readRun, queued: readWaiters.length });
    },
  } satisfies WebRoute));

  /* ---------- F12:精读任务取消（立即 abort 模型流） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/cancel',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method not allowed' });
          return;
        }
        const busy = readRunBusy();
        if (!busy) {
          sendJson(res, 200, { cancelled: false, reason: '当前没有进行中的精读任务' });
          return;
        }
        readWaiters.length = 0;
        activeAbort?.();
        busy.phase = '正在取消…';
        try { await persistReadQueue((await getStore()).dir); } catch { /* 取消本身已经生效 */ }
        sendJson(res, 200, { cancelled: true, run: busy });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- 精读失败恢复：对上一 run 的失败篇重试，或强制 light 续跑 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/retry',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'method not allowed' });
        return;
      }
      if (!readEngine) {
        sendJson(res, 503, { error: '精读引擎不可用（宿主缺少 llm 服务）', ok: false, retryable: false, suggestLight: false });
        return;
      }
      try {
        const body = (await readBody(req).then((t) => t ? JSON.parse(t) : {})) as {
          light?: unknown; paperIds?: unknown;
        };
        const prev = readRun;
        if (!prev || prev.finishedAt === null) {
          return sendJson(res, 400, { error: '没有可重试的已结束精读任务', ok: false, retryable: false });
        }
        const failedIds = prev.papers
          .filter((p) => p.state === 'fail' && p.paperId)
          .map((p) => p.paperId!);
        const requested = Array.isArray(body.paperIds)
          ? body.paperIds.filter((x): x is string => typeof x === 'string')
          : failedIds;
        const paperIds = requested.length ? requested : failedIds;
        if (paperIds.length === 0) {
          return sendJson(res, 400, { error: '没有失败的论文可重试', ok: false, retryable: false });
        }
        const forceLight = body.light === true || prev.suggestLight;
        // 复用 /scholar/read/run：构造等价 body 并内联启动逻辑会重复——此处转发同路径语义
        const store = await getStore();
        const mode = prev.mode;
        const light = forceLight;
        const focus = prev.focus;
        const papers = paperIds.map((id) => store.papers.get(id)).filter((p): p is NonNullable<typeof p> => !!p?.pdfPath);
        if (papers.length === 0) {
          return sendJson(res, 400, { error: '所选失败论文均无 PDF', ok: false, retryable: false });
        }
        if (readRunBusy()) {
          readWaiters.push({ mode, light, focus, autoCompare: false, paperIds: papers.map((p) => p.id) });
          try { await persistReadQueue(store.dir); } catch { /* 排队信息没写上盘也不拦这次请求 */ }
          return sendJson(res, 200, {
            ok: true, detached: true, queued: true, position: readWaiters.length,
            started: papers.length, light,
            label: `已排队（第 ${readWaiters.length} 批）`,
          });
        }
        const run: ReadRunState = {
          id: ++readRunSeq, mode, light, focus, paperIds: papers.map((p) => p.id),
          total: papers.length, skipped: paperIds.length - papers.length,
          startedAt: Date.now(), finishedAt: null, ok: 0, fail: 0,
          papers: papers.map((p) => ({ title: p.title, paperId: p.id, state: 'pending' as const })),
          phase: light ? '轻量续跑…' : '重试中…',
          error: '',
          retryable: false,
          suggestLight: false,
        };
        readRun = run;
        const job = createJobAbort();
        activeSignal = job.handle;
        activeAbort = job.abort;
        const signal = job.handle;
        void (async () => {
          try {
            for (let i = 0; i < papers.length; i++) {
              if (signal.aborted) break;
              const p = papers[i]!;
              run.papers[i]!.state = 'running';
              run.phase = light ? '轻量精读…' : '重试精读…';
              try {
                await store.setPaperLifecycle(p.id, 'reading');
                const notes = formatReaderNotes((await store.getAnnotations(p.id)).highlights);
                const outcome = await readEngine.readSync(
                  { path: `${store.dir}/${p.pdfPath}`, mode, light, focus, vlm: getConfig().vlmFigures !== 'off', readerNotes: notes },
                  (line) => { run.phase = line; },
                  signal,
                );
                if (signal.aborted) throw new Error('任务已取消');
                const archived = await archiveReadResult(store, p, outcome, {
                  focusNote: (focus ? '带关注重点 · ' : '') + (light ? '轻量续跑' : '失败重试'),
                });
                if (!archived.file) throw new Error('论文已删除，精读结果未保存');
                run.ok++;
                run.papers[i]!.state = 'ok';
              } catch (err) {
                run.fail++;
                run.papers[i]!.state = 'fail';
                const msg = String(err instanceof Error ? err.message : err).slice(0, 200);
                run.papers[i]!.failedPhase = run.phase || undefined;
                run.papers[i]!.error = msg;
                run.error = msg;
                run.retryable = true;
                run.suggestLight = !light;
              }
              run.phase = '';
            }
          } finally {
            run.finishedAt = Date.now();
            activeSignal = null;
            activeAbort = null;
          }
        })();
        sendJson(res, 200, {
          ok: true, detached: true, started: papers.length,
          light, label: light ? '轻量续跑' : '失败重试', run,
        });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err), ok: false, retryable: true });
      }
    },
  } satisfies WebRoute));

  /* ---------- 交互式追问（详情页追问框）：检索精读章节块 → 带引证回答 → 落会话 ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/ask',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      const job = createJobAbort();
      const onClientGone = () => { job.abort(); };
      req.on('close', onClientGone);
      req.on('aborted', onClientGone);
      try {
        if (!asker) return sendJson(res, 503, { error: '追问引擎不可用（宿主缺少 llm 服务）' });
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperId?: unknown; question?: unknown };
        const paperId = String(body.paperId ?? '');
        const question = String(body.question ?? '').trim().slice(0, 500);
        const paper = store.papers.get(paperId);
        if (!paper) return sendJson(res, 404, { error: '论文不存在' });
        if (question === '') return sendJson(res, 400, { error: '问题不能为空' });
        const session = await loadSession(store.dir, paperId);
        if (!session) return sendJson(res, 400, { error: '该论文还没有精读会话（先精读一次才能追问）' });
        const history = session.qa.slice(-3).map((e) => ({ q: e.q, a: e.a }));
        const notes = formatReaderNotes((await store.getAnnotations(paperId)).highlights);
        const ans = await asker(session.chunks, question, history, job.handle, notes);
        if (job.handle.aborted) return sendJson(res, 499, { error: '任务已取消' });
        const committed = await store.commitPaperArtifacts([paper], async () => {
          await appendQA(store.dir, paperId, { q: question, a: ans.answer, pages: ans.pages, confidence: ans.confidence, sufficient: ans.sufficient, at: Date.now() });
          return true;
        });
        if (!committed) return sendJson(res, 404, { error: '论文已删除' });
        sendJson(res, 200, { ok: true, ...ans });
      } catch (err) {
        if (job.handle.aborted) {
          sendJson(res, 499, { error: '任务已取消' });
          return;
        }
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      } finally {
        req.off('close', onClientGone);
        req.off('aborted', onClientGone);
      }
    },
  } satisfies WebRoute));

  /* ---------- 阅读会话查询（详情页追问区加载历史问答） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/read/session',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      try {
        const { rest } = pathInfo(req, '/scholar/read/session');
        const paperId = decodeURIComponent(rest.replace(/^\/+/, ''));
        if (paperId === '') return sendJson(res, 400, { error: '缺少 paperId' });
        const store = await getStore();
        if (!store.papers.has(paperId)) return sendJson(res, 404, { error: '论文不存在' });
        const session = await loadSession(store.dir, paperId);
        sendJson(res, 200, { exists: session !== null, qa: session?.qa ?? [] });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- VLM 读图探针：验证模型能否看图（抽首图问一句，一次调用） ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/scholar/read/vlm-test',
    handler: async (req, res) => {
      if (!guardRoute(req, res)) return;
      if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return; }
      try {
        const store = await getStore();
        const body = JSON.parse(await readBody(req)) as { paperId?: unknown };
        const paper = store.papers.get(String(body.paperId ?? ''));
        if (!paper?.pdfPath) return sendJson(res, 400, { error: '论文不存在或没有 PDF' });
        const buf = await readFile(join(store.dir, paper.pdfPath));
        const { images: figs } = extractPdfFigures(buf.toString('latin1'));
        if (figs.length === 0) {
          return sendJson(res, 200, { usable: figureReader.usable, figures: 0, description: '' });
        }
        const description = await figureReader.describeFigure(figs[0]!, '一句话描述这张图的内容与类型。');
        sendJson(res, 200, { usable: figureReader.usable, figures: figs.length, description });
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));

  /* ---------- Public tablet share (LAN-readable; token is the gate) ---------- */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/scholar/tablet-share',
    handler: async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return sendJson(res, 405, { error: 'method not allowed' });
        }
        const { rest } = pathInfo(req, '/scholar/tablet-share');
        const token = decodeURIComponent((rest || '').replace(/^\//, '').split('/')[0] || '').trim();
        if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
          return sendJson(res, 404, { error: '分享链接无效或已过期' });
        }
        const rec = getTabletShare(token);
        if (!rec) return sendJson(res, 404, { error: '分享链接无效或已过期' });
        try {
          const info = await stat(rec.absPath);
          res.statusCode = 200;
          res.setHeader('content-type', 'application/pdf');
          res.setHeader('x-content-type-options', 'nosniff');
          res.setHeader('cache-control', 'no-store');
          const safeName = `${rec.title.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80) || rec.paperId}.pdf`;
          res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(safeName)}`);
          res.setHeader('content-length', info.size);
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          const stream = createReadStream(rec.absPath);
          stream.on('error', (err) => {
            if (res.headersSent) res.end();
            else sendJson(res, 500, { error: `PDF 读取失败: ${err instanceof Error ? err.message : String(err)}` });
          });
          stream.pipe(res);
        } catch {
          sendJson(res, 404, { error: 'PDF 文件丢失' });
        }
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    },
  } satisfies WebRoute));
}

/** Resolve a concept id from a model-supplied label (direct or canonical). */
export function resolveConceptId(graph: KnowledgeGraph, input: string): string | undefined {
  const canonical = conceptId(input);
  const direct = graph.nodes.find((n) => n.kind === 'concept' && n.id === canonical);
  if (direct) return direct.id;
  const byLabel = graph.nodes.find((n) => n.kind === 'concept' && n.label.toLowerCase() === input.toLowerCase());
  if (byLabel) return byLabel.id;
  const sub = conceptSubgraph(graph, canonical);
  return sub.nodes.length > 0 ? canonical : undefined;
}
