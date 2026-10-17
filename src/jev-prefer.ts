/**
 * Shared Jev/prefer decision helper (copy into plugins that cannot import across trees).
 *
 * Jev (`jev-*`) is a TypeSafe System One decision model: it does NOT speak
 * Chat Completions or Responses. Prefer calls use POST `{baseURL}/systemone`
 * with typed questions. Non-jev prefer models still use `ctx.llm.stream`, then
 * sticky-fall back to agentDefaultModel.
 */

export interface PreferModelConfig {
  /** Empty disables prefer. */
  preferProvider: string
  /** Empty disables prefer. */
  preferModel: string
  /** Sticky-fall back when prefer fails with quota/auth/unavailable. Default true. */
  preferFallback: boolean
  /** Master switch for Jev-assisted decisions. Default false unless the plugin seeds true. */
  jevDecide: boolean
  /**
   * HTTPS origin + version prefix for System One (no trailing slash).
   * User-supplied origin, no trailing slash. POST `{baseURL}/systemone`.
   */
  preferBaseURL: string
  /** Credential ref / env name for the System One Bearer token. Default `DEV_API_KEY`. */
  preferApiKeyEnv: string
}

export interface PreferLlmLike {
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

export interface PreferCredentialsLike {
  resolve(ref: string): Promise<{ value?: string } | undefined>
}

export interface PreferHostLike {
  llm?: PreferLlmLike | unknown
  get?(name: 'agentDefaultModel'): { currentSelection(): unknown } | undefined
  get?(name: 'credentials'): PreferCredentialsLike | undefined
}

export interface ModelRef {
  provider: string
  model: string
}

/** One attempt inside {@link decideWithPreferDetailed}. */
export interface PreferAttempt {
  readonly provider: string
  readonly model: string
  readonly role: 'prefer' | 'fallback'
  readonly ok: boolean
  readonly error?: string
}

/** Structured outcome for UI / probes. */
export type PreferDecisionResult =
  | {
      readonly ok: true
      readonly value: unknown
      readonly provider: string
      readonly model: string
      readonly role: 'prefer' | 'fallback'
      readonly attempts: readonly PreferAttempt[]
    }
  | {
      readonly ok: false
      readonly error: string
      readonly attempts: readonly PreferAttempt[]
    }

/** A System One Choice question (option id → short description). */
export interface PreferChoiceQuestion {
  readonly id: string
  readonly instructions: string
  readonly options: Readonly<Record<string, string>>
}

export function resolvePreferConfig(raw: Partial<PreferModelConfig> | undefined, defaults?: Partial<PreferModelConfig>): PreferModelConfig {
  const d = defaults ?? {}
  return {
    preferProvider: typeof raw?.preferProvider === 'string' ? raw.preferProvider.trim() : (d.preferProvider ?? ''),
    preferModel: typeof raw?.preferModel === 'string' ? raw.preferModel.trim() : (d.preferModel ?? ''),
    preferFallback: raw?.preferFallback !== false && d.preferFallback !== false,
    jevDecide: raw?.jevDecide === true || d.jevDecide === true,
    preferBaseURL: typeof raw?.preferBaseURL === 'string' && raw.preferBaseURL.trim()
      ? raw.preferBaseURL.trim().replace(/\/+$/, '')
      : (d.preferBaseURL ?? DEFAULT_JEV_PREFER.preferBaseURL),
    preferApiKeyEnv: typeof raw?.preferApiKeyEnv === 'string' && raw.preferApiKeyEnv.trim()
      ? raw.preferApiKeyEnv.trim()
      : (d.preferApiKeyEnv ?? DEFAULT_JEV_PREFER.preferApiKeyEnv),
  }
}

export function hasPrefer(config: PreferModelConfig): boolean {
  return config.jevDecide && config.preferProvider !== '' && config.preferModel !== ''
}

/** True when the prefer model is a TypeSafe Jev System One model. */
export function isJevSystemOneModel(model: string): boolean {
  return /^jev([.-]|$)/i.test(model.trim())
}

export function isPreferExhaustionError(message: string): boolean {
  return /rate.?limit|quota|insufficient|billing|余额|额度|429|402|credit|capacity|overloaded|too many requests|exhausted|余额不足|额度不足|insufficient_quota|token.?limit|payment|exceeded|provider.*(not found|unavailable|missing)|model.*(not found|unavailable|invalid)|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|unauthorized|401|403|forbidden|invalid.?api.?key|api.?key|MISSING_CREDENTIAL|no credential|authentication_error/i.test(
    String(message),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseJson(text: string): unknown {
  let cleaned = String(text).trim()
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const attempts = [cleaned]
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end > start) attempts.push(cleaned.slice(start, end + 1))
  for (const raw of attempts) {
    try {
      return JSON.parse(raw)
    } catch {
      try {
        return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))
      } catch {
        /* keep going */
      }
    }
  }
  return null
}

