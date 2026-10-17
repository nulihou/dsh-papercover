/**
 * dsh-papercover精研引擎。
 *
 * paper：按章节分段，抽出问题、方法、实验数字、局限和精研卡。
 * quick：短摘要，用来筛文献。
 * 正文用 pdf.js 文字层。长文经宿主 jobs 转后台。
 */
import { extractPdfPlainText } from './pdf-text.js'
import { extractPdfFigures, type PdfFigureImg } from './figures.js'
import { createFigureReader } from './vlm.js'
import { extractFigureCatalog, parseFigTag } from './catalog.js'
import { throwIfCancelled } from './cancel.js'
import { arr, createLlmRuntime, splitChunksPaper, str, type PreferredModelFn } from './llm.js'
import {
  errorMessage, isBinaryFileService, isRecord, isTextFileService,
  type AbortLike, type HostContext, type JobsService, type MapItem, type MindNode,
} from './types.js'

/** VLM 对近空白抽出图的典型措辞——这类图不进报告画廊。 */
function isBlankFigureDescription(d: string): boolean {
  const t = d.trim()
  if (t.length < 8) return true
  return /几乎完全空白|只有白色背景|未见可辨认|无法据此描述|完全空白|blank white|almost (completely )?blank|no recognizable|nothing (visible|to describe)/i.test(t)
}

/** 单条分论点（claim/evidence/quote/source） */
interface SectionArgument {
  claim: string
  evidence: string
  quote: string
  source: string
}

/** 表行六要素 */
interface DataPoint {
  value: string
  period: string
  subject: string
  baseline: string
  source: string
  location: string
}

export type ReadMode = 'paper' | 'quick'

export interface ReadInput {
  /** 本地文件绝对路径（.pdf 必备；txt/md/html 亦可，用于读已归档的报告） */
  path: string
  mode: ReadMode
  /** 轻量档：长文综合直接走分段摘要（跳过全文大调用，快且 API 差时稳，精度略降）；
   *  仅对 >3 万字长文生效（短文本本来就是单次调用） */
  light?: boolean
  /** 拼装好的关注重点（研究方向/透镜/相关论文等由调用方组装） */
  focus?: string
  /** 输出语言：zh | en | auto（默认 auto=与原文一致） */
  language?: 'zh' | 'en' | 'auto'
  /** VLM 读图开关（默认开；纯文本模型自动降级） */
  vlm?: boolean
  /** 读者在 PDF 上的高亮和批注，精读时一并交给模型 */
  readerNotes?: string
}

export interface ReadOutcome {
  kind: 'result' | 'background'
  jobId?: string
  label?: string
  result?: PaperOutcome | QuickOutcome
}

export interface PaperOutcome {
  kind: 'paper'
  title: string
  summary: string
  coreQuestion: string
  coreConclusions: string[]
  items: MapItem[]
  dataPoints: DataPoint[]
  caveats: string[]
  recallQuestions: string[]
  figures: Array<{ ref: string; caption: string; meaning: string }>
  /** 综合阶段从各段合并的概念术语（可选——旧结果无此字段） */
  concepts?: Array<{ term: string; explanation: string }>
  /** 综合阶段从各段合并的原文摘录（可选） */
  quotes?: Array<{ text: string; context?: string; source?: string }>
  /** 结构提纲：问题、做法、证据三枝，可选 */
  mindmap?: MindNode
  /**
   * 精研卡（对齐 Nature Paper Card 的证据导向精读结构，压缩为可入库字段）。
   * 旧报告无此字段；UI / HTML 按需降级。
   */
  card?: StudyCard
  /**
   * 图文导读：中英对照段落，figure 为【图表视觉解读】的 1 基序号。
   * 旧报告无此字段；没有时 HTML 仍走证据表 + 文末图库。
   */
  narrative?: NarrativeBlock[]
  meta: {
    source: string; chars: number; chunks: number; mode: ReadMode; durationMs: number; chunksText?: string[]
    figuresImgs?: import('./figures.js').PdfFigureImg[]
    /** 报告外链图（归档写入后） */
    figureSrcs?: string[]
    figureDescriptions?: string[]
    /** 正文图注抽出的论文图号，页码可跳回 PDF；和抽出位图序号不是同一套 */
    figureCatalog?: Array<{ n: number; page: number; caption: string }>
    /** 与 figureDescriptions 对齐；对上论文图号时记下编号和页码 */
    figurePages?: Array<{ n: number; page: number } | null>
    /** 综合方式：fulltext|digest|assembled（降级链） */
    synth?: string
    /** 分段提取失败的段号（1 基） */
    gaps?: number[]
  }
}

/**
 * dsh-papercover「精研卡」——吸收 nature-paper-card 的证据导向槽位，
 * 但不展开完整 16 节（控制 token / 入库体积）。
 */
/** 给读者直接看的一节导读（中英对照，最多挂一张已编号的 VLM 图）。 */
export interface NarrativeBlock {
  heading: string
  bodyZh: string
  bodyEn: string
  /** 摘要段放 Abstract 原文；其他段可空 */
  quote: string
  /** 1 基序号，对应【图N】；一段最多 3 张，按讨论顺序 */
  figures: number[]
}

export interface StudyCard {
  /** §02 一句话：问题→方法→机制→有界结果 */
  oneSentence: string
  /** §05 论文识别的核心痛点 */
  painPoints: string[]
  /** §06 核心洞察（表层方法与可泛化启示可写在同一段，用「｜」分隔） */
  coreIdea: string
  /** §07 方法概览：输入→模块→输出 */
  methodOverview: string
  /** 相对既有工作的增量（据原文，禁止吹嘘） */
  novelty: string
  /** §11 有边界的结论重述 */
  boundedConclusion: string
  /** §14 可迁移知识点 */
  transfer: string[]
  /** §16 候选研究想法（假设，非 novelty claim） */
  ideas: Array<{ name: string; hypothesis: string; from: string }>
}

