/**
 * Zotero Local API HTTP client (read + write).
 * Base: http://127.0.0.1:23119/api — writes need Zotero 10+ + authorize key.
 */
import { createHash } from 'node:crypto';

export interface ZoteroHttpOptions {
  baseUrl: string;
  serverId?: string;
  apiKey?: string;
}

export interface ZoteroApiInfo {
  serverId: string;
  apiVersion?: string;
  schemaVersion?: string;
  zoteroVersion?: string;
}

export interface ZoteroJsonObject {
  key: string;
  version: number;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  [k: string]: unknown;
}

export class ZoteroHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ZoteroHttpError';
  }
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * 把 fetch 的网络层失败翻译成用户能照着做的提示。
 *
 * Node/undici 在连接被拒时只抛 `TypeError: fetch failed`，真正的原因
 * （ECONNREFUSED 等）挂在 `cause` 上。原样抛给界面等于什么都没说——
 * 「点同步 Zotero 只显示 fetch failed」就是这么来的。
 */
export function describeNetworkFailure(baseUrl: string, err: unknown): ZoteroHttpError {
  const cause = (err as { cause?: unknown } | null | undefined)?.cause;
  const code = cause !== null && typeof cause === 'object'
    && typeof (cause as { code?: unknown }).code === 'string'
    ? (cause as { code: string }).code
    : '';
  const detail = cause instanceof Error ? cause.message : (err instanceof Error ? err.message : String(err));
  const signal = `${code} ${detail}`;
  if (/ECONNREFUSED|ECONNRESET|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_SOCKET|fetch failed|socket hang up/i.test(signal)) {
    return new ZoteroHttpError(
      `连不上 Zotero 本地 API（${baseUrl}）。请先启动 Zotero 桌面端；若已在运行，`
      + '请在 Zotero「设置 → 高级」勾选「允许其他应用与 Zotero 通信」(Local API) 后重试。',
      502, cause ?? err,
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(signal)) {
    return new ZoteroHttpError(`无法解析 Zotero 地址（${baseUrl}）：请检查设置里的 Base URL。`, 502, cause ?? err);
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timeout|aborted/i.test(signal)) {
    return new ZoteroHttpError(`连接 Zotero 本地 API 超时（${baseUrl}）：Zotero 可能刚启动或正忙，请稍后重试。`, 504, cause ?? err);
  }
  if (/CERT|TLS|SSL|self.signed/i.test(signal)) {
    return new ZoteroHttpError(`Zotero 本地 API 的 TLS 校验失败（${baseUrl}）：本地地址应使用 http:// 而非 https://。`, 502, cause ?? err);
  }
  return new ZoteroHttpError(`Zotero 本地 API 请求失败（${baseUrl}）：${detail}`, 502, cause ?? err);
}

export class ZoteroHttpClient {
  constructor(private opts: ZoteroHttpOptions) {}

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '') || 'http://127.0.0.1:23119/api';
  }

  withAuth(patch: Partial<ZoteroHttpOptions>): ZoteroHttpClient {
    return new ZoteroHttpClient({ ...this.opts, ...patch });
  }

  private headers(write: boolean, extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      'Zotero-API-Version': '3',
      Accept: 'application/json',
      ...(extra ?? {}),
    };
    if (this.opts.serverId) h['Zotero-Server-ID'] = this.opts.serverId;
    if (write) {
      if (!this.opts.serverId) throw new ZoteroHttpError('Zotero-Server-ID required for writes', 428);
      if (!this.opts.apiKey) throw new ZoteroHttpError('Zotero-API-Key required for writes', 401);
      h['Zotero-API-Key'] = this.opts.apiKey;
    }
    return h;
  }

  async request(
    method: string,
    path: string,
    opts?: {
      write?: boolean;
      body?: unknown;
      rawBody?: Buffer | Uint8Array;
      contentType?: string;
      query?: Record<string, string | number | undefined>;
      headers?: Record<string, string>;
    },
  ): Promise<{ status: number; headers: Headers; json: unknown; text: string }> {
    const write = opts?.write ?? !['GET', 'HEAD'].includes(method.toUpperCase());
    const url = new URL(joinUrl(this.baseUrl, path));
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === '') continue;
        url.searchParams.set(k, String(v));
      }
    }
    const headers = this.headers(write, opts?.headers);
    let body: BodyInit | undefined;
    if (opts?.rawBody) {
      body = opts.rawBody as BodyInit;
      if (opts.contentType) headers['Content-Type'] = opts.contentType;
    } else if (opts?.body !== undefined) {
      headers['Content-Type'] = opts.contentType ?? 'application/json';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body });
    } catch (err) {
      throw describeNetworkFailure(this.baseUrl, err);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try { json = JSON.parse(text); } catch { /* non-json */ }
    }
    if (!res.ok) {
      const msg = (json && typeof json === 'object' && 'message' in json)
        ? String((json as { message: unknown }).message)
        : (text || res.statusText || `HTTP ${res.status}`);
      throw new ZoteroHttpError(msg, res.status, json ?? text);
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  async getJson<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const r = await this.request('GET', path, { write: false, query });
    return r.json as T;
  }

  async probe(): Promise<ZoteroApiInfo> {
    let r: { status: number; headers: Headers; json: unknown; text: string };
    try {
      r = await this.request('GET', '/', { write: false });
    } catch (err) {
      // 端口通、但 /api 不认：连接器服务器在跑而本地 API 没开，说清楚该点哪里。
      if (err instanceof ZoteroHttpError && (err.status === 403 || err.status === 404)) {
        throw new ZoteroHttpError(
          `Zotero 在运行，但本地 API 未开启（${this.baseUrl}）：请在 Zotero「设置 → 高级」`
          + '勾选「允许其他应用与 Zotero 通信」(Local API) 后重试。',
          err.status, err.body,
        );
      }
      throw err;
    }
    const serverId = r.headers.get('Zotero-Server-ID')
      || (r.json && typeof r.json === 'object' && r.json !== null && 'serverID' in r.json
        ? String((r.json as { serverID: unknown }).serverID)
        : '')
      || '';
    if (!serverId) throw new ZoteroHttpError('Missing Zotero-Server-ID (need Zotero 10+ Local API)', 500);
    return {
      serverId,
      apiVersion: r.headers.get('Zotero-API-Version') ?? undefined,
      schemaVersion: r.headers.get('Zotero-Schema-Version') ?? undefined,
      zoteroVersion: r.headers.get('Zotero-Version')
        ?? (r.json && typeof r.json === 'object' && r.json && 'version' in r.json
          ? String((r.json as { version: unknown }).version)
          : undefined),
    };
  }

  /** Request a local write key (shows Zotero desktop dialog). */
  async authorize(appName: string): Promise<{ key: string; remember: boolean; serverId: string }> {
    const info = await this.probe();
    const url = new URL(joinUrl(this.baseUrl, '/local/authorize'));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Zotero-API-Version': '3',
          'Zotero-Server-ID': info.serverId,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ appName }),
      });
    } catch (err) {
      throw describeNetworkFailure(this.baseUrl, err);
    }
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    if (!res.ok) {
      throw new ZoteroHttpError(
        (json && typeof json === 'object' && 'denied' in json && (json as { denied: boolean }).denied)
          ? '用户拒绝了写权限授权'
          : (text || res.statusText),
        res.status,
        json ?? text,
      );
    }
    const key = json && typeof json === 'object' && 'key' in json
      ? String((json as { key: unknown }).key)
      : '';
    if (!key) throw new ZoteroHttpError('Authorize response missing key', 500, json);
    const remember = !!(json && typeof json === 'object' && 'remember' in json
      && (json as { remember: unknown }).remember);
    return { key, remember, serverId: info.serverId };
  }

  libraryPrefix(library = 'user/0'): string {
    const m = /^(user|group)\/(\d+)$/.exec(library.trim());
    if (!m) return 'users/0';
    return m[1] === 'group' ? `groups/${m[2]}` : 'users/0';
  }

  async listItems(library = 'user/0', query?: Record<string, string | number | undefined>): Promise<ZoteroJsonObject[]> {
    const prefix = this.libraryPrefix(library);
    const data = await this.getJson<ZoteroJsonObject[]>(`/${prefix}/items/top`, {
      format: 'json',
      limit: 100,
      ...query,
    });
    return Array.isArray(data) ? data : [];
  }

  async listAllItems(library = 'user/0'): Promise<ZoteroJsonObject[]> {
    const prefix = this.libraryPrefix(library);
    const out: ZoteroJsonObject[] = [];
    let start = 0;
    const limit = 100;
    for (;;) {
      const batch = await this.getJson<ZoteroJsonObject[]>(`/${prefix}/items`, {
        format: 'json',
        limit,
        start,
        itemType: '-attachment || note || annotation',
      }).catch(async () => this.getJson<ZoteroJsonObject[]>(`/${prefix}/items/top`, {
        format: 'json',
        limit,
        start,
      }));
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < limit) break;
      start += limit;
      if (start > 20000) break;
    }
    return out;
  }

  /**
   * Incremental item fetch: when since > 0, resolve changed keys via versions,
   * then GET each (plus always re-fetch top-level parents of mapped attachments/notes).
   * Falls back to full listAllItems on empty/error.
   */
  async listItemsSince(library = 'user/0', since = 0): Promise<ZoteroJsonObject[]> {
    if (since <= 0) return this.listAllItems(library);
    try {
      const versions = await this.getVersions(library, since);
      const keys = Object.keys(versions);
      if (keys.length === 0) return [];
      // Cap: if too many changed, do a full pull
      if (keys.length > 500) return this.listAllItems(library);
      const out: ZoteroJsonObject[] = [];
      for (let i = 0; i < keys.length; i += 50) {
        const chunk = keys.slice(i, i + 50);
        await Promise.all(chunk.map(async (key) => {
          try {
            out.push(await this.getItem(key, library));
          } catch { /* deleted or inaccessible */ }
        }));
      }
      return out;
    } catch {
      return this.listAllItems(library);
    }
  }

  /**
   * List highlight annotations.
   *
   * Annotations are ordinary items whose `parentItem` is the PDF attachment, but a live
   * Zotero 7 local API returns an EMPTY array from `/items/{attachmentKey}/children`, so
   * the only reliable route is listing them by item type. `since` is honoured (verified
   * against the live API), which keeps the incremental case cheap; pass 0 to sweep all.
   */
  async listAnnotations(library = 'user/0', since = 0): Promise<ZoteroJsonObject[]> {
    const prefix = this.libraryPrefix(library);
    const out: ZoteroJsonObject[] = [];
    let start = 0;
    const limit = 100;
    for (;;) {
      const batch = await this.getJson<ZoteroJsonObject[]>(`/${prefix}/items`, {
        format: 'json',
        limit,
        start,
        itemType: 'annotation',
        ...(since > 0 ? { since } : {}),
      }).catch(() => [] as ZoteroJsonObject[]);
      if (!Array.isArray(batch) || batch.length === 0) break;
      out.push(...batch);
      if (batch.length < limit) break;
      start += limit;
      if (start > 5000) break;
    }
    return out;
  }

  async listCollections(library = 'user/0'): Promise<ZoteroJsonObject[]> {
    const prefix = this.libraryPrefix(library);
    const data = await this.getJson<ZoteroJsonObject[]>(`/${prefix}/collections`, { format: 'json' });
    return Array.isArray(data) ? data : [];
  }

  async getItem(key: string, library = 'user/0'): Promise<ZoteroJsonObject> {
    const prefix = this.libraryPrefix(library);
    return this.getJson(`/${prefix}/items/${key}`, { format: 'json' });
  }

  async getChildren(key: string, library = 'user/0'): Promise<ZoteroJsonObject[]> {
    const prefix = this.libraryPrefix(library);
    const data = await this.getJson<ZoteroJsonObject[]>(`/${prefix}/items/${key}/children`, { format: 'json' });
    return Array.isArray(data) ? data : [];
  }

  async getDeleted(since: number, library = 'user/0'): Promise<{
    items?: string[];
    collections?: string[];
  }> {
    const prefix = this.libraryPrefix(library);
    return this.getJson(`/${prefix}/deleted`, { since });
  }

  async getVersions(library = 'user/0', since = 0): Promise<Record<string, number>> {
    const prefix = this.libraryPrefix(library);
    const data = await this.getJson<Record<string, number>>(`/${prefix}/items`, {
      format: 'versions',
      since,
    });
    return data && typeof data === 'object' ? data : {};
  }

  async createItems(items: Record<string, unknown>[], library = 'user/0'): Promise<{
    successful: Record<string, ZoteroJsonObject>;
    unchanged: Record<string, ZoteroJsonObject>;
    failed: Record<string, string>;
    version: number;
  }> {
    const prefix = this.libraryPrefix(library);
    const r = await this.request('POST', `/${prefix}/items`, { write: true, body: items });
    const version = Number(r.headers.get('Last-Modified-Version') || 0);
    const body = (r.json ?? {}) as {
      successful?: Record<string, ZoteroJsonObject>;
      unchanged?: Record<string, ZoteroJsonObject>;
      failed?: Record<string, string>;
    };
    return {
      successful: body.successful ?? {},
      unchanged: body.unchanged ?? {},
      failed: body.failed ?? {},
      version,
    };
  }

  async patchItem(key: string, patch: Record<string, unknown>, version: number, library = 'user/0'): Promise<number> {
    const prefix = this.libraryPrefix(library);
    const r = await this.request('PATCH', `/${prefix}/items/${key}`, {
      write: true,
      body: patch,
      headers: { 'If-Unmodified-Since-Version': String(version) },
    });
    return Number(r.headers.get('Last-Modified-Version') || version + 1);
  }

  async createCollections(cols: Record<string, unknown>[], library = 'user/0'): Promise<{
    successful: Record<string, ZoteroJsonObject>;
    failed: Record<string, string>;
    version: number;
  }> {
    const prefix = this.libraryPrefix(library);
    const r = await this.request('POST', `/${prefix}/collections`, { write: true, body: cols });
    const version = Number(r.headers.get('Last-Modified-Version') || 0);
    const body = (r.json ?? {}) as {
      successful?: Record<string, ZoteroJsonObject>;
      failed?: Record<string, string>;
    };
    return { successful: body.successful ?? {}, failed: body.failed ?? {}, version };
  }

  async patchCollection(key: string, patch: Record<string, unknown>, version: number, library = 'user/0'): Promise<number> {
    const prefix = this.libraryPrefix(library);
    const r = await this.request('PATCH', `/${prefix}/collections/${key}`, {
      write: true,
      body: patch,
      headers: { 'If-Unmodified-Since-Version': String(version) },
    });
    return Number(r.headers.get('Last-Modified-Version') || version + 1);
  }

  /** Resolve attachment file path via Local API redirect/url endpoint. */
  async attachmentFileUrl(key: string, library = 'user/0'): Promise<string | null> {
    const prefix = this.libraryPrefix(library);
    try {
      const r = await this.request('GET', `/${prefix}/items/${key}/file/view/url`, { write: false });
      const url = (r.text || '').trim();
      return url || null;
    } catch {
      return null;
    }
  }

  /**
   * Three-phase local file upload for imported_file attachments.
   * @returns new library version
   */
  async uploadFile(opts: {
    attachmentKey: string;
    filename: string;
    bytes: Buffer;
    mtimeMs: number;
    library?: string;
    ifNoneMatch?: boolean;
    ifMatchMd5?: string;
  }): Promise<{ exists: boolean; version: number }> {
    const library = opts.library ?? 'user/0';
    const prefix = this.libraryPrefix(library);
    const md5 = createHash('md5').update(opts.bytes).digest('hex');
    const params = new URLSearchParams({
      md5,
      filename: opts.filename,
      filesize: String(opts.bytes.length),
      mtime: String(Math.floor(opts.mtimeMs)),
    });
    const preHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (opts.ifNoneMatch) preHeaders['If-None-Match'] = '*';
    else if (opts.ifMatchMd5) preHeaders['If-Match'] = opts.ifMatchMd5;
    else preHeaders['If-None-Match'] = '*';

    const pre = await this.request('POST', `/${prefix}/items/${opts.attachmentKey}/file`, {
      write: true,
      rawBody: Buffer.from(params.toString(), 'utf8'),
      contentType: 'application/x-www-form-urlencoded',
      headers: preHeaders,
    });
    const preJson = (pre.json ?? {}) as {
      exists?: number;
      url?: string;
      uploadKey?: string;
      contentType?: string;
    };
    if (preJson.exists === 1) {
      return { exists: true, version: Number(pre.headers.get('Last-Modified-Version') || 0) };
    }
    const uploadUrl = preJson.url;
    const uploadKey = preJson.uploadKey;
    if (!uploadUrl || !uploadKey) throw new ZoteroHttpError('Upload prep missing url/uploadKey', 500, preJson);

    // Phase 2: POST bytes to local upload URL (no auth)
    const up = await fetch(uploadUrl.startsWith('http') ? uploadUrl : joinUrl(this.baseUrl.replace(/\/api$/, ''), uploadUrl), {
      method: 'POST',
      headers: { 'Content-Type': preJson.contentType || 'application/pdf' },
      body: new Uint8Array(opts.bytes),
    });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      throw new ZoteroHttpError(`File upload failed: ${t || up.statusText}`, up.status);
    }

    // Phase 3: register upload
    const finParams = new URLSearchParams({ upload: uploadKey });
    const fin = await this.request('POST', `/${prefix}/items/${opts.attachmentKey}/file`, {
      write: true,
      rawBody: Buffer.from(finParams.toString(), 'utf8'),
      contentType: 'application/x-www-form-urlencoded',
      headers: preHeaders,
    });
    return { exists: false, version: Number(fin.headers.get('Last-Modified-Version') || 0) };
  }
}

export function itemData(obj: ZoteroJsonObject): Record<string, unknown> {
  const d = obj.data;
  return d && typeof d === 'object' ? d as Record<string, unknown> : (obj as Record<string, unknown>);
}

export function md5Hex(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}
