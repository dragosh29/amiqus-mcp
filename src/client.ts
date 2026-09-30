// Minimal Amiqus ID API client used by the MCP tools.
// Docs: https://developers.amiqus.co  Spec: https://developers.amiqus.co/aqid/openapi.json
// (OpenAPI 3.1.0, "Amiqus ID REST API" v2.0, servers[0] https://id.amiqus.co/api/v2)
import { redactContacts } from "./format.js";

export class AmiqusError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "AmiqusError";
  }
}

// Spec PaginatedList: {object: "paginated_list", data, total, count, limit, current_page, total_pages,
// links: null | {next: url|null, previous: url|null}}.
export interface PaginatedList<T> {
  object?: string;
  data?: T[];
  total?: number;
  count?: number;
  limit?: number;
  current_page?: number;
  total_pages?: number;
  links?: { next?: string | null; previous?: string | null } | null;
}

// A 429 means the request was not processed (the rate-limits guide: "subsequent requests return a
// 429"), so it is safe to repeat for any method. A 502/503/504 from a gateway does not prove the
// upstream did not process the request, so those are only retried for GET: repeating a POST /records
// could create the same record twice and email the client twice. Amiqus documents no idempotency
// key, so there is nothing to send that would make a repeat safe.
const RETRY_ANY_METHOD = new Set([429]);
const RETRY_GET_ONLY = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;
// Longest single wait honoured from Retry-After. The MCP SDK's default request timeout is 60 s
// (DEFAULT_REQUEST_TIMEOUT_MSEC), so the whole retry budget (at most two waits) must stay well
// under that; a longer Retry-After makes the call give up at once with the wait time in the message.
export const MAX_RETRY_AFTER_S = 10;
// Pagination guide: "All endpoints have minimum and maximum page limits, which by default are
// 1..100. Some endpoints may have different limits." Every limit parameter in the spec is 1..100.
export const PAGE_SIZE = 100;
export const DEFAULT_BASE_URL = "https://id.amiqus.co/api/v2";

export type QueryValue = string | number | boolean | string[] | undefined;

export interface RateLimit {
  limit?: number;
  remaining?: number;
  reset?: number;
}

export class AmiqusClient {
  private readonly baseUrl: string;
  private readonly token: string;
  // The last X-RateLimit-* headers seen (rate-limits guide: X-RateLimit-Limit, X-RateLimit-Remaining
  // on every response; X-RateLimit-Reset and Retry-After on a 429).
  private rateLimit: RateLimit = {};
  // The rate-limits guide documents the headers and a 429 with Retry-After, but not the size of the
  // window (its example shows X-RateLimit-Limit: 200). Space requests at about four per second so a
  // tool call that pages through a list stays polite; 429s are retried using Retry-After.
  private nextSlot = 0;
  private readonly minIntervalMs = 250;

  constructor(accessToken: string, baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = withoutUserinfo(baseUrl, "AMIQUS_BASE_URL").replace(/\/+$/, "");
    // A token pasted with its "Bearer " prefix (the usual copy from a curl example) would otherwise
    // be sent as "Bearer Bearer <token>" and fail with a 401.
    this.token = accessToken.trim().replace(/^bearer\s+/i, "").trim();
    if (!this.token) throw new AmiqusError("AMIQUS_ACCESS_TOKEN is empty.");
  }

  /** The last rate-limit headers seen. */
  get lastRateLimit(): RateLimit {
    return { ...this.rateLimit };
  }

