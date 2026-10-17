/** dsh-scholar shared data model (used by both host and client halves). */

export type PaperSource = 'agent' | 'manual';

/** 阅读状态工作流（ReadPaper 式）：想读 → 在读 → 读过；缺省视为 want */
export const READ_STATUSES = ['want', 'reading', 'done'] as const;
export type ReadStatus = (typeof READ_STATUSES)[number];

/**
 * 论文生命周期（权威）。粗粒度 readStatus 由其派生同步。
 * inbox → saved → pdf_verified → reading → read → annotated → distilled → linked → cited → archived
 */
export const PAPER_LIFECYCLES = [
  'inbox',
  'saved',
  'pdf_verified',
  'reading',
  'read',
  'annotated',
  'distilled',
  'linked',
  'cited',
  'archived',
] as const;
export type PaperLifecycle = (typeof PAPER_LIFECYCLES)[number];

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  arxivId?: string;
  doi?: string;
  url?: string;
  abstract?: string;
  /** AI 一句话总结（对话中生成） */
  summary?: string;
  tags: string[];
  /** 1–5 */
  importance?: number;
  /** 阅读状态（缺省 = want）；由 lifecycle 同步 */
  readStatus?: ReadStatus;
  /** 权威生命周期；缺省时由 readStatus/pdf/批注/卡片派生 */
  lifecycle?: PaperLifecycle;
  /** 附件相对路径（attachments/<file>） */
  pdfPath?: string;
  source: PaperSource;
  notes?: string;
  /** 收集分区（多重归属，引用 collections.json 的 id） */
  collectionIds?: string[];
  /** Zotero item key（双向同步） */
  zoteroKey?: string;
  /** 上次同步时的 Zotero local version */
  zoteroVersion?: number;
  createdAt: number;
  updatedAt: number;
}

/** 论文收集分区（Zotero 式多重归属；存于 collections.json） */
export interface PaperCollection {
  id: string; // col_<base36><rand>
  name: string;
  color?: string;
  /** Zotero collection key */
  zoteroKey?: string;
  zoteroVersion?: number;
  createdAt: number;
  updatedAt: number;
}