export interface QuickOutcome {
  kind: 'quick'
  title: string
  summary: string
  thesis: string
  arguments: SectionArgument[]
  concepts: Array<{ term: string; explanation: string }>
  caveats?: string[]
  questions: string[]
  meta: { source: string; chars: number; chunks: number; mode: ReadMode; durationMs: number; chunksText?: string[]; figuresImgs?: import('./figures.js').PdfFigureImg[]; figureSrcs?: string[]; figureDescriptions?: string[]; synth?: string; gaps?: number[] }
}

const CHUNK_CHARS = 9000
/** ≤此长度单遍直出（不进分段管线）；超过才分段 */
const SINGLE_SHOT_CHARS = 30000
/** 综合阶段允许直喂全文的上限（超过只喂分段摘要） */
const FULLTEXT_SYNTHESIS_CHARS = 200000
/** 分段上限：MAX_INPUT_CHARS / CHUNK_CHARS 的全覆盖（400k/9k≈45）——
 *  此前 20 段会把 18 万字以后的正文静默丢掉（长论文尾部消融/附录全失） */
const MAX_PARTS = 45
const MAX_INPUT_CHARS = 400000

/* ---------- dsh-papercover报告 JSON。渲染和归档认这些字段名。 ---------- */

const SECTION_SCHEMA = [
  '{',
  '  "title": "标题",',
  '  "summary": "这一段在解决什么",',
  '  "thesis": "这段最想让读者记住的一句",',
  '  "arguments": [{"claim": "主张", "evidence": "原文里的依据", "quote": "原文短句，可空", "source": "第N页或表号，没有页码标记就留空"}],',
  '  "quotes": [{"text": "值得留下的原句", "context": "这句在支撑什么", "source": "第N页，没有就留空"}],',
  '  "concepts": [{"term": "术语", "explanation": "这篇论文里它指什么"}],',
  '  "caveats": ["这段写出的边界、失败或没做的实验；没有则 []"],',
  '  "questions": ["读完这段还该核对的问题"]',
  '}',
].join('\n')

const PAPER_SCHEMA = [
  '{',
  '  "title": "论文标题",',
  '  "summary": "150-250字：问题、做法、主要数字、边界",',
  '  "coreQuestion": "论文要回答的研究问题，不要写成主题词",',
  '  "coreConclusions": ["有实验撑住的结论"],',
  '  "card": {',
  '    "oneSentence": "问题 + 方法 + 机制 + 带边界的结果。不要广告词",',
  '    "painPoints": ["论文自己点出的难点"],',
  '    "coreIdea": "表面做法｜它真正改了什么｜能带走的一点。后两段如属分析请标明",',
  '    "methodOverview": "输入、关键模块、输出，以及训练或推理时的假设",',
  '    "novelty": "相对文中提到的旧方法，原文声称多了什么",',
  '    "boundedConclusion": "结论成立的任务、数据或算力范围",',
  '    "transfer": ["读者方向上可以试的概念或实验设计，写成待验证"],',
  '    "ideas": [{"name":"想法名","hypothesis":"可检验的说法","from":"来自哪条局限"}]',
  '  },',
  '  "mindmap": {"label": "论文题目", "children": [',
  '    {"label": "要解决的问题", "children": [{"label": "短句，可带数字", "children": []}]},',
  '    {"label": "做法", "children": [{"label": "模块", "children": []}]},',
  '    {"label": "证据", "children": [{"label": "主结果或消融", "children": []}]}',
  '  ]},',
  '  "items": [',
  '    {"type": "结论|方法选择|实验数字|局限|背景",',
  '     "claim": "一句话",',
  '     "evidence": "原文依据。没有依据就写「原文未提供证据」",',
  '     "quote": "支撑句，保留原文语言，可空",',
  '     "source": "第3页 / Table 2",',
  '     "confidence": "原文陈述|实验数字|读者推断|材料不足",',
  '     "relations": [{"to": "另一条 claim 的开头", "type": "支撑|冲突|前提|对照|边界"}]}',
  '  ],',
  '  "dataPoints": [',
  '    {"value": "数值和指标", "period": "实验设定", "subject": "方法名", "baseline": "对照和差值", "source": "Table 2", "location": "第N页"}',
  '  ],',
  '  "figures": [{"ref": "Figure 3", "caption": "图注", "meaning": "正文用它说明什么"}],',
  '  "concepts": [{"term": "术语", "explanation": "在本文中的作用"}],',
  '  "quotes": [{"text": "原句", "context": "在论证什么", "source": "第N页"}],',
  '  "caveats": ["论文承认的边界，以及你读出来、但作者没写明的边界"],',
  '  "narrative": [',
  '    {"heading": "摘要|背景与动机|方法|实验|批判性评价|意义与展望",',
  '     "bodyZh": "完整中文段落",',
  '     "bodyEn": "同一段英文，术语留英文",',
  '     "quote": "只有摘要段填 Abstract 英文原文",',
  '     "figure": "0，或【图N】序号，或最多 3 个序号的数组"}',
  '  ],',
  '  "recallQuestions": ["读完应能回答的核对题"]',
  '}',
].join('\n')

/* ---------- prompts ---------- */

function langOf(language: 'zh' | 'en' | 'auto'): string {
  return language === 'en' ? 'English' : (language === 'zh' ? '简体中文' : '与原文语言保持一致')
}