function fallbackModel(ctx: PreferHostLike): ModelRef | null {
  const sel = ctx.get?.('agentDefaultModel')
  if (sel !== undefined && typeof sel.currentSelection === 'function') {
    const s = sel.currentSelection()
    if (isRecord(s) && typeof s.provider === 'string' && typeof s.model === 'string') {
      return { provider: s.provider, model: s.model }
    }
  }
  return null
}

async function resolvePreferApiKey(ctx: PreferHostLike, config: PreferModelConfig): Promise<string> {
  const ref = config.preferApiKeyEnv || 'DEV_API_KEY'
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  const credentials = ctx.get?.('credentials')
  if (credentials && typeof credentials.resolve === 'function') {
    const hit = await credentials.resolve(ref)
    const value = hit?.value
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  throw new Error(
    `no credential for ${ref} — set preferApiKeyEnv / export it / save the Models → dev API key`,
  )
}

/**
 * Call TypeSafe System One (or a gateway that mirrors POST …/systemone).
 * @returns normalized `{ [questionId]: choiceId }` for Choice questions.
 */
export async function callSystemOneChoice(
  ctx: PreferHostLike,
  config: PreferModelConfig,
  state: string,
  question: PreferChoiceQuestion,
): Promise<{ readonly value: Record<string, string>; readonly model: string }> {
  const key = await resolvePreferApiKey(ctx, config)
  const base = config.preferBaseURL.replace(/\/+$/, '')
  const paths = [`${base}/systemone`, `${base}/typesafe/v1/systemone`]
  const body = {
    model: config.preferModel,
    state,
    questions: {
      [question.id]: {
        type: 'choice',
        instructions: question.instructions,
        criteria: { ...question.options },
      },
    },
  }
  let lastError = 'systemone failed'
  for (const url of paths) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let parsed: unknown = null
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
      if (!res.ok) {
        lastError = `${res.status}: ${text.slice(0, 400)}`
        // 404 on first path → try alternate; other errors still try once more
        if (res.status === 404 || res.status === 405) continue
        if (res.status === 422 && /端点|endpoint/i.test(text)) continue
        throw new Error(lastError)
      }
      if (!isRecord(parsed)) throw new Error('systemone response was not JSON object')
      const answers = isRecord(parsed.answers) ? parsed.answers : null
      const rawAnswer = answers ? answers[question.id] : undefined
      const answer = isRecord(rawAnswer) ? rawAnswer : null
      const choiceRaw = answer ? answer.choice : undefined
      const choice = typeof choiceRaw === 'string' ? choiceRaw.trim() : ''
      if (!choice) throw new Error(`systemone missing answers.${question.id}.choice`)
      const model = typeof parsed.model === 'string' ? parsed.model : config.preferModel
      return { value: { [question.id]: choice }, model }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  throw new Error(lastError)
}

async function streamText(ctx: PreferHostLike, cfg: ModelRef, system: string, user: string, maxTokens: number): Promise<string> {
  const llm = ctx.llm
  if (!isRecord(llm) || typeof llm.stream !== 'function') {
    throw new Error('llm stream unavailable')
  }
  let text = ''
  let reasoning = ''
  let failure: string | null = null
  for await (const chunk of llm.stream({
    provider: cfg.provider,
    model: cfg.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    // Do not send temperature: openai-codex and several gateways reject it.
    maxTokens,
  }) as AsyncIterable<unknown>) {
    if (!isRecord(chunk)) continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoning += chunk.text
    else if (chunk.type === 'finish' && isRecord(chunk.reason) && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
      const f = chunk.reason.failure
      failure = isRecord(f) && typeof f.message === 'string' ? f.message : 'model call failed'
    }
  }
  if (failure !== null) throw new Error(failure)
  const out = text.trim() !== '' ? text : reasoning
  if (out.trim() === '') throw new Error('empty model result')
  return out
}

/**
 * Ask Jev System One (or llm.stream for non-jev) for a Choice, then optionally
 * fall back to agentDefaultModel JSON. Returns `{ [question.id]: choiceId }`.
 */
export async function decideChoiceWithPrefer(
  ctx: PreferHostLike,
  config: PreferModelConfig,
  state: string,
  question: PreferChoiceQuestion,
): Promise<PreferDecisionResult> {
  if (!hasPrefer(config)) {
    return { ok: false, error: 'jevDecide off or preferProvider/preferModel empty', attempts: [] }
  }
  const attempts: PreferAttempt[] = []
  const preferRef: ModelRef = { provider: config.preferProvider, model: config.preferModel }

  if (isJevSystemOneModel(config.preferModel)) {
    try {
      const hit = await callSystemOneChoice(ctx, config, state, question)
      attempts.push({ provider: preferRef.provider, model: hit.model, role: 'prefer', ok: true })
      return {
        ok: true,
        value: hit.value,
        provider: preferRef.provider,
        model: hit.model,
        role: 'prefer',
        attempts,
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      attempts.push({ provider: preferRef.provider, model: preferRef.model, role: 'prefer', ok: false, error: msg })
      if (!config.preferFallback) {
        return { ok: false, error: msg, attempts }
      }
    }
  } else {
    try {
      const text = await streamText(
        ctx,
        preferRef,
        [
          'Reply with only JSON.',
          `Pick one key from: ${Object.keys(question.options).join(', ')}.`,
          `Format: {"${question.id}":"<key>"}.`,
          question.instructions,
        ].join('\n'),
        state.slice(0, 4000),
        200,
      )
      const parsed = parseJson(text)
      const key = isRecord(parsed) ? String(parsed[question.id] ?? '').trim() : ''
      if (key && question.options[key] !== undefined) {
        attempts.push({ provider: preferRef.provider, model: preferRef.model, role: 'prefer', ok: true })
        return {
          ok: true,
          value: { [question.id]: key },
          provider: preferRef.provider,
          model: preferRef.model,
          role: 'prefer',
          attempts,
        }
      }
      attempts.push({
        provider: preferRef.provider,
        model: preferRef.model,
        role: 'prefer',
        ok: false,
        error: 'response missing valid choice',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      attempts.push({ provider: preferRef.provider, model: preferRef.model, role: 'prefer', ok: false, error: msg })
      if (!config.preferFallback) return { ok: false, error: msg, attempts }
    }
  }

  if (config.preferFallback) {
    const fb = fallbackModel(ctx)
    if (fb !== null && (fb.provider !== preferRef.provider || fb.model !== preferRef.model)) {
      try {
        const text = await streamText(
          ctx,
          fb,
          [
            'Reply with only JSON.',
            `Pick one key from: ${Object.keys(question.options).join(', ')}.`,
            `Format: {"${question.id}":"<key>"}.`,
            question.instructions,
          ].join('\n'),
          state.slice(0, 4000),
          200,
        )
        const parsed = parseJson(text)
        const key = isRecord(parsed) ? String(parsed[question.id] ?? '').trim() : ''
        if (key && question.options[key] !== undefined) {
          attempts.push({ provider: fb.provider, model: fb.model, role: 'fallback', ok: true })
          return {
            ok: true,
            value: { [question.id]: key },
            provider: fb.provider,
            model: fb.model,
            role: 'fallback',
            attempts,
          }
        }
        attempts.push({
          provider: fb.provider,
          model: fb.model,
          role: 'fallback',
          ok: false,
          error: 'response missing valid choice',
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        attempts.push({ provider: fb.provider, model: fb.model, role: 'fallback', ok: false, error: msg })
      }
    }
  }

  const last = attempts.filter(a => !a.ok).map(a => a.error).filter(Boolean).join(' | ')
  return { ok: false, error: last || 'prefer choice failed', attempts }
}

/**
 * Ask the prefer model (then fallback) for one JSON object. Returns null when
 * jev is off or every attempt fails — callers must keep a local heuristic.
 *
 * For `jev-*` models this path is unsuitable (no chat endpoint). Prefer
 * {@link decideChoiceWithPrefer}.
 */
export async function decideWithPrefer(
  ctx: PreferHostLike,
  config: PreferModelConfig,
  system: string,
  user: string,
  maxTokens = 400,
): Promise<unknown | null> {
  const detailed = await decideWithPreferDetailed(ctx, config, system, user, maxTokens)
  return detailed.ok ? detailed.value : null
}

/**
 * Same as {@link decideWithPrefer}, but returns route / attempt diagnostics.
 * Jev models refuse chat protocols — use {@link decideChoiceWithPrefer}.
 */
export async function decideWithPreferDetailed(
  ctx: PreferHostLike,
  config: PreferModelConfig,
  system: string,
  user: string,
  maxTokens = 400,
): Promise<PreferDecisionResult> {
  if (!hasPrefer(config)) {
    return { ok: false, error: 'jevDecide off or preferProvider/preferModel empty', attempts: [] }
  }
  if (isJevSystemOneModel(config.preferModel)) {
    return {
      ok: false,
      error: 'jev models require System One (decideChoiceWithPrefer), not chat/completions/responses',
      attempts: [{
        provider: config.preferProvider,
        model: config.preferModel,
        role: 'prefer',
        ok: false,
        error: 'wrong protocol: use System One /systemone',
      }],
    }
  }
  const prefer: ModelRef = { provider: config.preferProvider, model: config.preferModel }
  const order: { ref: ModelRef; role: 'prefer' | 'fallback' }[] = [{ ref: prefer, role: 'prefer' }]
  if (config.preferFallback) {
    const fb = fallbackModel(ctx)
    if (fb !== null && (fb.provider !== prefer.provider || fb.model !== prefer.model)) {
      order.push({ ref: fb, role: 'fallback' })
    }
  }
  const attempts: PreferAttempt[] = []
  for (const step of order) {
    try {
      const text = await streamText(ctx, step.ref, system, user, maxTokens)
      const parsed = parseJson(text)
      if (parsed !== null) {
        attempts.push({ provider: step.ref.provider, model: step.ref.model, role: step.role, ok: true })
        return {
          ok: true,
          value: parsed,
          provider: step.ref.provider,
          model: step.ref.model,
          role: step.role,
          attempts,
        }
      }
      attempts.push({
        provider: step.ref.provider,
        model: step.ref.model,
        role: step.role,
        ok: false,
        error: 'response was not JSON object',
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      attempts.push({
        provider: step.ref.provider,
        model: step.ref.model,
        role: step.role,
        ok: false,
        error: msg,
      })
      if (step.role === 'prefer' && config.preferFallback) continue
      break
    }
  }
  const last = attempts.filter(a => !a.ok).map(a => a.error).filter(Boolean).join(' | ')
  return { ok: false, error: last || 'prefer model failed', attempts }
}

/**
 * Placeholder seeds for the optional Jev System One API block in Scholar settings.
 * Not applied as the study chat model — open-source builds ship with `jevDecide: false`
 * until the user fills base URL + credential in the dedicated settings section.
 */
export const DEFAULT_JEV_PREFER: PreferModelConfig = {
  preferProvider: 'dev',
  preferModel: 'jev-1.13.0',
  preferFallback: true,
  jevDecide: false,
  preferBaseURL: '',
  preferApiKeyEnv: 'DEV_API_KEY',
}

/** Map scholar-config Jev fields onto PreferModelConfig for System One calls. */
export function scholarPreferFromConfig(config: {
  preferProvider?: string
  preferModel?: string
  preferFallback?: boolean
  jevDecide?: boolean
  preferBaseURL?: string
  preferApiKeyEnv?: string
}): PreferModelConfig {
  return {
    preferProvider: (config.preferProvider ?? '').trim(),
    preferModel: (config.preferModel ?? '').trim(),
    preferFallback: config.preferFallback !== false,
    jevDecide: config.jevDecide === true,
    preferBaseURL: (config.preferBaseURL ?? '').trim() || DEFAULT_JEV_PREFER.preferBaseURL,
    preferApiKeyEnv: (config.preferApiKeyEnv ?? '').trim() || DEFAULT_JEV_PREFER.preferApiKeyEnv,
  }
}