/** PDF 高亮 / 批注（存于 annotations/<paperId>.json；与 Zotero annotation 同步） */
export interface PaperHighlight {
  id: string;
  page: number;
  text: string;
  comment?: string;
  color?: string;
  /**
   * Optional page boxes as `[x, y, w, h]` at scale=1.
   * Default / local draws: viewport space (origin top-left).
   * Zotero imports: PDF user space (origin bottom-left) when `coordSpace === 'pdf'`.
   */
  rects?: number[][];
  /** Geometry space for `rects`; omitted means viewport (local highlights). */
  coordSpace?: 'viewport' | 'pdf';
  zoteroKey?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaperAnnotationFile {
  paperId: string;
  highlights: PaperHighlight[];
  updatedAt: number;
}

export const CARD_CATEGORIES = ['method', 'theory', 'dataset', 'evaluation', 'engineering', 'other'] as const;
export type CardCategory = (typeof CARD_CATEGORIES)[number];

export const CARD_STATUSES = ['pending', 'validated', 'adopted', 'dropped'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export interface IdeaCard {
  id: string;
  title: string;
  /** 创新点描述 */
  insight: string;
  /** 来源论文 id（可空） */
  paperId?: string;
  category: CardCategory;
  tags: string[];
  /** 1–5 */
  importance: number;
  status: CardStatus;
  notes?: string;
  /** 卡片间关联（P2） */
  relatedCardIds?: string[];
  /** 通俗表达：一句大白话讲清这个想法 */
  plain?: string;
  /** 简易流程步骤（每步一句，渲染为纵向流程图） */
  steps?: string[];
  /** 证据摘录摘要（展示用）；结构化证据见 evidenceIds */
  evidence?: string;
  /** 关联的结构化证据 id */
  evidenceIds?: string[];
  /** 可验证假设字段（旧卡可空） */
  researchQuestion?: string;
  hypothesis?: string;
  modulesToChange?: string;
  dataset?: string;
  baseline?: string;
  metrics?: string;
  risks?: string;
  validationResult?: string;
  /** Zotero note key */
  zoteroKey?: string;
  zoteroVersion?: number;
  createdAt: number;
  updatedAt: number;
}

/** 结构化证据（存于 evidences.json） */
export const EVIDENCE_KINDS = [
  'author_claim',
  'experiment_result',
  'inference',
  'unverified_transfer',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  id: string;
  claim: string;
  paperId: string;
  page?: number;
  section?: string;
  quotation?: string;
  figureOrEquation?: string;
  annotationId?: string;
  kind: EvidenceKind;
  /** 1–5 */
  confidence: number;
  ideaCardIds?: string[];
  projectIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** 研究方向 / 项目（存于 projects.json） */
export interface ResearchProject {
  id: string;
  title: string;
  summary?: string;
  researchQuestions: string[];
  paperIds: string[];
  evidenceIds: string[];
  ideaCardIds: string[];
  openProblems: string[];
  createdAt: number;
  updatedAt: number;
}

/** idea = Idea 卡片；project = 研究项目 */
export type GraphNodeKind = 'paper' | 'concept' | 'idea' | 'project';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
}

/** belongs_to = 论文/想法/证据 → 项目 */
export const GRAPH_EDGE_KINDS = [
  'proposes', 'improves', 'extends', 'builds_on', 'compares', 'uses',
  'cites', 'derives_from', 'related', 'belongs_to',
] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
  /** Card owners of an automatically synced edge. Arrays allow shared related
   * edges; strings remain readable for older stores. Absent means manual/legacy. */
  auto?: string | string[];
}

export interface KnowledgeGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ScholarStats {
  papers: number;
  cards: number;
  nodes: number;
  edges: number;
  evidences?: number;
  projects?: number;
  dir: string;
  /** 已入库但尚未入图的论文（id+title） */
  unsynced?: { id: string; title: string }[];
  /** init 时跳过的损坏文件清单（相对路径），可能不存在于旧响应 */
  corruptFiles?: string[];
  /** PDF 附件命名自检结果（启动时自动规范化） */
  attachmentNormalize?: {
    renamed: number;
    linked: number;
    conflicts: number;
    details: string[];
  };
}

export interface ScholarConfig {
  paperDir: string;
  defaultTags?: string[];
  /** Optional outbound HTTP(S) proxy for metadata fetching, e.g. http://127.0.0.1:7890 */
  fetchProxy?: string;
  /** Optional contact email for the OpenAlex polite pool (higher rate limits) */
  openalexEmail?: string;
  /** 研究方向：对话精读 focus 的锚点（首读不用，复读/对比/迁移时拼入） */
  researchFocus?: string;
  /**
   * Optional chat-LLM override for scholar host jobs (精读 / 追问 / 对比 / VLM).
   * Empty → follow agentDefaultModel, then first catalog entry.
   * Not a Jev/System One model — configure Jev separately below.
   * 「AI 生成札记」仍走对话栏，请在发送前把会话模型切到同一选择。
   */
  llmProvider?: string;
  llmModel?: string;
  /**
   * When the preferred chat llmProvider/llmModel fails with quota/auth/unavailable,
   * sticky-fall back to agentDefaultModel for the rest of the job. Default true.
   */
  preferFallback?: boolean;
  /**
   * Optional Jev / TypeSafe System One API (decision model, not chat).
   * Kept as its own settings block so the open-source plugin can ship without
   * a proprietary default route — users fill base URL + credential themselves.
   */
  jevDecide?: boolean;
  /** Provider id shown in host model catalogs (often `dev`). Empty disables Jev. */
  preferProvider?: string;
  /** System One model id, e.g. `jev-1.13.0`. Empty disables Jev. */
  preferModel?: string;
  /**
   * HTTPS origin + version prefix for System One (no trailing slash).
   * User-supplied origin, no trailing slash. POST `{baseURL}/systemone`.
   */
  preferBaseURL?: string;
  /** Credential ref / env name for the System One Bearer token. Default `DEV_API_KEY`. */
  preferApiKeyEnv?: string;
  /** VLM 读图：auto（模型支持才启用）| off */
  vlmFigures?: 'auto' | 'off';
  /** Enable Zotero bidirectional sync UI / auto hooks */
  zoteroSyncEnabled?: boolean;
  /** Local API base, default http://127.0.0.1:23119/api */
  zoteroBaseUrl?: string;
  /** Personal library path segment (always users/0 locally) */
  zoteroLibrary?: string;
  /** Remembered Local API write key (from POST /local/authorize) */
  zoteroApiKey?: string;
  /** Cached Zotero-Server-ID */
  zoteroServerId?: string;
  /**
   * Absolute path to an Obsidian vault. When set, paper notes / highlights
   * are written under `<vault>/Scholar/<paperId>.md` on save and sync.
   */
  obsidianVault?: string;
  /** Subfolder inside the vault (default Scholar) */
  obsidianSubdir?: string;
}

export type ZoteroSyncDirection = 'pull' | 'push' | 'both';

export interface ZoteroSyncResult {
  ok: boolean;
  direction: ZoteroSyncDirection;
  pulled: { papers: number; collections: number; notes: number; cards: number; pdfs: number; annotations: number };
  pushed: { papers: number; collections: number; notes: number; cards: number; pdfs: number; annotations: number };
  conflicts: number;
  errors: string[];
  cursor?: { serverId: string; version: number };
  durationMs: number;
  /** Wall-clock ms when this run finished (persisted for status UI) */
  finishedAt?: number;
}

export interface ZoteroSyncStatus {
  reachable: boolean;
  serverId?: string;
  zoteroVersion?: string;
  apiVersion?: string;
  hasWriteKey: boolean;
  syncEnabled: boolean;
  baseUrl: string;
  lastCursor?: { serverId: string; version: number };
  mapCounts?: { papers: number; collections: number; cards: number; annotations: number };
  /** Last completed sync run (persisted under paperDir) */
  lastSync?: ZoteroSyncResult | null;
  error?: string;
}

export type PaperSort = 'createdAt' | 'year' | 'title';

export interface PaperQuery {
  q?: string;
  tag?: string;
  yearFrom?: number;
  yearTo?: number;
  importance?: number;
  collection?: string;
  /** 只看未归入任何分区的论文 */
  unfiled?: boolean;
  readStatus?: ReadStatus;
  lifecycle?: PaperLifecycle;
  sort?: PaperSort;
  /** 正文缓存命中的论文 id，由检索路由填入，不来自 URL */
  bodyHitIds?: Set<string>;
}

export type CardSort = 'createdAt' | 'importance' | 'title';

export interface CardQuery {
  q?: string;
  category?: CardCategory;
  tag?: string;
  importance?: number;
  status?: CardStatus;
  paperId?: string;
  sort?: CardSort;
}

export interface EvidenceQuery {
  q?: string;
  paperId?: string;
  kind?: EvidenceKind;
  projectId?: string;
}

export interface ProjectQuery {
  q?: string;
}
