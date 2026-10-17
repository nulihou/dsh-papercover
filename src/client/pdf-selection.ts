/**
 * 侧栏 PDF 文字层的划词辅助。选区贴到同一个 span 里的词边界，不跨行去抓下一句。
 */

const MAX_SEL_CHARS = 720;
const WORD_CHAR = /[A-Za-z0-9\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF'’\-]/;

function textNodeOf(span: HTMLElement): Text | null {
  const child = span.firstChild;
  return child && child.nodeType === 3 ? (child as Text) : null;
}

function spanOfNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  if (node.nodeType === 1) {
    return (node as HTMLElement).closest('span');
  }
  return (node.parentElement as HTMLElement | null)?.closest('span') ?? null;
}

/**
 * Snap selection edges to word boundaries inside the same pdf.js text span.
 * Does not walk across lines into neighboring sentences.
 *
 * @param host - scroll host that contains `.textLayer` pages
 */
export function refineWordSelection(host: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;

  const range = sel.getRangeAt(0).cloneRange();
  const node = range.commonAncestorContainer;
  const el = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
  if (!el || !host.contains(el)) return;
  if (!el.closest('.textLayer')) return;

  try {
    const next = range.cloneRange();

    if (range.startContainer.nodeType === 3) {
      const tn = range.startContainer as Text;
      const text = tn.data;
      let off = range.startOffset;
      if (off < text.length && WORD_CHAR.test(text[off]!)) {
        while (off > 0 && WORD_CHAR.test(text[off - 1]!)) off -= 1;
      }
      next.setStart(tn, off);
    }

    if (range.endContainer.nodeType === 3) {
      const tn = range.endContainer as Text;
      const text = tn.data;
      let off = range.endOffset;
      if (off > 0 && WORD_CHAR.test(text[off - 1]!)) {
        while (off < text.length && WORD_CHAR.test(text[off]!)) off += 1;
      }
      next.setEnd(tn, off);

      if (off >= text.length && WORD_CHAR.test(text[text.length - 1] ?? '')) {
        const endSpan = spanOfNode(tn);
        let sib = endSpan?.nextElementSibling as HTMLElement | null;
        while (sib && sib.tagName === 'BR') sib = sib.nextElementSibling as HTMLElement | null;
        if (sib && sib.tagName === 'SPAN' && !sib.classList.contains('endOfContent')) {
          const sibText = (sib.textContent || '').trim();
          if (sibText.length > 0 && sibText.length <= 2 && WORD_CHAR.test(sibText[0]!)) {
            const sibNode = textNodeOf(sib) ?? sib;
            if (sibNode.nodeType === 3) next.setEnd(sibNode, (sibNode as Text).data.length);
            else next.setEndAfter(sib);
          }
        }
      }
    }

    if (next.collapsed) return;
    const picked = String(next);
    if (!picked.trim() || picked.length > MAX_SEL_CHARS) return;
    if (picked.length > String(range).length + 32) return;

    sel.removeAllRanges();
    sel.addRange(next);
  } catch {
    /* selection APIs can throw on detached nodes */
  }
}

/** True when the highlight color marks a vocabulary / word-study entry. */
export const VOCAB_COLOR = '#a78bfa';

export function isVocabHighlight(h: { color?: string }): boolean {
  return (h.color ?? '').toLowerCase() === VOCAB_COLOR;
}
