#!/usr/bin/env node
// Amiqus MCP server: lets Claude, ChatGPT and other MCP clients read an Amiqus ID account (client
// onboarding with identity, AML, right-to-work and criminal-record checks) and, when enabled, create records.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AmiqusClient, AmiqusError, PAGE_SIZE } from "./client.js";
import * as fmt from "./format.js";

const env = (name: string) => process.env[name]?.trim() || undefined;
const accessToken = env("AMIQUS_ACCESS_TOKEN");
if (!accessToken) {
  console.error("AMIQUS_ACCESS_TOKEN is not set. Create a personal access token in Amiqus (see the Personal Access Token guide at developers.amiqus.co) and put it in AMIQUS_ACCESS_TOKEN.");
  process.exit(1);
}
const allowWrites = /^(1|true|yes)$/i.test(process.env.AMIQUS_ALLOW_WRITES ?? "");
let api: AmiqusClient;
try {
  api = new AmiqusClient(accessToken, env("AMIQUS_BASE_URL"));
} catch (err) {
  console.error(err instanceof AmiqusError ? err.message : String(err));
  process.exit(1);
}

const server = new McpServer(
  { name: "amiqus", version: "0.1.0" },
  {
    instructions: [
      "Tools for an Amiqus ID account: clients (the people being onboarded), records (a request sent to a client made of steps: identity, criminal-record, watchlist and other checks, document requests and forms), checks (the result of one check step), record/email/document templates, case status counts and webhooks.",
      "Everything is identified by a numeric ID; form templates by a UUID reference.",
      "Record statuses (spec): pending (active, no completed steps), started, complete, incomplete (expired with some steps done), waiting (a check is awaiting results), empty (expired, nothing done), paused, amendments, reviewed; failed is deprecated. Check statuses: pending, submitted, accepted, rejected, refer, failed, paused.",
      "Typical flow for 'where is X's onboarding?': list_clients with search, then list_client_records, then get_record (its steps show each check's status), then get_check for a result breakdown.",
      "Client names are returned by default. Email addresses, phone numbers, dates of birth, National Insurance numbers, a record's contact email and perform URL, and the identity-document data inside a check response are only returned when a tool is called with include_contact_details=true. In free text (references, messages, instructions, template content) emails, phone numbers, dates, UK postcodes and NI/NHS numbers are redacted by default. Identity-document images and files, form answers and webhook secrets are never returned.",
      "Creating a record (create_record) is only available when AMIQUS_ALLOW_WRITES=true; with notification 'email' it emails the client.",
    ].join("\n"),
  },
);

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

// Every ID on the endpoints this server calls is an integer path parameter.
const id = (what: string) => z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe(`${what} ID (a positive whole number)`);
// Free-text search fields: surrounding whitespace is dropped and a blank value counts as not given.
const searchText = (max: number, what: string) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((s) => s || undefined)
    .describe(what);
