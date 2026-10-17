/**
 * dsh-papercover侧栏阅读器使用的 pdf.js 文件。
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const nodeRequire = createRequire(import.meta.url);
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

function pdfjsRoot(): string {
  return dirname(nodeRequire.resolve('pdfjs-dist/package.json'));
}

/**
 * Map a URL remainder under `/scholar/pdfjs` to one file inside the pdfjs-dist package.
 * @param rest - pathname after the prefix, with or without a leading slash
 * @returns the file path and response content type, or null when the remainder is not an asset
 */
export function resolveScholarPdfjs(rest: string): { file: string; contentType: string } | null {
  const rel = rest.replace(/^\/+/, '');
  if (rel === 'pdf.mjs' || rel === 'pdf.worker.mjs') {
    return { file: join(pdfjsRoot(), 'build', rel), contentType: 'text/javascript; charset=utf-8' };
  }
  const cmap = /^cmaps\/([^/]+)$/.exec(rel);
  if (cmap && SAFE_NAME.test(cmap[1]) && cmap[1] === basename(cmap[1])) {
    return { file: join(pdfjsRoot(), 'cmaps', cmap[1]), contentType: 'application/octet-stream' };
  }
  const font = /^standard_fonts\/([^/]+)$/.exec(rel);
  if (font && SAFE_NAME.test(font[1]) && font[1] === basename(font[1])) {
    return { file: join(pdfjsRoot(), 'standard_fonts', font[1]), contentType: 'application/octet-stream' };
  }
  return null;
}

/**
 * Read one pdf.js asset.
 * @param rest - pathname after `/scholar/pdfjs`
 * @returns bytes and content type, or null when the path is rejected or the file is missing
 */
export async function readScholarPdfjs(rest: string): Promise<{ body: Buffer; contentType: string } | null> {
  const hit = resolveScholarPdfjs(rest);
  if (!hit) return null;
  try {
    return { body: await readFile(hit.file), contentType: hit.contentType };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
