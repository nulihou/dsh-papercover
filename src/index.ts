/**
 * dsh-scholar — host half.
 *
 * Cordis plugin providing:
 *  - file-backed config (~/.dsh/scholar-config.json) for paper directory / tags / Zotero / Obsidian
 *  - REST routes /scholar/* (papers / cards / graph / stats / config)
 *  - eleven agent-facing tools (paper_save / paper_fetch_pdf / paper_save_report /
 *    paper_update / paper_search / paper_get /
 *    idea_card_create / idea_card_search / idea_card_update / kg_extract / kg_query)
 *
 * Data lives as local JSON files under the configured paper directory
 * (see src/store.ts). All AI-generated content flows through tool arguments
 * produced in conversation — the host never calls an LLM itself.
 *
 * Config no longer uses `ctx.settings.register` (#4587 removed it) or Cordis
 * Config `.volatile()` (profile-resolved schemastery may lack that API).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { ScholarConfig } from './shared/types.js';
import { migratePaperDir, type PaperDirMigrateResult } from './migrate-paper-dir.js';
import { PaperStore } from './store.js';
import { registerScholarRoutes } from './routes.js';
import { registerScholarTools } from './tools.js';
import { setOpenalexContact } from './related.js';
import { DEFAULT_JEV_PREFER, scholarPreferFromConfig } from './jev-prefer.js';

export { scholarPreferFromConfig };

export const name = 'dsh-papercover';

/** Host services this plugin waits for (http carrier, tool registry, prompt assembly,
 *  llm/fs/attachments 供自有精读引擎：llm 流式调用、PDF 读取、VLM 图片附件）。 */
export const inject = ['webServer', 'tools', 'systemPrompt', 'llm', 'fs', 'attachments', 'agentDefaultModel'];

function defaultPaperDir(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  return `${home}/Documents/ResearchPapers`;
}

function configPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? process.cwd();
  return join(home, '.dsh', 'scholar-config.json');
}

function looksLikeJevModel(model: string): boolean {
  return /^jev([-_.]|$)/i.test(model.trim());
}

function normalize(raw: Partial<ScholarConfig> | null | undefined): ScholarConfig {
  let llmProvider = (raw?.llmProvider ?? '').trim();
  let llmModel = (raw?.llmModel ?? '').trim();
  let preferProvider = (raw?.preferProvider ?? '').trim();
  let preferModel = (raw?.preferModel ?? '').trim();
  let jevDecide = raw?.jevDecide === true;

  // Older builds mistakenly seeded study LLM to Jev (System One ≠ chat).
  // Lift that route into the dedicated Jev API block and clear study override.
  if ((!preferProvider || !preferModel) && looksLikeJevModel(llmModel)) {
    preferProvider = preferProvider || llmProvider || DEFAULT_JEV_PREFER.preferProvider;
    preferModel = preferModel || llmModel;
    if (raw?.jevDecide === undefined) jevDecide = true;
    llmProvider = '';
    llmModel = '';
  }

  return {
    paperDir: (raw?.paperDir ?? '').trim() || defaultPaperDir(),
    defaultTags: raw?.defaultTags ?? [],
    fetchProxy: (raw?.fetchProxy ?? '').trim(),
    openalexEmail: (raw?.openalexEmail ?? '').trim(),
    researchFocus: raw?.researchFocus ?? '',
    // Study jobs use a normal chat model (or host default). Never seed Jev here.
    llmProvider,
    llmModel,
    preferFallback: raw?.preferFallback !== false,
    jevDecide,
    preferProvider,
    preferModel,
    preferBaseURL: (raw?.preferBaseURL ?? '').trim() || DEFAULT_JEV_PREFER.preferBaseURL,
    preferApiKeyEnv: (raw?.preferApiKeyEnv ?? '').trim() || DEFAULT_JEV_PREFER.preferApiKeyEnv,
    vlmFigures: raw?.vlmFigures === 'off' ? 'off' : 'auto',
    zoteroSyncEnabled: Boolean(raw?.zoteroSyncEnabled),
    zoteroBaseUrl: (raw?.zoteroBaseUrl ?? '').trim() || 'http://127.0.0.1:23119/api',
    zoteroLibrary: (raw?.zoteroLibrary ?? '').trim() || 'user/0',
    zoteroApiKey: (raw?.zoteroApiKey ?? '').trim(),
    zoteroServerId: (raw?.zoteroServerId ?? '').trim(),
    obsidianVault: (raw?.obsidianVault ?? '').trim(),
    obsidianSubdir: (raw?.obsidianSubdir ?? '').trim() || 'Scholar',
  };
}

