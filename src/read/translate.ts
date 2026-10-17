/**
 * Selection translation for the in-sidebar PDF reader.
 * Uses the scholar LLM settings, then the session's default model.
 */
import type { Context } from '@deepseek-ai/cordis';
import { createLlmRuntime, type PreferredModelFn } from './llm.js';

const TRANSLATE_SYSTEM = [
  '把选中文字译成简体中文。只输出译文，无前言、复述或 Markdown。',
  '术语按领域惯例，必要时括注原文；保留公式、变量和引用编号。',
].join('\n');

const MAX_TEXT = 6000;

function translateMaxTokens(text: string): number {
  const n = Math.max(8, text.length);
  return Math.min(768, Math.max(96, Math.ceil(n * 1.6) + 48));
}

function buildUser(opts: { text: string; context?: string; domain?: string }): string {
  const parts: string[] = [];
  if (opts.domain) parts.push(`领域：${opts.domain}`);
  if (opts.context) parts.push(`上下文（仅消歧）：\n${opts.context.slice(0, 400)}`);
  parts.push(`待译：\n${opts.text}`);
  return parts.join('\n\n');
}

/**
 * Translate one PDF selection.
 * @param ctx - host context that provides `llm`
 * @param body - selection text plus optional disambiguation context
 * @param preferredModel - scholar settings override
 * @param preferFallback - when the preferred model is unavailable, use the session default
 * @returns the original selection and the translation
 */
export async function translateAcademicSelection(
  ctx: Context,
  body: { text?: unknown; context?: unknown; domain?: unknown },
  preferredModel?: PreferredModelFn,
  preferFallback?: boolean,
): Promise<{ text: string; translation: string }> {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw new Error('没有要翻译的文字');
  if (text.length > MAX_TEXT) throw new Error(`选区过长（上限 ${MAX_TEXT} 字）`);
  const context = typeof body.context === 'string' ? body.context.slice(0, 800) : '';
  const domain = typeof body.domain === 'string' ? body.domain.slice(0, 200) : '';
  const { callModel, pickConfig } = createLlmRuntime({
    ctx: ctx as never,
    estimateTokens: (value) => Math.ceil(value.length * 0.6),
    llmCallStats: { calls: 0, ms: 0 },
    recordCalibration: (() => undefined) as never,
    preferredModel,
    preferFallback,
  });
  const cfg = await pickConfig();
  const translation = (await callModel(
    cfg,
    TRANSLATE_SYSTEM,
    buildUser({ text, context, domain }),
    translateMaxTokens(text),
    null,
    'off',
  )).trim();
  if (!translation) throw new Error('模型未返回译文');
  return { text, translation };
}