function quickSystem(language: 'zh' | 'en' | 'auto', focus: string): string {
  let sys = '你在为dsh-papercover写一份速览。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。字段：\n'
    + SECTION_SCHEMA + '\n'
    + 'thesis 用一句完整话。arguments 最多 5 条，quotes 最多 3 条，concepts 最多 5 个，questions 最多 3 个。\n'
    + '正文里有【第N页】时，source 写这个页码；没有就留空。不要编页码。\n'
    + '输出语言：' + langOf(language) + '。\n'
  if (focus.trim() !== '') sys += '读者这次关心：' + focus.trim() + '。\n'
  return sys
}

function paperSystem(language: 'zh' | 'en' | 'auto', focus: string, isFinal: boolean): string {
  const task = isFinal ? '把各段笔记收成一篇论文的研读报告' : '把这篇论文收成研读报告'
  let sys = '你在为dsh-papercover写论文研读报告。' + task + '。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。结构：\n'
    + PAPER_SCHEMA + '\n'
    + '写作约定：\n'
    + 'coreQuestion 是研究问题。coreConclusions 只保留实验撑得住的 1-3 条。\n'
    + 'card 必填。说不清的字段写「依据不足，暂无法评估」。ideas 最多 3 条，写成待验证的假说，不要写成读者自己的创新。\n'
    + 'items 优先记方法上的选择（type=方法选择）和表里的数字（type=实验数字）。失败实验用 type=局限，不要改写成优点。\n'
    + 'confidence 四档：原文陈述、实验数字、读者推断、材料不足。作者没验证过的话用读者推断。\n'
    + 'dataPoints 一行对应主表或消融表的一行，数字、指标、对照和表号都留下。看不清写材料不足，不要猜。\n'
    + 'relations 用来标对照和边界。caveats 里作者写明的局限和你看出来的隐含边界分开说，后者标成读者推断。\n'
    + 'concepts 最多 8 个，quotes 最多 5 条，保留原文措辞。\n'
    + 'mindmap 是结构提纲：问题、做法、证据三条主枝，叶子用短词，能挂数字就挂。深度不超过 4 层。\n'
    + 'recallQuestions 提 5 个读完应能回答的核对题：动机、消融、适用边界。\n'
    + '中文写完整句子。summary 用 150-250 字讲清问题、做法、结果和边界。输出语言：' + langOf(language) + '。\n'
    + 'narrative 是文首导读，固定六段，顺序为摘要、背景与动机、方法、实验、批判性评价、意义与展望。\n'
    + 'bodyZh 每段约 120-180 字；bodyEn 是同一段英文，约 70-110 词。摘要段 quote 放 Abstract 英文原文（约 120 词内），bodyZh 是译文。\n'
    + 'figure 只用消息里「图表视觉解读」的序号。结构图放方法段，曲线和定性图放实验段，一段最多 3 张。对不上填 0。没有视觉解读时全部填 0。\n'
    + '「论文图号」是正文图注和它所在的物理页；【图N】是抽出图片的序号。两套编号不要混用。导读提到论文图时写第N页。读者批注要标明是读者标注。\n'
  if (focus.trim() !== '') sys += '读者这次关心：' + focus.trim() + '。\n'
  return sys
}

function paperChunkSystem(language: 'zh' | 'en' | 'auto', focus: string): string {
  let sys = '你在为dsh-papercover摘一篇论文的其中一段。只输出一个 JSON 对象，不要解释，不要 Markdown 代码块。字段：\n'
    + SECTION_SCHEMA + '\n'
    + 'arguments 优先记：方法上的选择及其动机或消融；带基准、指标和表号的数字；失败或负结果。\n'
    + 'caveats 只记本段出现的边界。没有就给空数组。\n'
    + '片段里有【第N页】时，source 必须用这个页码。\n'
    + '输出语言：' + langOf(language) + '。\n'
  if (focus.trim() !== '') sys += '读者这次关心：' + focus.trim() + '。\n'
  return sys
}

/* ---------- sanitize ---------- */

function sectionUser(text: string, index: number, total: number): string {
  if (total > 1) return '【第 ' + (index + 1) + ' / ' + total + ' 部分】\n\n' + text
  return '以下是待精读的内容：\n\n' + text
}

interface ChunkDigest {
  title: string
  summary: string
  thesis: string
  arguments: SectionArgument[]
  concepts: Array<{ term: string; explanation: string }>
  quotes: Array<{ text: string; context: string; source: string }>
  caveats: string[]
}

function sanitizeQuick(parsed: unknown): { title: string; summary: string; thesis: string; arguments: SectionArgument[]; concepts: Array<{ term: string; explanation: string }>; quotes: Array<{ text: string; context: string; source: string }>; caveats: string[]; questions: string[] } {
  const p = isRecord(parsed) ? parsed : {}
  return {
    title: str(p.title, '未命名内容'),
    summary: str(p.summary, ''),
    thesis: str(p.thesis, ''),
    arguments: arr(p.arguments).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { claim: String(it) }
      return { claim: str(o.claim, ''), evidence: str(o.evidence, ''), quote: str(o.quote, ''), source: str(o.source, '') }
    }).filter((a) => a.claim !== ''),
    concepts: arr(p.concepts).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { term: String(it) }
      return { term: str(o.term, ''), explanation: str(o.explanation, '') }
    }).filter((c) => c.term !== ''),
    quotes: arr(p.quotes).slice(0, 4).map((it) => {
      const o = isRecord(it) ? it : { text: String(it) }
      return { text: str(o.text, ''), context: str(o.context, ''), source: str(o.source, '') }
    }).filter((q) => q.text !== ''),
    caveats: arr(p.caveats).slice(0, 5).map((c) => String(c)).filter((c) => c !== ''),
    questions: arr(p.questions).slice(0, 5).map((q) => String(q)).filter((q) => q !== ''),
  }
}

