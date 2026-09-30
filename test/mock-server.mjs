// Local stand-in for https://id.amiqus.co/api/v2, serving the fixtures with the documented page/limit
// pagination (PaginatedList with links.next/previous), the documented auth (Authorization: Bearer
// <personal access token>), the documented X-RateLimit-* headers, and the documented error shapes.
import http from "node:http";
import * as fx from "./fixtures.mjs";

export const ACCESS_TOKEN = "aq-test-token-not-real";
export const AUTH = `Bearer ${ACCESS_TOKEN}`;
export const BASE_PATH = "/api/v2";
// Rate-limits guide example: X-RateLimit-Limit: 200.
export const RATE_LIMIT = 200;
// The mock's "today" for the deletion_date buckets (upcoming / today / overdue / not_set), fixed so
// the fixtures' dates keep meaning the same thing.
const TODAY = "2026-09-28";

// Error bodies. The spec documents Error {error} for 401, {message} for 403, {error: "<Thing> not
// found"} for the record/client/check 404s and a {field: [messages]} map for 422. The message texts
// are the mock's own placeholders except the 404 defaults, which are the spec's.
const unauthenticated = () => ({ error: "Unauthenticated." });
const notFound = (what) => ({ error: `${what} not found` });
const forbidden = (message) => ({ message });
const invalid = (field, ...messages) => ({ [field]: messages });

// The spec's StepTypes enum: every step type POST /records accepts.
const STEP_TYPES = ["check.credit", "check.criminal_record", "check.dummy", "check.hscni_access_ni", "check.identity", "check.nhs_esr", "check.banking_information", "check.photo_id", "check.employment_referencing", "check.reference", "check.thorntons_onboarding", "check.video", "check.watchlist", "document.request", "document.transfer", "form"];

// The documented `expand` values per endpoint (spec query parameters).
const EXPANDS = {
  "/records/{id}/steps": ["check", "form", "document", "review"],
  "/checks/{id}": ["record", "response"],
  "/records/{id}": ["client"],
  "/records": ["client"],
  "/clients/{id}/records": ["client"],
};

