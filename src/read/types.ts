import type { IncomingMessage, ServerResponse } from 'node:http'

export interface MapItem {
  type: string
  claim: string
  evidence: string
  quote?: string
  source: string
  confidence: string
  relations: Array<{ to: string; type: string }>
}

/** 结构提纲节点。深度不超过 4，叶子可以带数字。 */
export interface MindNode {
  label: string
  children: MindNode[]
}

/** 精读/追问取消句柄：可读 aborted；可选真实 AbortSignal 供模型流立刻中断。 */
export interface AbortLike {
  readonly aborted: boolean
  readonly signal?: AbortSignal
}

/** 新建可中断句柄（路由批跑与追问共用）。 */
export function createJobAbort(): { handle: AbortLike; abort(): void } {
  const ctrl = new AbortController()
  const handle: AbortLike = {
    get aborted() { return ctrl.signal.aborted },
    signal: ctrl.signal,
  }
  return { handle, abort: () => { if (!ctrl.signal.aborted) ctrl.abort() } }
}

export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: unknown
}

export interface LlmService {
  listProviders(): unknown
  listModels(provider: string): Promise<unknown>
  stream(options: unknown): AsyncIterable<unknown>
}

export interface FileService {
  resolve(path: string, options?: { cwd?: string }): Promise<unknown>
  readBytes(target: unknown, encoding?: unknown, maxBytes?: number): Promise<Uint8Array>
  readText(target: unknown): Promise<string>
  writeText(target: unknown, content: string): Promise<void>
}

export interface StorageTable<Key, RecordValue> {
  get(key: Key): unknown
  put(key: Key, value: RecordValue): void | Promise<void>
  delete(key: Key): void | Promise<void>
  entries(): Iterable<[unknown, unknown]>
}

export interface StorageDomainHandle {
  table(name: string): StorageTable<string, unknown>
  close(): void | Promise<void>
}

export interface StorageDomainService {
  open(spec: unknown): Promise<StorageDomainHandle>
}

export interface WebFetchResult {
  statusCode: number
  body?: { kind?: string; content?: string }
}

export interface WebService {
  fetch(options: { url: string }): Promise<WebFetchResult>
}

export interface JobController {
  signal?: AbortLike
  progress?(line: string): void
  update?(value: unknown): void
}

export interface JobsService {
  start(options: Record<string, unknown>): Promise<string>
}

export interface WebServerService {
  register(route: {
    kind: 'exact'
    path: string
    handler(req: IncomingMessage, res: ServerResponse): Promise<void>
  }): () => void
}

export interface SkillRegistration {
  name: string
  description: string
  content: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  source: 'bundled'
  resourceBase: { kind: 'directory'; path: string }
}

export interface SkillsService {
  register(skill: SkillRegistration): () => void
}

export interface HostInjectionFiber {
  dispose(): void | Promise<void>
}

export interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  [key: string]: unknown
}

export interface HostContext {
  fs?: unknown
  llm?: unknown
  tools: { register(tool: ToolLike): () => void }
  skills?: SkillsService
  webServer?: WebServerService
  storageDomain?: StorageDomainService
  effect(register: () => void | (() => void | Promise<void>)): void
  inject?(
    dependencies: readonly string[],
    callback: (ctx: HostContext) => void,
  ): HostInjectionFiber
  get(name: 'web'): WebService | undefined
  get(name: 'webServer'): WebServerService | undefined
  get(name: 'storageDomain'): StorageDomainService | undefined
  get(name: 'jobs'): JobsService | undefined
  get(name: 'agentDefaultModel'): { currentSelection(): unknown } | undefined
  get(name: string): unknown
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isHostContext(value: unknown): value is HostContext {
  if (!isRecord(value) || !isRecord(value.tools)) return false
  const fileServiceValid = value.fs === undefined || isRecord(value.fs)
  const llmServiceValid = value.llm === undefined || isRecord(value.llm)
  return fileServiceValid && llmServiceValid
    && typeof value.effect === 'function'
    && typeof value.get === 'function'
    && typeof value.tools.register === 'function'
}

export function isBinaryFileService(value: unknown): value is Pick<FileService, 'resolve' | 'readBytes'> {
  return isRecord(value)
    && typeof value.resolve === 'function'
    && typeof value.readBytes === 'function'
}

export function isTextFileService(value: unknown): value is Pick<FileService, 'resolve' | 'readText'> {
  return isRecord(value)
    && typeof value.resolve === 'function'
    && typeof value.readText === 'function'
}

export function isFileWriter(value: unknown): value is Pick<FileService, 'resolve' | 'writeText'> {
  return isRecord(value)
    && typeof value.resolve === 'function'
    && typeof value.writeText === 'function'
}

export function isLlmCatalogService(value: unknown): value is Pick<LlmService, 'listProviders' | 'listModels'> {
  return isRecord(value)
    && typeof value.listProviders === 'function'
    && typeof value.listModels === 'function'
}

export function isLlmStreamService(value: unknown): value is Pick<LlmService, 'stream'> {
  return isRecord(value)
    && typeof value.stream === 'function'
}

export function errorMessage(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : String(error)
}