function sanitizeStudyCard(raw: unknown): StudyCard | undefined {
  if (!isRecord(raw)) return undefined
  const oneSentence = str(raw.oneSentence, '').slice(0, 400)
  const painPoints = arr(raw.painPoints).slice(0, 5).map((c) => String(c).slice(0, 240)).filter(Boolean)
  const coreIdea = str(raw.coreIdea, '').slice(0, 600)
  const methodOverview = str(raw.methodOverview, '').slice(0, 600)
  const novelty = str(raw.novelty, '').slice(0, 400)
  const boundedConclusion = str(raw.boundedConclusion, '').slice(0, 500)
  const transfer = arr(raw.transfer).slice(0, 5).map((c) => String(c).slice(0, 240)).filter(Boolean)
  const ideas = arr(raw.ideas).slice(0, 3).map((it) => {
    const o = isRecord(it) ? it : {}
    return {
      name: str(o.name, '').slice(0, 80),
      hypothesis: str(o.hypothesis, '').slice(0, 320),
      from: str(o.from, '').slice(0, 160),
    }
  }).filter((x) => x.name !== '' || x.hypothesis !== '')
  if (!oneSentence && !coreIdea && !methodOverview && painPoints.length === 0) return undefined
  return { oneSentence, painPoints, coreIdea, methodOverview, novelty, boundedConclusion, transfer, ideas }
}

function sanitizePaper(parsed: unknown): {
  title: string; summary: string; coreQuestion: string; coreConclusions: string[];
  items: MapItem[]; dataPoints: DataPoint[]; caveats: string[]; recallQuestions: string[];
  figures: Array<{ ref: string; caption: string; meaning: string }>;
  concepts: Array<{ term: string; explanation: string }>;
  quotes: Array<{ text: string; context: string; source: string }>;
  mindmap?: MindNode;
  card?: StudyCard;
  narrative: NarrativeBlock[];
} {
  const p = isRecord(parsed) ? parsed : {}
  const items: MapItem[] = arr(p.items).slice(0, 40).map((it): MapItem | null => {
    const o = isRecord(it) ? it : { claim: String(it) }
    const claim = str(o.claim, '')
    if (claim === '') return null
    return {
      type: str(o.type, '分论点'),
      claim,
      evidence: str(o.evidence, '原文未提供证据'),
      quote: str(o.quote, ''),
      source: str(o.source, ''),
      confidence: str(o.confidence, ''),
      relations: arr(o.relations).slice(0, 6).map((r) => {
        const ro = isRecord(r) ? r : { type: String(r) }
        return { to: str(ro.to, ''), type: str(ro.type, '支持') }
      }).filter((r) => r.to !== ''),
    }
  }).filter((x): x is MapItem => x !== null)
  const dataPoints: DataPoint[] = arr(p.dataPoints).slice(0, 30).map((d) => {
    const o = isRecord(d) ? d : { value: String(d) }
    return {
      value: str(o.value, ''), period: str(o.period, ''), subject: str(o.subject, ''),
      baseline: str(o.baseline, ''), source: str(o.source, ''), location: str(o.location, ''),
    }
  }).filter((d) => d.value !== '')
  return {
    title: str(p.title, '未命名论文'),
    summary: str(p.summary, ''),
    coreQuestion: str(p.coreQuestion, ''),
    coreConclusions: arr(p.coreConclusions).slice(0, 5).map((c) => String(c)).filter((c) => c !== ''),
    items,
    dataPoints,
    caveats: arr(p.caveats).slice(0, 10).map((c) => String(c)).filter((c) => c !== ''),
    recallQuestions: arr(p.recallQuestions).slice(0, 6).map((q) => String(q)).filter((q) => q !== ''),
    figures: arr(p.figures).slice(0, 20).map((f) => {
      const o = isRecord(f) ? f : { ref: String(f) }
      return { ref: str(o.ref, ''), caption: str(o.caption, ''), meaning: str(o.meaning, '') }
    }).filter((f) => f.ref !== ''),
    concepts: arr(p.concepts).slice(0, 8).map((it) => {
      const o = isRecord(it) ? it : { term: String(it) }
      return { term: str(o.term, ''), explanation: str(o.explanation, '') }
    }).filter((c) => c.term !== ''),
    quotes: arr(p.quotes).slice(0, 5).map((it) => {
      const o = isRecord(it) ? it : { text: String(it) }
      return { text: str(o.text, ''), context: str(o.context, ''), source: str(o.source, '') }
    }).filter((q) => q.text !== ''),
    mindmap: sanitizeMind(p.mindmap, 0),
    card: sanitizeStudyCard(p.card),
    narrative: sanitizeNarrative(p.narrative),
  }
}

function narrativeFigureIndex(raw: unknown): number {
  const s = typeof raw === 'number' && Number.isFinite(raw) ? String(Math.floor(raw)) : str(raw, '')
  const m = s.match(/(\d{1,2})/)
  if (!m) return 0
  const n = Number(m[1])
  return n >= 1 && n <= 12 ? n : 0
}

function sanitizeNarrative(raw: unknown): NarrativeBlock[] {
  return arr(raw).slice(0, 8).map((it): NarrativeBlock | null => {
    const o = isRecord(it) ? it : {}
    const heading = str(o.heading, '').slice(0, 40)
    const bodyZh = str(o.bodyZh, '').slice(0, 900)
    const bodyEn = str(o.bodyEn, '').slice(0, 1400)
    if (!heading || (!bodyZh && !bodyEn)) return null
    const fromList = Array.isArray(o.figures) ? o.figures : []
    const picked = [...fromList, o.figure]
    const figures: number[] = []
    for (const item of picked) {
      const n = narrativeFigureIndex(item)
      if (n && !figures.includes(n)) figures.push(n)
      if (figures.length >= 3) break
    }
    return {
      heading,
      bodyZh,
      bodyEn,
      quote: str(o.quote, '').slice(0, 1600),
      figures,
    }
  }).filter((b): b is NarrativeBlock => b !== null)
}