  /** Replace the token in a message with "[redacted]" (a 401 body or a proxy page might echo it). */
  private scrub(message: string): string {
    return this.token.length >= 4 ? message.split(this.token).join("[redacted]") : message;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextSlot - now);
    this.nextSlot = Math.max(now, this.nextSlot) + this.minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }

  private readRateLimit(res: Response) {
    const n = (name: string) => {
      const v = res.headers.get(name);
      return v !== null && /^\d+$/.test(v.trim()) ? Number(v) : undefined;
    };
    const limit = n("x-ratelimit-limit");
    const remaining = n("x-ratelimit-remaining");
    const reset = n("x-ratelimit-reset");
    if (limit !== undefined || remaining !== undefined || reset !== undefined) this.rateLimit = { limit, remaining, reset };
  }

  async request<T = any>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<T> {
    try {
      return await this.send<T>(method, path, opts);
    } catch (err) {
      if (err instanceof AmiqusError) throw new AmiqusError(this.scrub(err.message), err.status);
      if (err instanceof Error) err.message = this.scrub(err.message);
      throw err;
    }
  }

  private async send<T>(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown }): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined || v === "") continue;
      // The spec's `expand` parameters are arrays with explode: false, and the expandable-properties
      // guide shows them as a comma-separated list (?expand=check,form,document).
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: {
            // Spec securitySchemes.personal_token: HTTP bearer. Every operation used here lists
            // [{personal_token}, {oauth}]; OAuth2 (authorization code) is out of scope for this server.
            Authorization: `Bearer ${this.token}`,
            Accept: "application/json",
            ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
      } catch (err) {
        throw new AmiqusError(`Could not reach Amiqus at ${originAndPath(url)}: ${(err as Error).message}`);
      }
      this.readRateLimit(res);

      const retryable = RETRY_ANY_METHOD.has(res.status) || (method === "GET" && RETRY_GET_ONLY.has(res.status));
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_S) {
          throw new AmiqusError(`Amiqus asked to wait ${Math.ceil(retryAfter)} seconds before retrying ${method} ${path} (HTTP ${res.status}). Try again after that.`, res.status);
        }
        // A missing or unparsable header falls back to 2 s then 4 s; a Retry-After of 0 (or a date already
        // passed) means retry now, subject to the throttle.
        const delay = retryAfter !== undefined ? retryAfter * 1000 : 2000 * (attempt + 1);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      if (res.status === 204) return undefined as T;

      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (res.ok) {
        // Every documented 2xx body used here is a JSON object. A 200 with HTML (a proxy, a login
        // page) must not be mistaken for an empty list or an empty record.
        if (!json || typeof json !== "object") {
          throw new AmiqusError(
            `Amiqus returned ${res.status} for ${method} ${path} but the body was not JSON (${describeBody(res, text)}). Check AMIQUS_BASE_URL and whether a proxy or login page is in the way.`,
            res.status,
          );
        }
        return json as T;
      }

      // Amiqus's error strings are free text; redact anything that looks like a contact detail in
      // case the live API ever echoes a client's email or phone number back.
      const detail = redactContacts(describeError(json), false);
      if (res.status === 401) {
        // Status-codes guide: "Check the access token is valid and is associated with the appropriate team."
        throw new AmiqusError(
          `Amiqus rejected the access token (401). Check AMIQUS_ACCESS_TOKEN: it must be a personal access token created by a user in Amiqus (the authentication guide: it carries that user's permissions, is limited to the team active when it was created, expires after one year and can be revoked), sent as a Bearer token.${detail ? " " + detail : ""}`,
          401,
        );
      }
      if (res.status === 403) {
        // Status-codes guide: "Check that the access token's user has appropriate permissions to
        // access the requested resource or perform the action." Some features (cases, National
        // Insurance numbers) "may not be enabled for all teams".
        throw new AmiqusError(
          `Amiqus refused ${method} ${path} (403). The token's user may lack permission for this resource, or the feature may not be enabled for this team.${detail ? " " + detail : ""}`,
          403,
        );
      }
      if (res.status === 404) throw new AmiqusError(`Not found: ${path}. Check the ID.${detail ? " " + detail : ""}`, 404);
      if (res.status === 422) throw new AmiqusError(`Amiqus rejected ${method} ${path} as invalid (422).${detail ? " " + detail : ""}`, 422);
      if (res.status === 429) {
        const rl = this.rateLimit;
        const limitNote = rl.limit !== undefined ? ` The limit reported by Amiqus is ${rl.limit} requests (X-RateLimit-Limit), shared by every token of this user on this team.` : "";
        const retryAfter = res.headers.get("retry-after");
        const waitNote = retryAfter ? ` Amiqus says to retry after ${retryAfter.trim()} seconds.` : "";
        throw new AmiqusError(`Amiqus rate limit reached (429).${limitNote}${waitNote} Wait and try again.`, 429);
      }
      if (method !== "GET" && RETRY_GET_ONLY.has(res.status)) {
        throw new AmiqusError(
          `Amiqus returned ${res.status} for ${method} ${path}. The request was not retried because it may already have been processed: check with list_records (or list_client_records for the client) before repeating it.${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      if (RETRY_GET_ONLY.has(res.status)) {
        // A GET that failed MAX_ATTEMPTS times in a row. The gateway body is usually HTML, so only a
        // JSON message is passed on. The status-codes guide says a 503 is "down for maintenance".
        throw new AmiqusError(
          `Amiqus returned ${res.status} for ${method} ${path} ${MAX_ATTEMPTS} times in a row. The service may be unavailable or in maintenance; try again in a few minutes.${detail ? " " + detail : ""}`,
          res.status,
        );
      }
      throw new AmiqusError(`Amiqus returned ${res.status} for ${method} ${path}.${detail ? " " + detail : ""}`, res.status);
    }
  }

  get<T = any>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }

  /**
   * Fetch a paginated list (page/limit query parameters, PaginatedList response). Whole pages only:
   * the page size sent is min(PAGE_SIZE, maxItems) and the loop stops BEFORE a page that could take
   * the total past `maxItems`, so a page is never cut in the middle. The size the next page could
   * have is the requested size, capped by the size the API actually applied to this page (its
   * `limit`, or this page's length when `limit` is missing: the guide says some endpoints have
   * smaller limits) and by what is left of `total` when it is known, so the last, short page of a
   * list is fetched when it fits. `next_page` is the first page not fetched and a continuation call
   * must send the same `max_results`.
   *
   * Stops at an empty page, at `maxPages`, or at the documented end of the list. Two signals are
   * read: the pagination guide says `links` is null when there is only one page and `links.next`
   * links to the next page while one exists, so a null `links` or a null `links.next` means the last
   * page; and `current_page` below `total_pages` (both documented in PaginatedList) means more pages.
   * The loop continues while either says there are more, so a live response that omitted `links`
   * would still be paged. `total` and `total_pages` are passed on for information.
   */
  async list<T = any>(
    path: string,
    { maxItems = PAGE_SIZE, maxPages = 10, page = 1, query = {} as Record<string, QueryValue> } = {},
  ): Promise<{ items: T[]; total?: number; total_pages?: number; page_size: number; complete: boolean; next_page?: number }> {
    const pageSize = Math.max(1, Math.min(PAGE_SIZE, maxItems));
    const items: T[] = [];
    let total: number | undefined;
    let totalPages: number | undefined;
    let current = page;
    for (let n = 0; n < maxPages; n++) {
      const res = await this.get<PaginatedList<T>>(path, { ...query, page: current, limit: pageSize });
      const data = Array.isArray(res?.data) ? res.data : [];
      total = intOrUndefined(res?.total) ?? total;
      totalPages = intOrUndefined(res?.total_pages) ?? totalPages;
      const currentPage = intOrUndefined(res?.current_page);
      items.push(...data);
      current++;
      const hasNextLink = !!res?.links && typeof res.links === "object" && typeof res.links.next === "string" && res.links.next !== "";
      const belowTotalPages = currentPage !== undefined && totalPages !== undefined && currentPage < totalPages;
      if (data.length === 0 || !(hasNextLink || belowTotalPages)) return { items, total, total_pages: totalPages, page_size: pageSize, complete: true };
      const appliedPageSize = intOrUndefined(res?.limit) ?? data.length;
      let nextPageMax = Math.min(pageSize, Math.max(1, appliedPageSize));
      if (total !== undefined) nextPageMax = Math.min(nextPageMax, Math.max(1, total - items.length));
      if (items.length + nextPageMax > maxItems) break;
    }
    return { items, total, total_pages: totalPages, page_size: pageSize, complete: false, next_page: current };
  }
}

/** The URL without query string or userinfo, for error messages. */
function originAndPath(url: URL): string {
  return url.origin + url.pathname;
}

/**
 * A base URL must not carry credentials ("https://user:secret@host/"): fetch() refuses such a URL and
 * its refusal message would quote it, so the server refuses it at start-up instead.
 */
function withoutUserinfo(url: string, variable: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new AmiqusError(`${variable} is not a valid URL.`);
  }
  if (u.username || u.password) throw new AmiqusError(`${variable} must not contain a username or password (got ${u.origin + u.pathname} with credentials in it). Use AMIQUS_ACCESS_TOKEN.`);
  return url;
}

/** What a body was, without quoting it: content type and size. A login page can carry anything. */
function describeBody(res: Response, text: string): string {
  const type = res.headers.get("content-type")?.split(";")[0].trim() || "no content-type";
  return `${type}, ${Buffer.byteLength(text)} bytes`;
}

function intOrUndefined(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/**
 * Retry-After in seconds, from either form allowed by RFC 9110 (delay-seconds or an HTTP-date).
 * Amiqus documents delay-seconds ("The number of seconds remaining before the rate limit resets").
 * A fractional number is accepted as seconds too. Anything else that is not an HTTP-date (which always
 * names a month, so contains letters) gives undefined, so the caller's fallback applies; without that
 * check Date.parse("1.5") would be read as a date in 2001 and the retry would happen at once.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const h = header.trim();
  if (/^\d+(\.\d+)?$/.test(h)) return Number(h);
  if (!/[A-Za-z]/.test(h)) return undefined;
  const at = Date.parse(h);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, (at - now) / 1000);
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Spec error bodies: 401 and some 404s are Error {error}, 403 is {message}, 404 on a record/client/check
// is {error: "<Thing> not found"}, and 422 is a map of dot-notated field path to a list of messages
// ({"fields.type": ["Value must be a string"]}).
function describeError(json: any): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const parts: string[] = [];
  for (const k of ["error", "message"]) if (typeof json[k] === "string" && json[k].trim()) parts.push(json[k].trim());
  const fields = Object.entries(json).filter(([k, v]) => k !== "error" && k !== "message" && Array.isArray(v) && v.every((m) => typeof m === "string"));
  for (const [field, messages] of fields.slice(0, 10)) parts.push(`${field}: ${(messages as string[]).join("; ")}`);
  return parts.length ? parts.join(" ") : undefined;
}