// The aggregate's start_date/end_date are typed date-time, and the data-formats guide gives the wire
// form as YYYY-MM-DDTHH:MM:SSZ (Z: UTC). Every accepted input is rewritten to exactly that form before
// it is sent (toWireDateTime): a date alone becomes the start (00:00:00) or end (23:59:59) of that day
// in UTC, missing seconds become :00, a time without a zone is taken as UTC, an offset (+01:00) is
// converted to UTC, and fractions of a second are dropped. Date.parse alone would accept 2026-02-30 (V8
// rolls it over to 2 March), so the calendar date is checked by formatting it back, guarded so an
// impossible month (2026-13-01, where Date.parse gives NaN and toISOString would throw a RangeError)
// gets the same "Not a real calendar date" answer.
const DATE_TIME = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,7})?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const isRealDate = (date: string) => {
  const t = Date.parse(`${date}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === date;
};
const toWireDateTime = (s: string, bound: "start" | "end"): string | undefined => {
  const m = DATE_TIME.exec(s);
  if (!m || !isRealDate(m[1])) return undefined;
  const [, date, hoursMinutes, seconds, zone] = m;
  const t = Date.parse(hoursMinutes ? `${date}T${hoursMinutes}:${seconds ?? "00"}${zone ?? "Z"}` : `${date}T${bound === "start" ? "00:00:00" : "23:59:59"}Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
};
const dateTimeInput = (bound: "start" | "end", what: string) =>
  z
    .string()
    .regex(DATE_TIME, "Use an ISO 8601 date or date-time, e.g. 2026-09-01 or 2026-09-01T09:00:00Z")
    .refine((s) => !DATE_TIME.test(s) || isRealDate(s.slice(0, 10)), "Not a real calendar date")
    .refine((s) => !DATE_TIME.test(s) || !isRealDate(s.slice(0, 10)) || toWireDateTime(s, bound) !== undefined, "Not a valid time of day")
    .optional()
    .transform((s) => (s === undefined ? undefined : toWireDateTime(s, bound) ?? s))
    .describe(`${what} (ISO 8601 date or date-time, sent to the API as YYYY-MM-DDTHH:MM:SSZ: a date alone means the ${bound} of that day in UTC, a time without a zone is taken as UTC, an offset is converted to UTC, fractions of a second are dropped)`);
const paging = {
  max_results: z.number().int().min(1).max(1000).default(100).describe("Most records to return in this call; whole API pages only (up to 100 per page), so fewer may come back with a next_page to continue from"),
  page: z.number().int().min(1).default(1).describe("API page number to start from (1-based, as documented; use next_page from a previous call)"),
};
const includeContact = (what: string) => z.boolean().default(false).describe(`Include ${what}. Off by default.`);
const ORDER = z.enum(["asc", "desc"]).optional().describe("Sort direction (API parameter `order_by`; ascending by default)");
// A team member's user ID, or false for "unassigned" (spec: the parameter is integer or the boolean false).
const assigneeFilter = (what: string) => z.union([z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), z.literal(false)]).optional().describe(what);