/** mindmap 递归清洗：深度 ≤4、每层子节点 ≤8、label ≤120 字；根节点空则整树丢弃 */
function sanitizeMind(node: unknown, depth: number): MindNode | undefined {
  if (depth > 4 || !isRecord(node)) return undefined
  const label = str(node.label, '').slice(0, 120)
  if (label === '') return undefined
  const children = arr(node.children).slice(0, 8)
    .map((c) => sanitizeMind(c, depth + 1))
    .filter((c): c is MindNode => c !== undefined)
  return { label, children }
}

/* ---------- input loading（本地文件：pdf / txt / md / html） ---------- */

async function loadFileText(ctx: HostContext, path: string, onProgress: ((line: string) => void) | null): Promise<{ text: string; source: string; figures: PdfFigureImg[] }> {
  const lower = path.toLowerCase()
  if (lower.endsWith('.pdf')) {
    if (!isBinaryFileService(ctx.fs)) throw new Error('文件服务不可用，无法读取 PDF')
    const target = await ctx.fs.resolve(path) as never
    // 与上传上限一致：30–50MiB 的 PDF 可以入库，也要能精读。
    const bytes = await ctx.fs.readBytes(target, undefined, 50 * 1024 * 1024)
    const latin = Buffer.from(bytes).toString('latin1')
    let extracted = ''
    try {
      let lastPct = -1
      extracted = await extractPdfPlainText(bytes, onProgress === null ? undefined : (info) => {
        if (info.done === 0) {
          onProgress('解析 PDF 中…（共 ' + info.total + ' 页）')
          return
        }
        const total = Math.max(1, info.total)
        const pct = Math.round((info.done / total) * 100)
        if (info.done >= total || pct >= lastPct + 10) {
          lastPct = pct
          onProgress('解析 PDF 中… ' + pct + '%（' + info.done + '/' + info.total + ' 页）')
        }
      })
    } catch (error) {
      throw new Error('PDF 解析失败：' + errorMessage(error))
    }
    if (extracted.trim() === '') throw new Error('这是扫描版或图片型 PDF：页面里没有可提取的文字层，无法精读。请换一份带文字层的 PDF，或先做 OCR 再导入。')
    let figures: PdfFigureImg[] = []
    try {
      figures = extractPdfFigures(latin).images.slice(0, 12)
    } catch { /* 提图失败不影响精读 */ }
    return { text: extracted, source: path, figures }
  }
  if (/\.(txt|md|markdown|html|htm|json|log)$/i.test(lower)) {
    if (!isTextFileService(ctx.fs)) throw new Error('文件服务不可用，无法读取文件')
    const target = await ctx.fs.resolve(path) as never
    let content = await ctx.fs.readText(target)
    if (/\.(html|htm)$/i.test(lower)) content = content.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ')
    return { text: content, source: path, figures: [] }
  }
  throw new Error('暂不支持的文件类型：' + path + '（支持 .pdf / .txt / .md / .html）')
}

/* ---------- engine ---------- */

export interface ReadEngine {
  /** 同步执行到完成（加载+全管线；批量路由在外层自己包 job 用这个） */
  readSync(input: ReadInput, onProgress?: ((line: string) => void) | null, signal?: AbortLike): Promise<PaperOutcome | QuickOutcome>
  /** 单篇入口：paper 长文自动转官方后台任务并返回 jobId；短文前台完成 */
  read(input: ReadInput, opts?: { jobs?: JobsService; owner?: unknown; onProgress?: ((line: string) => void) | null; onResult?: (outcome: PaperOutcome | QuickOutcome) => Promise<void> | void }): Promise<ReadOutcome>
}