async function loadConfigFile(): Promise<ScholarConfig> {
  try {
    const text = await readFile(configPath(), 'utf8');
    return normalize(JSON.parse(text) as Partial<ScholarConfig>);
  } catch (error) {
    // Missing or unreadable file → defaults; keep boot going.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[dsh-scholar] config read failed, using defaults:', error instanceof Error ? error.message : error);
    }
    return normalize(undefined);
  }
}

async function saveConfigFile(config: ScholarConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * @param ctx Host plugin context.
 */
export function apply(ctx: Context) {
  // 科研精读动线：把 保存 → 精读 → 沉淀 串成 agent 的默认工作方式
  ctx.effect(
    () => (ctx as any).systemPrompt.section({
      name: 'dsh-scholar-workflow',
      order: 151,
      text: [
        '科研论文动线（用户要求保存、精读、沉淀论文时严格遵守）：',
        '1) 保存：用 paper_save 入库；参数带 arxivId 时会自动从 arXiv 下载 PDF 归档，无需手动处理；',
        '   非 arXiv 来源会返回 pdfWarning，转告用户在论文详情页手动上传。',
        '2) 精研：用 paper_read 工具（dsh-papercover自带引擎，读论文 PDF→自动归档精研报告与精研卡并回填 summary，',
        '   长文自动转后台任务）。**对话中一律裸读**：mode=paper（速读筛文献用 quick），',
        '   不自动拼 focus——不拼研究方向/学术透镜/库内相关论文/已有卡（让论文自己说话，',
        '   上下文堆叠会带偏理解）。唯一例外：用户消息里明确点名了具体关注点时，',
        '   可仅把用户点名的原话作为 focus 传入，不要自行扩展。',
        '   **禁止旁路**：不要自己读 PDF/抽文本再手写 HTML 报告用 paper_save_report 归档，',
        '   也不要声称用某个"精读引擎"——一律走 paper_read（手写报告会丢追问会话、',
        '   对比原料、模式标记，且格式与库内不一致）。paper_save_report 仅限归档',
        '   用户明确提供的、非精读产出的外部 HTML。',
        '   - 需要带研究方向/透镜/相关论文的复读（对比定位、迁移分析）：**引导用户用',
        '     论文库详情页的「精读」面板**（可勾选上下文、编辑 focus、批量多篇、进度可见），',
        '     不要在对话里拼这些上下文。',
        '   - 速读/筛文献：mode=quick。',
        '   - 轻量档：用户说"轻量精读/快速深读/API 忙就随便读下"时 paper_read 传 light=true',
        '   （长文综合走摘要，快而稳，精度略降）；默认不传（标准深读）。',
        '   - **长文转后台任务后：用 job_output（wait:true, timeout 90s）轮询并向用户播报进度**',
        '     （"第 3/8 段完成，正在读第 4 段"），未完成就继续轮询——用户应能在对话里看到精读走到哪一步。',
        '3) 沉淀：从精读结论提取 1-3 条创新点，用 idea_card_create 建卡并标注来源论文',
        '   （evidence 引用报告中的具体数据与表号；报告可用 paper_read 的 path 参数速读已归档文件）。',
        '4) 追问：用户对某篇论文提具体问题时用 paper_ask（带页码出处的交互式精读）。',
        '5) 批注：用户要「批注到PDF / 写入dsh-papercover批注 / 标出重点」时，必须用 paper_annotate',
        '   （paperId + annotations JSON：page/text/note/color），不要只在对话里列建议。',
        '   写入前可用 paper_annotations 查看已有批注；删改用 paper_annotate_remove。',
        '   text 必须是 PDF 可检索的原文摘录；color 用 mark|insight|method|result|claim|warn。',
        '用户提到的论文尚未入库时，先 paper_save 再走上述流程。',
      ].join('\n'),
    }),
    'dsh-scholar: workflow prompt',
  );

  // 研究方向常驻注入：供建卡/回答研究问题时的方向感；对话精读已改为一律裸读，
  // 带方向的复读引导到论文库精读面板（面板会取设置页的研究方向预填 focus）。
  ctx.effect(
    () => (ctx as any).systemPrompt.context({
      name: 'scholar:research-focus',
      order: 152,
      text: () => {
        const focus = (getConfig().researchFocus ?? '').trim().slice(0, 400);
        if (focus === '') return '';
        return `[dsh-papercover·研究方向] ${focus}\n（对话中精研不拼 focus；带方向的复读请引导用户用典藏「精研」面板。）`;
      },
    }),
    'dsh-scholar: research focus context',
  );

  let current = normalize(undefined);
  let configReady: Promise<void> = loadConfigFile().then(async (cfg) => {
    current = cfg;
    setOpenalexContact(current.openalexEmail || undefined);
    // Persist one-time lift of Jev-as-study-model → dedicated Jev API fields.
    try {
      const disk = await readFile(configPath(), 'utf8').catch(() => '');
      if (disk) {
        const raw = JSON.parse(disk) as Partial<ScholarConfig>;
        const studyWasJev = looksLikeJevModel((raw.llmModel ?? '').trim());
        const missingJevBlock = !(raw.preferProvider && raw.preferModel);
        if (studyWasJev && missingJevBlock) await saveConfigFile(current);
      }
    } catch {
      /* ignore rewrite failures — runtime config is already normalized */
    }
  }).catch((err) => {
    console.warn('[dsh-scholar] config boot load failed:', err instanceof Error ? err.message : err);
  });

  const getConfig = (): ScholarConfig => {
    setOpenalexContact(current.openalexEmail || undefined);
    return current;
  };

  // Lazy singleton store, re-created when the configured directory changes.
  let storePromise: Promise<PaperStore> | null = null;
  let storeDir = '';

  const getStore = (): Promise<PaperStore> => {
    const dir = getConfig().paperDir;
    if (!storePromise || storeDir !== dir) {
      // 目录热切换：旧 store 打 disposed 标记，在途请求的后续写操作会显式失败
      // （而不是"写旧目录成功但新库里没有"）
      storePromise?.then((old) => old.dispose()).catch(() => {});
      storeDir = dir;
      const store = new PaperStore(dir);
      storePromise = store.init()
        .then(() => {
          const s = store.stats();
          console.log(`[dsh-scholar] 论文库就绪: ${dir}（${s.papers} 篇论文 / ${s.cards} 张卡片 / 图谱 ${s.nodes} 节点 ${s.edges} 边）`);
          return store;
        })
        .catch((err) => {
          storePromise = null;
          throw err;
        });
    }
    return storePromise;
  };

  const updateConfig = async (
    patch: Partial<ScholarConfig>,
  ): Promise<{ migrate?: PaperDirMigrateResult }> => {
    await configReady;
    const prevDir = current.paperDir;
    const next = normalize({ ...current, ...patch });
    let migrate: PaperDirMigrateResult | undefined;

    if (typeof patch.paperDir === 'string' && patch.paperDir.trim()) {
      const from = prevDir.trim();
      const to = next.paperDir.trim();
      if (from.toLowerCase() !== to.toLowerCase()) {
        // Stop writers against the old store before moving files on disk.
        storePromise?.then((old) => old.dispose()).catch(() => {});
        storePromise = null;
        storeDir = '';
        migrate = await migratePaperDir(from, to);
        console.log(`[dsh-scholar] paperDir migrate: ${migrate.message}`);
      }
    }

    current = next;
    setOpenalexContact(current.openalexEmail || undefined);
    await saveConfigFile(current);
    return migrate ? { migrate } : {};
  };

  registerScholarRoutes(ctx, getStore, getConfig, updateConfig);
  const toolCount = registerScholarTools(ctx, getStore, getConfig);

  console.log(`[dsh-scholar] host half ready: file config + /scholar/* routes + ${toolCount} agent tools`);
}