type Json = Record<string, unknown> | unknown[];
const ok = (data: Json) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (err: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: err instanceof AmiqusError ? err.message : `Unexpected error: ${(err as Error)?.message ?? String(err)}` }],
});
const safe = <A>(fn: (args: A) => Promise<Json>) => async (args: A) => {
  try {
    return ok(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

const pageNote = (r: { complete: boolean; next_page?: number }, maxResults: number) =>
  r.complete ? undefined : `More results exist; call again with page ${r.next_page} and the same max_results (${maxResults}) to continue.`;
const listMeta = (r: { items: unknown[]; total?: number; total_pages?: number; page_size: number; complete: boolean; next_page?: number }, page: number, maxResults: number) => ({
  count: r.items.length,
  total: r.total,
  total_pages: r.total_pages,
  page,
  page_size: r.page_size,
  complete: r.complete,
  next_page: r.next_page,
  note: pageNote(r, maxResults),
});

server.registerTool(
  "list_clients",
  {
    title: "List clients",
    description:
      "Clients (the people being onboarded) with name, decision status (pending/approved/rejected, or none yet), reference, retention date and timestamps. Filter by a fuzzy search on names, reference and organisation name; by status; active or archived; assignee; exact reference; deletion-date bucket; and sort by name or date. Uses GET /clients. Emails, phone numbers, dates of birth and National Insurance numbers only with include_contact_details.",
    inputSchema: {
      search: searchText(200, "Case-insensitive fuzzy search on first, middle and last name, reference and organisation name (API parameter `search`)"),
      status: z.enum(["pending", "approved", "rejected"]).optional().describe("Only clients with this decision status (`status`)"),
      visibility: z.enum(["active", "archived"]).optional().describe("Only active or only archived clients (`visibility`; both by default)"),
      assignee: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("Only clients assigned to this team member's user ID (`assignee`)"),
      reference: searchText(200, "Exact, case-insensitive match on the client reference (`reference`)"),
      deletion_date: z.enum(["upcoming", "today", "overdue", "not_set"]).optional().describe("Only clients whose deletion date is in this bucket (`deletion_date`)"),
      sort_by: z.enum(["name.first_name", "name.last_name", "deletion_date", "created_at", "updated_at", "archived_at"]).optional().describe("Sort field (`sort_by`; ID order by default)"),
      order_by: ORDER,
      ...paging,
      include_contact_details: includeContact("each client's email address, landline, mobile, date of birth and National Insurance number, and stop redacting emails, phone numbers, dates, postcodes and NI/NHS numbers typed into names and references"),
    },
    annotations: READ,
  },
  safe(async ({ search, status, visibility, assignee, reference, deletion_date, sort_by, order_by, max_results, page, include_contact_details }) => {
    const r = await api.list("/clients", { maxItems: max_results, maxPages: 20, page, query: { search, status, visibility, assignee, reference, deletion_date, sort_by, order_by } });
    return { ...listMeta(r, page, max_results), clients: r.items.map((c) => fmt.client(c, include_contact_details)) };
  }),
);

server.registerTool(
  "get_client",
  {
    title: "Get client",
    description: "One client by ID: name, decision status, reference, whether archived, retention (deletion) date and timestamps. Uses GET /clients/{id}. Contact details, date of birth and National Insurance number only with include_contact_details.",
    inputSchema: { client_id: id("Client"), include_contact_details: includeContact("the client's email address, landline, mobile, date of birth and National Insurance number") },
    annotations: READ,
  },
  safe(async ({ client_id, include_contact_details }) => ({ client: fmt.client(await api.get(`/clients/${client_id}`), include_contact_details) })),
);

server.registerTool(
  "list_client_records",
  {
    title: "Records for a client",
    description:
      "Every record (onboarding request) sent to one client, with status, the steps it contains (type, completion, cost, check/document/form IDs) and dates. Uses GET /clients/{id}/records. The record's contact email and perform URL only with include_contact_details.",
    inputSchema: { client_id: id("Client"), ...paging, include_contact_details: includeContact("each record's contact email and perform URL, and stop redacting emails, phone numbers, dates, postcodes and NI/NHS numbers in names, references and step preferences") },
    annotations: READ,
  },
  safe(async ({ client_id, max_results, page, include_contact_details }) => {
    const r = await api.list(`/clients/${client_id}/records`, { maxItems: max_results, maxPages: 20, page });
    return { client_id, ...listMeta(r, page, max_results), records: r.items.map((x) => fmt.record(x, include_contact_details)) };
  }),
);

server.registerTool(
  "list_records",
  {
    title: "List records",
    description:
      "Records (onboarding requests) across the team, each with status, the client's name and ID, its steps and dates. Filter by status, active/archived, creator, assignee (or unassigned), and the client's visibility; sort by client name or date. Uses GET /records.",
    inputSchema: {
      status: z.enum(["pending", "started", "complete", "incomplete", "waiting", "failed", "empty", "paused", "amendments", "reviewed"]).optional().describe("Only records with this status (`status`)"),
      visibility: z.enum(["active", "archived"]).optional().describe("Only active or only archived records (`visibility`; both by default)"),
      created_by: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().describe("Only records created by this team member's user ID (`created_by`)"),
      assignee: assigneeFilter("Only records assigned to this team member's user ID, or false for unassigned records only (`assignee`)"),
      client_visibility: z.enum(["active", "archived"]).optional().describe("Only records whose client is active, or archived (`client_visibility`)"),
      sort_by: z.enum(["client.name.first_name", "client.name.last_name", "created_at", "updated_at", "archived_at"]).optional().describe("Sort field (`sort_by`; created_at by default)"),
      order_by: ORDER,
      ...paging,
      include_contact_details: includeContact("each record's contact email and perform URL, and stop redacting emails, phone numbers, dates, postcodes and NI/NHS numbers in names, references and step preferences"),
    },
    annotations: READ,
  },
  safe(async ({ status, visibility, created_by, assignee, client_visibility, sort_by, order_by, max_results, page, include_contact_details }) => {
    const r = await api.list("/records", { maxItems: max_results, maxPages: 20, page, query: { status, visibility, created_by, assignee, client_visibility, sort_by, order_by } });
    return { ...listMeta(r, page, max_results), records: r.items.map((x) => fmt.record(x, include_contact_details)) };
  }),
);

server.registerTool(
  "get_record",
  {
    title: "Get record",
    description:
      "One record by ID with its steps. By default the steps are fetched with their check and latest review expanded (GET /records/{id} then GET /records/{id}/steps?expand=check,review), so each check step shows the check's status (pending, submitted, accepted, rejected, refer, failed, paused) and whether a team member has reviewed it. Use get_check for a result breakdown. The record's contact email and perform URL only with include_contact_details.",
    inputSchema: {
      record_id: id("Record"),
      include_step_details: z.boolean().default(true).describe("Also call GET /records/{id}/steps?expand=check,review so each step carries its check status and latest review. Off gives the record's own step list (IDs only)."),
      include_contact_details: includeContact("the record's contact email and perform URL, and stop redacting emails, phone numbers, dates, postcodes and NI/NHS numbers in names, references, step preferences and review messages"),
    },
    annotations: READ,
  },
  safe(async ({ record_id, include_step_details, include_contact_details }) => {
    const r = await api.get(`/records/${record_id}`);
    let steps: Record<string, any>[] | undefined;
    let note: string | undefined;
    if (include_step_details) {
      const s = await api.list(`/records/${record_id}/steps`, { maxItems: 500, maxPages: 5, query: { expand: ["check", "review"] } });
      steps = s.items;
      if (!s.complete) note = `Only the first ${s.items.length} steps were fetched.`;
    }
    return { record: fmt.record(r, include_contact_details, steps), note };
  }),
);

server.registerTool(
  "get_check",
  {
    title: "Get check result",
    description:
      "One check by ID (from a record's check steps) with its type, status and, when Amiqus has one, the response: overall result and each report's status, result and verification breakdown (which verifications were clear or need consideration). Uses GET /checks/{id}?expand=response. The spec marks check responses as beta and documents the Photo ID response in detail; other types may come back as 'not yet available'. Identity-document data read from the document (names, date of birth, document numbers, MRZ) and the eVisa report's name and reference only with include_contact_details; the document images, selfie and PDF are never returned.",
    inputSchema: {
      check_id: id("Check"),
      include_contact_details: includeContact("the identity-document data extracted by the check and the eVisa report's name and reference (never the images or files)"),
    },
    annotations: READ,
  },
  safe(async ({ check_id, include_contact_details }) => ({ check: fmt.check(await api.get(`/checks/${check_id}`, { expand: ["response"] }), include_contact_details) })),
);

server.registerTool(
  "list_templates",
  {
    title: "List templates",
    description:
      "Templates on the team: record templates (the preset steps, notification, message, reminders and assignees a create_record from that template would use; GET /templates/records), email templates (GET /templates/emails) or document templates (GET /templates/documents). Optionally only enabled or only disabled ones.",
    inputSchema: {
      kind: z.enum(["records", "emails", "documents"]).default("records").describe("Which template list"),
      enabled: z.boolean().optional().describe("Only enabled (true) or only disabled (false) templates (API parameter `enabled`; both by default)"),
      ...paging,
    },
    annotations: READ,
  },
  safe(async ({ kind, enabled, max_results, page }) => {
    const r = await api.list(`/templates/${kind}`, { maxItems: max_results, maxPages: 20, page, query: { enabled } });
    return { kind, ...listMeta(r, page, max_results), templates: r.items.map((t) => (kind === "records" ? fmt.recordTemplate(t) : fmt.textTemplate(t))) };
  }),
);

server.registerTool(
  "case_status_summary",
  {
    title: "Case status summary",
    description:
      "How many cases are in each status (awaiting_response, action_required, reviewed_pending_decision, approved, rejected, on_hold; pending is deprecated), optionally for one assignee or unassigned cases, for statuses updated in a date range, and active or archived cases. Uses GET /aggregates/case-status. The spec notes cases may not be enabled for all teams; a 403 then says so.",
    inputSchema: {
      assigned_to: assigneeFilter("Only cases assigned to this team member ID, or false for unassigned cases (`assigned_to`)"),
      start_date: dateTimeInput("start", "Only statuses updated on or after this date/time (`start_date`)"),
      end_date: dateTimeInput("end", "Only statuses updated on or before this date/time (`end_date`)"),
      visibility: z.enum(["active", "archived"]).optional().describe("Only active or only archived cases (`visibility`; both by default)"),
    },
    annotations: READ,
  },
  safe(async ({ assigned_to, start_date, end_date, visibility }) => {
    const a = await api.get("/aggregates/case-status", { assigned_to, start_date, end_date, visibility });
    return fmt.caseStatusAggregate(a);
  }),
);

server.registerTool(
  "list_webhooks",
  {
    title: "List webhooks",
    description: "Webhook subscriptions on the team: delivery URL (origin and path only), subscribed events, enabled flag and dates. The signing secret is never returned. Uses GET /webhooks.",
    inputSchema: { enabled: z.boolean().optional().describe("Only enabled (true) or only disabled (false) webhooks (API parameter `enabled`; both by default)"), ...paging },
    annotations: READ,
  },
  safe(async ({ enabled, max_results, page }) => {
    const r = await api.list("/webhooks", { maxItems: max_results, maxPages: 20, page, query: { enabled } });
    return { ...listMeta(r, page, max_results), webhooks: r.items.map(fmt.webhook) };
  }),
);

if (allowWrites) {
  const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

  server.registerTool(
    "create_record",
    {
      title: "Create a record",
      description:
        "Create a record (an onboarding request) for an existing client, either from a record template (template_id, optionally without the template's assignees) or from an explicit list of steps with a notification setting, message, reminders and declaration flag. With notification 'email' Amiqus emails the client a 'New Request' notification; with false it does not. Steps are passed to the API as given ({type, preferences}); the types and preferences are the ones documented for POST /records (check.photo_id, check.criminal_record, check.watchlist, document.request, form, ...), and Amiqus answers 422 with the field errors if they are wrong. If Amiqus answers with a gateway error (502/503/504) the request is NOT retried, because the record may already exist: check with list_client_records before calling again. Only available when AMIQUS_ALLOW_WRITES=true.",
      inputSchema: {
        client_id: id("Client").describe("The client the record is for (`client`)"),
        template_id: id("Record template").optional().describe("Create from this record template (`template`, from list_templates). Cannot be combined with steps."),
        template_assignees: z.boolean().optional().describe("Template mode only: assign the template's team members to the new record (`assignees`; the API default is true)"),
        steps: z
          .array(z.object({ type: z.string().min(1).max(100).describe("Step type, e.g. check.photo_id, check.criminal_record, check.watchlist, document.request, form"), preferences: z.record(z.string(), z.unknown()).optional().describe("The step's preferences as documented for its type") }))
          .min(1)
          .optional()
          .describe("Manual mode: the steps the client must complete (`steps`). Cannot be combined with template_id."),
        notification: z.union([z.literal("email"), z.literal(false)]).optional().describe("Manual mode (required there): 'email' to send the client a New Request email, false to send nothing (`notification`)"),
        message: z.string().max(5000).optional().describe("Manual mode: message shown to the client before the first step and included in the email (`message`)"),
        reminder: z.boolean().optional().describe("Manual mode: email the client a reminder every 2 days until done (`reminder`; API default false)"),
        is_declaration_required: z.boolean().optional().describe("Manual mode: require the team's custom declaration (`is_declaration_required`; feature may not be enabled)"),
      },
      annotations: WRITE,
    },
    safe(async ({ client_id, template_id, template_assignees, steps, notification, message, reminder, is_declaration_required }) => {
      // Spec POST /records requestBody: oneOf "Template" {client, template, assignees?} and "Manual"
      // {client} + RecordSettings {steps (required), notification (required), message?, reminder?,
      // is_declaration_required?}. The two are checked locally so a mixed request never reaches the API.
      const problems: string[] = [];
      if (template_id !== undefined && steps !== undefined) problems.push("Give either template_id or steps, not both.");
      if (template_id === undefined && steps === undefined) problems.push("Give template_id (create from a record template) or steps (an explicit step list).");
      if (template_id !== undefined) {
        const manualOnly = { notification, message, reminder, is_declaration_required };
        const given = Object.entries(manualOnly).filter(([, v]) => v !== undefined).map(([k]) => k);
        if (given.length) problems.push(`${given.join(", ")} cannot be set when creating from a template; the template's presets apply.`);
      } else {
        if (notification === undefined) problems.push("notification is required when creating from steps: 'email' to notify the client, or false.");
        if (template_assignees !== undefined) problems.push("template_assignees only applies when creating from a template.");
      }
      if (problems.length) throw new AmiqusError(`Not created. ${problems.join(" ")}`);

      const body =
        template_id !== undefined
          ? { client: client_id, template: template_id, ...(template_assignees !== undefined ? { assignees: template_assignees } : {}) }
          : {
              client: client_id,
              steps: steps!.map((s) => ({ type: s.type, ...(s.preferences !== undefined ? { preferences: s.preferences } : {}) })),
              notification,
              ...(message !== undefined ? { message } : {}),
              ...(reminder !== undefined ? { reminder } : {}),
              ...(is_declaration_required !== undefined ? { is_declaration_required } : {}),
            };
      const res = await api.request("POST", "/records", { body });
      return { result: "created", record: fmt.record(res, false) };
    }),
  );
}

await server.connect(new StdioServerTransport());
console.error(`Amiqus MCP server running (writes ${allowWrites ? "enabled" : "disabled"}).`);