export function createReadEngine(ctx: HostContext, preferredModel?: PreferredModelFn, preferFallback?: boolean | (() => boolean)): ReadEngine {
  const figureReader = createFigureReader(ctx, preferredModel, preferFallback)
  // 自校准/预算已裁剪：token 估算仅用于分段进度口径，粗估即可
  const { callModelJson, pickConfig } = (() => {
    const noop = () => undefined
    return createLlmRuntime({
      ctx: ctx as never,
      estimateTokens: (t) => Math.ceil(t.length * 0.6),
      llmCallStats: { calls: 0, ms: 0 },
      recordCalibration: noop as never,
      preferredModel,
      preferFallback,
    })
  })()

  async function runFlow(text: string, source: string, figures: PdfFigureImg[], input: ReadInput, onProgress: ((line: string) => void) | null, signal: AbortLike): Promise<PaperOutcome | QuickOutcome> {
    throwIfCancelled(signal)
    const started = Date.now()
    const cfg = await pickConfig()
    // 默认中文输出：中文科研工作流里英文论文的报告也要中文表述
    // （术语与原文摘录按提示词要求保留原文；显式传 language 才覆盖）
    const language = input.language ?? 'zh'
    const focus = input.focus ?? ''
    if (text.length > MAX_INPUT_CHARS) text = text.slice(0, MAX_INPUT_CHARS)

    if (input.mode === 'quick') {
      const limited = text.length > 30000 ? text.slice(0, 30000) : text
      if (onProgress !== null) onProgress('速读中…')
      const quickNotes = (input.readerNotes ?? '').trim()
      const parsed = await callModelJson(cfg, quickSystem(language, focus), sectionUser(limited, 0, 1)
        + (quickNotes ? '\n\n【读者高亮与批注】\n' + quickNotes.slice(0, 2000) : ''), 3000, signal)
      const s = sanitizeQuick(parsed)
      return { kind: 'quick', ...s, meta: { source, chars: limited.length, chunks: 1, mode: 'quick', durationMs: Date.now() - started, chunksText: [limited] } }
    }

    // paper：短论文单次；长论文按章节分段，逐段提取后再汇总。
    // VLM 读图：对前 8 张非空白图做视觉解读；首图探测失败/纯文本模型自动降级。
    const catalog = extractFigureCatalog(text)
    const catalogBlock = catalog.length === 0 ? ''
      : '\n\n【论文图号（从正文图注抽出，页码是 PDF 物理页，和下面的【图N】不是同一套编号）】\n'
        + catalog.map((c) => 'Figure ' + c.n + ' 第' + c.page + '页 ' + c.caption).join('\n')
    const notes = (input.readerNotes ?? '').trim()
    const notesBlock = notes === '' ? ''
      : '\n\n【读者高亮与批注（读者自己标的，不是作者原文；写入报告时标明是读者标注）】\n' + notes.slice(0, 4000)
    const briefing = catalogBlock + notesBlock
    const figureHint = catalog.slice(0, 12).map((c) => '图' + c.n + ' 第' + c.page + '页 ' + c.caption).join('\n')
    const figureDescList: string[] = []
    const figurePages: Array<{ n: number; page: number } | null> = []
    /** undefined = VLM 未跑（沿用全部抽出图）；array = VLM 筛选后的子集（可为空） */
    let figuresForReport: PdfFigureImg[] | undefined
    if (input.mode === 'paper' && input.vlm !== false && figures.length > 0 && figureReader.usable) {
      const top = figures.slice(0, 8)
      const kept: PdfFigureImg[] = []
      for (let i = 0; i < top.length; i++) {
        throwIfCancelled(signal)
        if (onProgress !== null) onProgress('VLM 读图 ' + (i + 1) + '/' + top.length + '…')
        const raw = await figureReader.describeFigure(top[i]!, figureHint, signal)
        throwIfCancelled(signal)
        if (!figureReader.usable) break
        const tag = parseFigTag(raw)
        const d = (tag?.rest || raw).trim()
        if (!d || isBlankFigureDescription(d)) continue
        kept.push(top[i]!)
        figureDescList.push(d)
        figurePages.push(tag ? { n: tag.n, page: tag.page } : null)
      }
      figuresForReport = kept
    }
    const figureDescriptions = figureDescList.map((d, i) => '[图' + (i + 1) + '] ' + d).join('\n')
    const figureMeta = {
      figureDescriptions: figureDescList,
      figuresImgs: figuresForReport !== undefined ? figuresForReport : (figures.length > 0 ? figures : undefined),
      ...(catalog.length > 0 ? { figureCatalog: catalog } : {}),
      ...(figurePages.length > 0 ? { figurePages } : {}),
    }
    if (text.length <= SINGLE_SHOT_CHARS) {
      if (onProgress !== null) onProgress('学术精读中…')
      const parsed = await callModelJson(cfg, paperSystem(language, focus, false),
        '以下是待整理的内容：\n\n' + text + '\n\n注意：若原文中出现【第N页】标记，source 和 location 字段请使用页码。'
        + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : '')
        + briefing, 8000, signal)
      const s = sanitizePaper(parsed)
      return { kind: 'paper', ...s, meta: { source, chars: text.length, chunks: 1, mode: 'paper', durationMs: Date.now() - started, chunksText: [text], ...figureMeta } }
    }
    const chunks: ChunkDigest[] = []
    const gaps: number[] = []
    let parts = splitChunksPaper(text, CHUNK_CHARS)
    if (parts.length > MAX_PARTS) parts = parts.slice(0, MAX_PARTS)
    // 分段串行：套餐常限并发，2 路并行易把整批打成空结果/429；失败记缺口继续
    {
      const total = parts.length
      const digests: Array<ChunkDigest | undefined> = new Array(total)
      const failReasons: string[] = []
      let done = 0
      for (let i = 0; i < total; i++) {
        throwIfCancelled(signal)
        if (onProgress !== null) onProgress('学术精读第 ' + (i + 1) + '/' + total + ' 段…')
        try {
          const parsed = await callModelJson(cfg, paperChunkSystem(language, focus), sectionUser(parts[i]!, i, total), 5000, signal)
          const s = sanitizeQuick(parsed)
          digests[i] = { title: s.title, summary: s.summary, thesis: s.thesis, arguments: s.arguments, concepts: s.concepts, quotes: s.quotes, caveats: s.caveats }
          done++
          if (onProgress !== null) onProgress('完成 ' + done + '/' + total + ' 段')
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          if (signal.aborted) throw err
          gaps.push(i)
          failReasons.push('第' + (i + 1) + '段：' + msg.slice(0, 160))
          console.error(`[dsh-scholar] 分段 ${i + 1}/${total} 提取失败（记缺口继续）:`, msg.slice(0, 200))
        }
      }
      for (const d of digests) if (d) chunks.push(d)
      if (chunks.length === 0) {
        const hint = failReasons.slice(0, 3).join(' | ')
        throw new Error(
          '全部分段提取失败（模型未返回可用 JSON）'
          + (hint ? '：' + hint : '')
          + '。请确认对话里选用的模型可用、额度充足；可改用非推理/轻量模型，或勾选「轻量精读」重试。',
        )
      }
    }
    // 汇总材料全量保留（旧引擎的做法）：slice 只防模型超发，不做二次压缩
    const condensed = chunks.map((c) => ({
      title: c.title, summary: c.summary, thesis: c.thesis,
      arguments: c.arguments,
      concepts: c.concepts,
      quotes: c.quotes,
      caveats: c.caveats,
    }))
    if (onProgress !== null) onProgress('论文汇总中…')
    // 综合直喂全文（≤20 万字）：分段摘要只作辅助索引——数字/表号以原文为准，
    // 解决"压缩材料重建数字易糊"的漏斗问题；超长文回退纯摘要综合。
    const gapNote = gaps.length > 0
      ? '\n\n【注意】第 ' + gaps.map((g) => g + 1).join('、') + ' 部分的分段提取失败缺失'
        + (text.length <= FULLTEXT_SYNTHESIS_CHARS ? '——请从全文中补全这些部分的内容。' : '——这些部分内容缺失，报告相应处如实处理。')
      : ''
    const digestPrompt = '全文共 ' + text.length + ' 字（超长未直喂），以下 JSON 数组是各部分已提取的要点：\n\n' + JSON.stringify(condensed)
      + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : '') + gapNote + briefing
    const fullPrompt = text.length <= FULLTEXT_SYNTHESIS_CHARS
      ? '以下是论文全文（' + text.length + ' 字，以它为准）：\n\n' + text
        + '\n\n以下 JSON 数组是分段预提取的要点（仅作导航索引，与全文冲突时以全文为准）：\n' + JSON.stringify(condensed)
        + (figureDescriptions !== '' ? '\n\n【图表视觉解读（VLM）】\n' + figureDescriptions : '') + gapNote + briefing
      : digestPrompt
    // 四级综合降级链：全文单次（最优，交叉引用最连贯）→ 分半双次（各出一半字段，
    // 生成时间减半——后端半血时大生成最容易空返回，拆小是硬解）→ 摘要综合 →
    // 分段成果确定性拼装。保证重读永不空手而归，且尽量不落到"只见摘要"的档位。
    let s: ReturnType<typeof sanitizePaper>
    let synthMode = 'fulltext'
    if (input.light === true && text.length > SINGLE_SHOT_CHARS) {
      // 轻量档（用户显式选择，非降级）：直接摘要综合——旧引擎的调用模式，
      // 跳过全文大调用，快且 API 差时稳；精度略降（符号/交叉细节可能走样）
      if (onProgress !== null) onProgress('轻量档：摘要综合…')
      try {
        s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
        synthMode = 'light'
      } catch (err) {
        if (signal.aborted) throw err
        s = assembleFromChunks(chunks)
        synthMode = 'assembled'
      }
    } else
    try {
      s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), fullPrompt, 12000, signal))
    } catch (err) {
      if (signal.aborted) throw err
      // 超上下文类错误：分半也喂全文（同样超），直接跳到摘要档省两次注定失败的调用
      const overflow = /context|too many tokens|exceed|超长|上下文/i.test(err instanceof Error ? err.message : String(err))
      if (overflow) {
        if (onProgress !== null) onProgress('全文超模型上下文，改用分段摘要综合…')
        try {
          s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
          synthMode = 'digest'
        } catch {
          s = assembleFromChunks(chunks)
          synthMode = 'assembled'
        }
      } else
      if (onProgress !== null) onProgress('全文汇总失败，改用分半综合（两次小生成）…')
      try {
        const partA = fullPrompt + '\n\n【分半综合·数据部分】本次只输出 items、dataPoints、figures 三个字段，其余字段一律不要输出。'
        const partB = fullPrompt + '\n\n【分半综合·叙述部分】本次只输出 summary、coreQuestion、coreConclusions、mindmap、concepts、quotes、caveats、recallQuestions、narrative 字段，items/dataPoints/figures 一律不要输出。'
        const a = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), partA, 10000, signal))
        if (onProgress !== null) onProgress('分半综合 1/2 完成，叙述部分…')
        const b = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), partB, 10000, signal))
        s = { ...b, items: a.items, dataPoints: a.dataPoints, figures: a.figures }
        synthMode = 'split'
      } catch (err2) {
        if (signal.aborted) throw err2
        if (onProgress !== null) onProgress('分半综合也失败，改用分段摘要综合…')
        try {
          s = sanitizePaper(await callModelJson(cfg, paperSystem(language, focus, true), digestPrompt, 12000, signal))
          synthMode = 'digest'
        } catch (err3) {
          if (signal.aborted) throw err3
          if (onProgress !== null) onProgress('摘要综合也失败，用分段成果直接拼装报告…')
          s = assembleFromChunks(chunks)
          synthMode = 'assembled'
        }
      }
    }
    return { kind: 'paper', ...s, meta: { source, chars: text.length, chunks: chunks.length, mode: 'paper', durationMs: Date.now() - started, chunksText: parts, ...figureMeta, synth: synthMode, ...(gaps.length > 0 ? { gaps: gaps.map((g) => g + 1) } : {}) } }
  }