export function startMock() {
  const requests = [];
  // Injected failures: { method, path, status, times, headers, body }. Each matching request consumes one
  // "time" and gets that status instead of the normal answer. The suite starts with a single 429 on
  // GET /templates/records so the retry path is exercised by the schema check and the MCP run alike.
  const failure429 = () => ({ method: "GET", path: "/templates/records", status: 429, times: 1, headers: { "Retry-After": "1", "X-RateLimit-Reset": "1790000000" }, body: { error: "Too Many Attempts." } });
  let failures = [failure429()];
  // When set, every list page is capped at this many items even if more were requested, to imitate the
  // pagination guide's "Some endpoints may have different limits."
  let pageCap;
  // When true, the `links` key is left out of every PaginatedList (the schema does not require it),
  // so the client has only current_page/total_pages to tell whether more pages exist.
  let omitLinks = false;
  let remaining = RATE_LIMIT;
  const created = [];
  let nextId = 995000;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.startsWith(BASE_PATH) ? url.pathname.slice(BASE_PATH.length) || "/" : url.pathname;
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, accept: req.headers.accept, contentType: req.headers["content-type"], body: body ? JSON.parse(body) : undefined, t: Date.now() });

    remaining = Math.max(0, remaining - 1);
    const send = (status, json, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Remaining": String(remaining), ...headers });
      res.end(json === undefined ? "" : JSON.stringify(json));
    };
    if (req.headers.authorization !== AUTH) return send(401, unauthenticated());

    const failure = failures.find((f) => f.times > 0 && f.method === req.method && f.path === path);
    if (failure) {
      failure.times--;
      if (failure.body === undefined) {
        // Gateway-style error: not JSON, like a real 502 page.
        res.writeHead(failure.status, { "Content-Type": "text/html", ...(failure.headers ?? {}) });
        return res.end(`<html><body><h1>${failure.status}</h1></body></html>`);
      }
      return send(failure.status, failure.body, { "X-RateLimit-Remaining": failure.status === 429 ? "0" : String(remaining), ...(failure.headers ?? {}) });
    }

    // Pagination: page (min 1) and limit (1..100), PaginatedList with links to the next and previous
    // pages carrying the current query parameters (pagination guide), and links null for a single page.
    const rawLimit = url.searchParams.get("limit");
    const rawPage = url.searchParams.get("page");
    const paginate = (items) => {
      const requested = rawLimit === null ? 25 : Number(rawLimit);
      if (!Number.isInteger(requested) || requested < 1 || requested > 100) return [422, invalid("limit", "The limit must be between 1 and 100.")];
      const page = rawPage === null ? 1 : Number(rawPage);
      if (!Number.isInteger(page) || page < 1) return [422, invalid("page", "The page must be at least 1.")];
      const limit = pageCap ? Math.min(requested, pageCap) : requested;
      const totalPages = Math.max(1, Math.ceil(items.length / limit));
      const data = items.slice((page - 1) * limit, page * limit);
      const link = (p) => {
        const u = new URL(`https://id.amiqus.co${BASE_PATH}${path}`);
        for (const [k, v] of url.searchParams) u.searchParams.set(k, v);
        u.searchParams.set("page", String(p));
        return u.toString();
      };
      const links = totalPages <= 1 ? null : { next: page < totalPages ? link(page + 1) : null, previous: page > 1 ? link(page - 1) : null };
      const list = { object: "paginated_list", data, total: items.length, count: data.length, limit, current_page: page, total_pages: totalPages, links };
      if (omitLinks) delete list.links;
      return [200, list];
    };
    const sendPage = (items) => send(...paginate(items));
    const expandOf = (template) => {
      const raw = url.searchParams.get("expand");
      if (raw === null) return new Set();
      const values = raw.split(",").map((s) => s.trim());
      const allowed = EXPANDS[template] ?? [];
      if (values.some((v) => !allowed.includes(v))) return null;
      return new Set(values);
    };
    const badExpand = (template) => send(422, invalid("expand", `The expand parameter must be one of: ${EXPANDS[template].join(", ")}`));

    const sortBy = (items, key, get) => {
      const by = url.searchParams.get("sort_by");
      const order = url.searchParams.get("order_by") === "desc" ? -1 : 1;
      const list = [...items];
      const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);
      if (by) list.sort((a, b) => cmp(get(a, by), get(b, by)) * order || a.id - b.id);
      else if (key) list.sort((a, b) => cmp(a[key], b[key]) || a.id - b.id);
      return list;
    };
    const isArchived = (x) => x.archived_at !== null;
    const visible = (items, param = "visibility") => {
      const v = url.searchParams.get(param);
      return v === "active" ? items.filter((x) => !isArchived(x)) : v === "archived" ? items.filter(isArchived) : items;
    };
    const clientById = (id) => fx.clients.find((c) => c.id === id);

    // Collapse an expanded check the way the API does when `response` is not expanded: an object
    // becomes `true`, null stays null.
    const collapsedCheck = (c) => ({ ...c, response: c.response && typeof c.response === "object" ? true : c.response });
    const expandStep = (s, expand) => {
      const out = { ...s };
      if (expand.has("check") && typeof s.check === "number" && fx.checks[s.check]) out.check = collapsedCheck(fx.checks[s.check]);
      if (expand.has("review") && typeof s.review === "number" && fx.reviews[s.review]) out.review = fx.reviews[s.review];
      return out;
    };

    const p = path.split("/").filter(Boolean);
    const m = req.method;
    const intId = (s) => (/^\d+$/.test(s) ? Number(s) : undefined);

    if (p[0] === "clients" && m === "GET") {
      if (p.length === 1) {
        const q = url.searchParams;
        const search = q.get("search")?.toLowerCase();
        const status = q.get("status");
        const assignee = q.get("assignee");
        const reference = q.get("reference")?.toLowerCase();
        const deletion = q.get("deletion_date");
        let items = fx.clients.filter((c) => {
          if (search && ![c.name.first_name, c.name.middle_name, c.name.last_name, c.reference].some((s) => typeof s === "string" && s.toLowerCase().includes(search))) return false;
          if (status && c.status !== status) return false;
          if (assignee && !(fx.clientAssignees[c.id] ?? []).includes(Number(assignee))) return false;
          if (reference && (c.reference ?? "").toLowerCase() !== reference) return false;
          if (deletion === "not_set" && c.deletion_date !== null) return false;
          if (deletion === "upcoming" && !(c.deletion_date !== null && c.deletion_date > TODAY)) return false;
          if (deletion === "today" && c.deletion_date !== TODAY) return false;
          if (deletion === "overdue" && !(c.deletion_date !== null && c.deletion_date < TODAY)) return false;
          return true;
        });
        items = sortBy(visible(items), undefined, (c, by) => (by.startsWith("name.") ? c.name[by.slice(5)] : c[by]));
        return sendPage(items);
      }
      const id = intId(p[1]);
      const c = id !== undefined ? clientById(id) : undefined;
      if (!c) return send(404, notFound("Client"));
      if (p.length === 2) return send(200, c);
      if (p.length === 3 && p[2] === "records") {
        if (expandOf("/clients/{id}/records") === null) return badExpand("/clients/{id}/records");
        return sendPage([...fx.records, ...created].filter((r) => r.client === id));
      }
    }

    if (p[0] === "records") {
      if (p.length === 1 && m === "GET") {
        if (expandOf("/records") === null) return badExpand("/records");
        const q = url.searchParams;
        const status = q.get("status");
        const createdBy = q.get("created_by") ?? q.get("creator");
        const assignee = q.get("assignee");
        let items = [...fx.records, ...created].filter((r) => {
          const meta = fx.recordMeta[r.id] ?? { created_by: fx.USER_JO, assignees: [] };
          if (status && r.status !== status) return false;
          if (createdBy && meta.created_by !== Number(createdBy)) return false;
          if (assignee === "false" && meta.assignees.length) return false;
          if (assignee && assignee !== "false" && !meta.assignees.includes(Number(assignee))) return false;
          return true;
        });
        items = visible(items);
        const cv = q.get("client_visibility");
        if (cv) items = items.filter((r) => (cv === "archived") === isArchived(clientById(r.client) ?? { archived_at: null }));
        // Spec: "Results returned in created_at order by default".
        items = sortBy(items, "created_at", (r, by) => (by.startsWith("client.name.") ? r.name[by.slice(12)] : r[by]));
        return sendPage(items);
      }
      if (p.length === 1 && m === "POST") {
        const b = body ? JSON.parse(body) : {};
        const client = Number.isInteger(b.client) ? clientById(b.client) : undefined;
        if (!client) return send(422, invalid("client", Number.isInteger(b.client) ? "The selected client is invalid." : "The client field is required."));
        let steps;
        if (b.template !== undefined) {
          const t = fx.recordTemplates.find((x) => x.id === b.template);
          if (!t) return send(422, invalid("template", "The selected template is invalid."));
          steps = t.presets.steps.filter((s) => s.object === "preset_step").map((s) => ({ type: s.type, preferences: s.preferences }));
        } else {
          if (!Array.isArray(b.steps) || !b.steps.length) return send(422, invalid("steps", "The steps field is required when template is not present."));
          if (b.notification !== "email" && b.notification !== false) return send(422, invalid("notification", "The notification field is required when template is not present."));
          for (const [i, s] of b.steps.entries()) if (typeof s?.type !== "string" || !STEP_TYPES.includes(s.type)) return send(422, invalid(`steps.${i}.type`, "The selected type is invalid."));
          steps = b.steps;
        }
        const id = nextId++;
        const rec = {
          object: "record",
          id,
          status: "pending",
          perform_url: `https://id.amiqus.co/i/test-perform-${id}`,
          email: client.email,
          client: client.id,
          name: client.name,
          reference: client.reference,
          steps: steps.map((s, i) => {
            const base = { object: "step", id: id * 10 + i, type: s.type, ...(s.preferences ? { preferences: s.preferences } : {}), cost: s.type.startsWith("check.") ? 1 : 0, completed_at: null };
            if (s.type.startsWith("check.")) {
              const checkId = 900000 + id * 10 + i;
              fx.checks[checkId] = { object: "check", id: checkId, type: s.type.slice(6), record: id, status: "pending", response: null, allow_replay: true, allow_cancel: true, requires_consent: true, created_at: "2026-09-28T10:00:00Z", updated_at: "2026-09-28T10:00:00Z" };
              return { ...base, check: checkId, review: null };
            }
            // A document step written with {template: N} reads back with the template's title and
            // instructions (the spec's own 201 example: {template: 15478} becomes "Utility bill"); a form
            // step's `form` preference is write-only and reads back as the `form` reference.
            if (s.type.startsWith("document.")) {
              const prefs = s.preferences?.template !== undefined ? { title: `Document template ${s.preferences.template}`, instructions: "As configured in the document template." } : s.preferences;
              return { ...base, preferences: prefs, document: 800000 + id * 10 + i, review: false };
            }
            const { preferences: _formPrefs, ...formBase } = base;
            return { ...formBase, form: s.preferences?.form ?? "00000000-0000-4000-8000-000000000000", review: false };
          }),
          has_reminders: b.reminder === true,
          created_at: "2026-09-28T10:00:00Z",
          updated_at: "2026-09-28T10:00:00Z",
          expired_at: "2026-10-08T10:00:00Z",
          archived_at: null,
          is_declaration_required: b.is_declaration_required === true,
          declaration_confirmed_at: null,
        };
        created.push(rec);
        return send(201, rec);
      }
      const id = intId(p[1]);
      const r = id !== undefined ? [...fx.records, ...created].find((x) => x.id === id) : undefined;
      if (!r) return send(404, notFound("Record"));
      if (p.length === 2 && m === "GET") {
        if (expandOf("/records/{id}") === null) return badExpand("/records/{id}");
        return send(200, r);
      }
      if (p.length === 3 && p[2] === "steps" && m === "GET") {
        const expand = expandOf("/records/{id}/steps");
        if (expand === null) return badExpand("/records/{id}/steps");
        return sendPage(r.steps.map((s) => expandStep(s, expand)));
      }
    }

    if (p[0] === "checks" && m === "GET" && p.length === 2) {
      const expand = expandOf("/checks/{id}");
      if (expand === null) return badExpand("/checks/{id}");
      const id = intId(p[1]);
      const c = id !== undefined ? fx.checks[id] : undefined;
      if (!c) return send(404, notFound("Check"));
      return send(200, expand.has("response") ? c : collapsedCheck(c));
    }

    if (p[0] === "templates" && m === "GET" && p.length === 2) {
      const lists = { records: fx.recordTemplates, emails: fx.emailTemplates, documents: fx.documentTemplates };
      const items = lists[p[1]];
      if (!items) return send(404, notFound("Route"));
      const enabled = url.searchParams.get("enabled");
      return sendPage(enabled === null ? items : items.filter((t) => t.is_enabled === (enabled === "true" || enabled === "1")));
    }

    if (p[0] === "webhooks" && m === "GET" && p.length === 1) {
      const enabled = url.searchParams.get("enabled");
      return sendPage(enabled === null ? fx.webhooks : fx.webhooks.filter((w) => w.is_enabled === (enabled === "true" || enabled === "1")));
    }

    if (p[0] === "aggregates" && p[1] === "case-status" && m === "GET" && p.length === 2) {
      // The spec notes cases "may not be enabled for all teams"; the mock's team has them.
      const v = url.searchParams.get("visibility");
      if (v && v !== "active" && v !== "archived") return send(422, invalid("visibility", "The selected visibility is invalid."));
      return send(200, fx.caseStatusAggregate);
    }

    if (p[0] === "status" && m === "GET" && p.length === 1) return send(204, undefined);
    if (p[0] === "me" || p[0] === "team") return send(403, forbidden("This action is unauthorized."));
    return send(404, notFound("Route"));
  });

  /** Queue a failure for the next `times` requests matching method+path (body undefined = non-JSON gateway page). */
  const arm = ({ method, path, status, times = 1, headers, body }) => {
    failures.push({ method, path, status, times, headers, body });
  };
  const arm429 = ({ persistent = false, retryAfter = "1" } = {}) => {
    failures = [{ ...failure429(), times: persistent ? Infinity : 1, headers: { "Retry-After": retryAfter, "X-RateLimit-Reset": "1790000000" } }];
  };
  const disarm = () => {
    failures = [];
  };
  /** Cap every list page at `n` items (undefined removes the cap). */
  const setPageCap = (n) => {
    pageCap = n;
  };
  /** Leave `links` out of list responses (true) or send it as documented (false). */
  const setOmitLinks = (on) => {
    omitLinks = on;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, arm, arm429, disarm, setPageCap, setOmitLinks, created })));
}