/** 综合彻底失败时的兜底：把分段提取成果确定性拼装成 paper 结果（零 LLM）。
 *  质量次于模型综合，但保住几十分钟分段工作的产出——重读永不空手而归。 */
/** claim 相似度（ASCII 词 + 中文 bigram 的 Jaccard）：拼装档去重相邻段重复论点 */
function claimTokens(s: string): Set<string> {
  const t = new Set<string>()
  const norm = s.toLowerCase()
  for (const w of norm.matchAll(/[a-z0-9]+/g)) if (w[0]!.length > 2) t.add(w[0]!)
  for (let i = 0; i + 2 <= norm.length; i++) {
    const seg = norm.slice(i, i + 2)
    if (!/[a-z0-9]/.test(seg)) t.add(seg)
  }
  return t
}

function assembleFromChunks(chunks: ChunkDigest[]): ReturnType<typeof sanitizePaper> {
  const items: MapItem[] = []
  const seenClaims: Array<Set<string>> = []
  outer: for (const c of chunks) {
    for (const a of c.arguments.slice(0, 3)) {
      const toks = claimTokens(a.claim)
      for (const prev of seenClaims) {
        let inter = 0
        for (const x of toks) if (prev.has(x)) inter++
        if (toks.size > 0 && inter / Math.min(toks.size, prev.size) > 0.6) continue outer // 相邻段重复论点，跳过
      }
      seenClaims.push(toks)
      items.push({
        type: '分论点',
        claim: a.claim,
        evidence: a.evidence,
        quote: a.quote,
        source: a.source,
        confidence: '原文事实与数据',
        relations: [],
      })
    }
  }
  const conceptMap = new Map<string, { term: string; explanation: string }>()
  for (const c of chunks) for (const k of c.concepts) if (!conceptMap.has(k.term)) conceptMap.set(k.term, k)
  const quotes: Array<{ text: string; context: string; source: string }> = []
  for (const c of chunks) quotes.push(...c.quotes.slice(0, 1))
  const caveats = chunks.flatMap((c) => c.caveats).slice(0, 10)
  const title = chunks[0]?.title ?? '未命名论文'
  return {
    title,
    summary: chunks.map((c) => c.summary).filter(Boolean).join('；').slice(0, 320),
    coreQuestion: chunks[0]?.thesis ?? '',
    coreConclusions: chunks.slice(0, 3).map((c) => c.thesis).filter((t) => t !== '').slice(0, 3),
    items: items.slice(0, 30),
    dataPoints: [],
    caveats,
    recallQuestions: [],
    figures: [],
    concepts: [...conceptMap.values()].slice(0, 8),
    quotes: quotes.slice(0, 5),
    narrative: [],
    mindmap: {
      label: title.slice(0, 60),
      children: chunks.slice(0, 10).map((c) => ({
        label: c.title.slice(0, 40),
        children: c.arguments.slice(0, 2).map((a) => ({ label: a.claim.slice(0, 60), children: [] as MindNode[] })),
      })),
    },
  }
}

  async function readSyncInner(input: ReadInput, onProgress: ((line: string) => void) | null, signal: AbortLike): Promise<PaperOutcome | QuickOutcome> {
    const { text, source, figures } = await loadFileText(ctx, input.path, onProgress)
    const outcome = await runFlow(text, source, figures, input, onProgress, signal)
    // runFlow 已按 VLM 筛选写入 figuresImgs；仅在未跑 VLM 时回填抽出全集
    if (outcome.meta.figuresImgs === undefined && figures.length > 0) outcome.meta.figuresImgs = figures
    return outcome
  }

  return {
    readSync: (input, onProgress = null, signal = { aborted: false }) => readSyncInner(input, onProgress, signal),
    async read(input, opts = {}): Promise<ReadOutcome> {
      const signal: { aborted: boolean } = { aborted: false }
      const jobs = opts.jobs ?? (ctx.get('jobs') as JobsService | undefined)
      let text = ''
      let source = input.path
      let figures: PdfFigureImg[] = []
      try {
        const loaded = await loadFileText(ctx, input.path, null)
        text = loaded.text
        source = loaded.source
        figures = loaded.figures
      } catch (err) {
        // 加载失败也走前台,把错误正常抛给调用方
        throw err
      }

      const isLong = input.mode === 'paper' && text.length > CHUNK_CHARS
      if (isLong && jobs !== undefined && typeof jobs.start === 'function') {
        const label = '学者精读「' + source.replace(/^.*[\\/]/, '') + '」· ' + Math.min(Math.ceil(text.length / CHUNK_CHARS), MAX_PARTS) + ' 段'
        const lines: string[] = []
        let cancelled = false
        let cancelReason = ''
        let resolveDone!: (value: { status: string; detail?: string }) => void
        const donePromise = new Promise<{ status: string; detail?: string }>((resolve) => { resolveDone = resolve })
        let finalResult: PaperOutcome | QuickOutcome | null = null
        try {
          const jobId = await jobs.start({
            kind: 'scholar-read',
            label,
            outputLimitBytes: 256 * 1024,
            owner: opts.owner,
            run: () => {
              void (async () => {
                try {
                  finalResult = await runFlow(text, source, figures, input, (line) => { if (line !== '') lines.push(line) }, signal)
                  lines.push('精读完成：' + finalResult.title)
                  // 后台完成即在任务内归档（工具路径的 paper_read 不再丢报告）
                  try {
                    if (opts.onResult !== undefined) await opts.onResult(finalResult)
                  } catch (err) {
                    lines.push('归档失败：' + errorMessage(err))
                  }
                  resolveDone({ status: 'completed' })
                } catch (err) {
                  const msg = errorMessage(err)
                  if (cancelled) {
                    lines.push('已取消：' + cancelReason)
                    resolveDone({ status: 'killed', detail: cancelReason })
                  } else {
                    lines.push('后台精读失败：' + msg)
                    resolveDone({ status: 'failed', detail: msg })
                  }
                }
              })()
              return {
                cancel(reason: unknown) {
                  cancelled = true
                  cancelReason = typeof reason === 'string' && reason !== '' ? reason : '已取消'
                  signal.aborted = true
                },
                done: donePromise,
                readOutput: () => { const out = lines.join('\n'); lines.length = 0; return out },
              }
            },
          })
          return { kind: 'background', jobId, label }
        } catch {
          // jobs 启动失败（owner 不被任何 controller 服务等）→ 前台降级直跑，
          // 宁可同步慢也不让整次精读报废
        }
      }
      const result = await runFlow(text, source, figures, input, opts.onProgress ?? null, signal)
      if (result.meta.figuresImgs === undefined && figures.length > 0) result.meta.figuresImgs = figures
      return { kind: 'result', result }
    },
  }
}
