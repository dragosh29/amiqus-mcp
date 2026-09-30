// Turn Amiqus ID API records into compact objects an assistant can read quickly.
// Field names follow the schemas in Amiqus's OpenAPI spec (Client, Name, Record, Record Steps,
// Step Review, Check, Check Response, Record Template, Email Template, Document Template, Webhook,
// Case status aggregate).

type Rec = Record<string, any>;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Phone-number-like sequences, a heuristic. Three shapes, digits optionally separated by a space, dot
// or hyphen:
//   international: "+" or "00", a 1-3 digit country code, an optional "(0)" trunk prefix, then 6-14
//     digits (+44 7700 900123, +447700900321, +44 (0)7700 900123, 0044 20 7946 0958, 00 44 7700 900123);
//   bracketed UK area code: "(0...)" then 5-10 digits ((020) 7946 0958, (0117) 496 0000, (07700) 900789);
//   UK national: "0" then 8-10 more digits (07700 900789, 020 7946 0958, 07 700 900 789, 07700.900123).
// Bounded by characters other than letters, digits, "_" and "-", so numeric IDs, UUIDs, timestamps
// and hyphenated references such as MCFLY-1955 are left alone. Any other 9-11 digit string starting
// with 0 (an order number, say) is redacted too; the raw text is available with include_contact_details.
const PHONE = /(?<![\w-])(?:(?:\+|00)[ .-]?[1-9]\d{0,2}(?:[ .-]?\(0\))?(?:[ .-]?\d){6,14}|\(0\d{0,4}\)(?:[ .-]?\d){5,10}|0(?:[ .-]?\d){8,10})(?![\w-])/g;
// Dates without a time of day, the shape of a date of birth or a document date: ISO 1968-06-12, UK
// 12/06/1968 or 12/06/68, 12.06.1968, 12 June 1968, June 12th, 1968. The same boundaries as PHONE, so
// a timestamp (2026-08-22T09:00:00Z: a letter follows the date) and a reference such as REF-2026-08-22
// are left alone. Street addresses are words and are not matched; postcodes are (below).
const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE = new RegExp(
  `(?<![\\w-])(?:\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/(?:\\d{4}|\\d{2})|\\d{1,2}\\.\\d{1,2}\\.\\d{4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})(?![\\w-])`,
  "gi",
);
// UK postcode: outward code (letters, a digit, an optional letter or digit) and inward code (a digit
// and two letters), with or without the space: EH1 2AB, SW1A 1AA, m1 1ae.
const POSTCODE = /(?<![\w-])[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}(?![\w-])/gi;
// National Insurance number: two letters (real prefixes never use D, F, I, U or V; Q is allowed
// because QQ is the standard example prefix), six digits and a final A-D, spaces optional
// (QQ123456C, QQ 12 34 56 C).
const NI_NUMBER = /(?<![\w-])[A-CEGHJ-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![\w-])/gi;
// NHS number: ten digits, written 3-3-4, whose last digit is the modulus-11 check digit (weights 10
// down to 2 over the first nine digits). Only candidates that pass the check are redacted, so a
// ten-digit reference is caught about one time in eleven.
const NHS_CANDIDATE = /(?<![\w-])\d{3}[ -]?\d{3}[ -]?\d{4}(?![\w-])/g;
const isNhsNumber = (candidate: string) => {
  const d = candidate.replace(/\D/g, "");
  const sum = d.slice(0, 9).split("").reduce((acc, ch, i) => acc + Number(ch) * (10 - i), 0);
  const check = 11 - (sum % 11);
  return check !== 10 && (check === 11 ? 0 : check) === Number(d[9]);
};

const redactString = (text: string) =>
  text
    .replace(EMAIL, "[email redacted]")
    .replace(DATE, "[date redacted]")
    .replace(NI_NUMBER, "[NI number redacted]")
    .replace(POSTCODE, "[postcode redacted]")
    .replace(PHONE, "[phone redacted]")
    .replace(NHS_CANDIDATE, (m) => (isNhsNumber(m) ? "[NHS number redacted]" : m));

/**
 * Replace email addresses, dates, UK postcodes, National Insurance and NHS numbers and
 * phone-number-like sequences inside free text (references, messages, instructions, template
 * content, names, Amiqus's own error messages) unless contact details were requested.
 */
export function redactContacts(text: unknown, includeContact: boolean): string | undefined {
  if (typeof text !== "string") return undefined;
  if (text === "") return undefined;
  return includeContact ? text : redactString(text);
}

// Step preferences and check responses are nested objects whose exact shape varies by check type
// (the spec says check responses "are still in beta"). Objects and arrays below this depth are
// replaced by a placeholder rather than returned unredacted.
const MAX_DEPTH = 20;
const TOO_DEEP = `[value nested deeper than ${MAX_DEPTH} levels omitted]`;

/** Apply redactContacts to every string key and value inside an arbitrary JSON value. */
export function redactDeep(value: unknown, includeContact: boolean, depth = 0): unknown {
  if (includeContact) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    return value.map((v) => redactDeep(v, includeContact, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    const out: Rec = {};
    for (const [k, v] of Object.entries(value as Rec)) out[redactString(k)] = redactDeep(v, includeContact, depth + 1);
    return out;
  }
  return value;
}

const str = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : String(v));
const num = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? undefined : n;
};
const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);
const compact = <T extends Rec>(o: T): T => {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

export const WITHHELD = "[withheld: personal or identity-document data; available with include_contact_details]";
export const NEVER = "[attachment: identity-document images and files are never returned by this server; open the check in Amiqus]";

// ---- Check responses ----
// Keys inside a check response that hold files or images (Attachment objects: the document photos,
// the selfie or motion capture, the eVisa PDF). These are never returned, with or without
// include_contact_details; the server never downloads them either.
const NEVER_KEY = /^(media|attachments?|images?|pdf|selfie|video|photo)$/;
// Keys that hold personal or identity-document data. A plain value or an object WITHOUT a `result`
// under such a key is withheld outright. An object WITH a `result` is a verdict about that field
// (the documented breakdown entries such as breakdown.data_comparison.first_name are {result:
// "clear"}) and is kept, but only its verdict parts: `result`, `status` and `type`, plus nested
// `breakdown`, `properties` and `reason` walked the same way; any other sibling (a beta response
// might put the compared value next to the verdict) is withheld, and no free text inside a verdict
// under such a key is returned. The list is written against the documented Photo ID response
// (document_data: first_name, last_name, middle_name, date_of_birth, gender, document_numbers,
// issuing_date, date_of_expiry, mrz_line1-3, nationality, place_of_birth, issuing_state, nfc: the
// same fields plus personal_number and mrz_line_1/2 read from the chip) and the eVisa report (name:
// the person; reference: the .GOV share reference), plus common contact, address and identifier
// spellings (surname, forename, given_names, holder, post_code, street, city, ni, nhs_no,
// personal_number, id_number, certificate_number ...) in case a beta response carries them. Keys are
// compared after splitting camelCase and lower-casing, so dateOfBirth and DocumentNumber match too.
const PII_KEY =
  /(^|_)(names?|first_name|last_name|middle_name|full_name|complete_name|surname|forenames?|given_names?|holder|date_of_birth|dob|birth\w*|gender|sex|nationality|place_of_birth|document_data|document_numbers?|mrz|address|street|city|town|county|post_?code|postal_code|zip|line_?\d|email|phone|mobile|landline|telephone|national_insurance_number|ni_number|ni|nhs\w*|pin_number|pin|share_code|reference|passport|passport_number|licence_number|license_number|issuing_date|issue_date|date_of_expiry|expiry_date|expiry|personal_details|applicant|account_number|sort_code|iban|card_number|personal_number|id_number|certificate_number|identifier|nfc)(_|$)/;
const isPiiKey = (k: string) =>
  PII_KEY.test(
    k
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/[\s-]+/g, "_")
      .toLowerCase(),
  );
// Inside a verdict that sits under a PII-named key: the keys whose string value is kept ...
const VERDICT_VALUE_KEY = new Set(["result", "status", "type"]);
// ... and the keys walked into (nested verdicts and the documented reason object).
const VERDICT_CHILD_KEY = new Set(["breakdown", "properties", "reason"]);

/**
 * Walk a check response: files and images are replaced by NEVER, personal and identity-document
 * values by WITHHELD unless contact details were requested, and every remaining string is redacted.
 * `underPii` is set while inside a verdict object that sits under a PII-named key (see PII_KEY).
 */
export function scrubCheckData(value: unknown, includeContact: boolean, depth = 0, underPii = false): unknown {
  if (typeof value === "string") return includeContact ? value : underPii ? WITHHELD : redactString(value);
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    if (underPii && !includeContact) return WITHHELD;
    return value.map((v) => scrubCheckData(v, includeContact, depth + 1));
  }
  if (isObj(value)) {
    if (depth >= MAX_DEPTH) return TOO_DEEP;
    const out: Rec = {};
    for (const [k, v] of Object.entries(value)) {
      if (NEVER_KEY.test(k)) {
        if (v === null || v === undefined) out[k] = v;
        else out[k] = Array.isArray(v) ? `${NEVER} (${v.length} item${v.length === 1 ? "" : "s"})` : NEVER;
        continue;
      }
      if (includeContact) {
        out[k] = scrubCheckData(v, true, depth + 1);
        continue;
      }
      const pii = isPiiKey(k);
      const verdict = isObj(v) && "result" in v;
      if (pii && !verdict) {
        out[k] = v === null || v === undefined ? v : WITHHELD;
        continue;
      }
      if (underPii) {
        // Inside a verdict under a PII key: its own verdict words, nested verdicts (an entry of its
        // `breakdown` or `properties` is itself {result, ...}), the reason object, numbers (scores) and
        // booleans come through; any other string, array or object is withheld.
        if (VERDICT_VALUE_KEY.has(k) && typeof v === "string") out[k] = redactString(v);
        else if (VERDICT_CHILD_KEY.has(k) || verdict || v === null || v === undefined || typeof v === "number" || typeof v === "boolean") out[k] = scrubCheckData(v, false, depth + 1, true);
        else out[k] = WITHHELD;
        continue;
      }
      out[k] = scrubCheckData(v, false, depth + 1, pii);
    }
    return out;
  }
  return value;
}

// ---- Name ----
// Name {title, other_title, first_name, middle_name, last_name, name, full_name, complete_name}.
// Names are returned by default (minus any email or phone typed into them).
export function name(n: unknown, includeContact: boolean) {
  if (!isObj(n)) return undefined;
  return compact({
    title: str(n.title === "other" ? n.other_title ?? n.title : n.title),
    first_name: redactContacts(n.first_name, includeContact),
    middle_name: redactContacts(n.middle_name, includeContact),
    last_name: redactContacts(n.last_name, includeContact),
    full_name: redactContacts(n.full_name ?? n.name, includeContact),
    complete_name: redactContacts(n.complete_name, includeContact),
  });
}

// ---- Client ----
// Client: email, landline, mobile, dob and national_insurance_number only on request. reference is
// "an external reference or identifier to cross-reference with your system" (business data, text
// redacted); deletion_date is the retention date.
export function client(c: Rec, includeContact: boolean) {
  return compact({
    id: num(c.id),
    status: str(c.status) ?? (c.status === null ? "no decision yet" : undefined),
    name: name(c.name, includeContact),
    reference: redactContacts(c.reference, includeContact),
    is_deletable: bool(c.is_deletable),
    deletion_date: str(c.deletion_date),
    created_at: str(c.created_at),
    updated_at: str(c.updated_at),
    archived_at: str(c.archived_at),
    archived: c.archived_at !== undefined ? c.archived_at !== null : undefined,
    ...(includeContact
      ? { email: str(c.email), landline: str(c.landline), mobile: str(c.mobile), date_of_birth: str(c.dob), national_insurance_number: str(c.national_insurance_number) }
      : {}),
  });
}

// ---- Steps ----
// Step Review {id, reviewed_by (int or TeamMember), status, from_status, message, created_at, updated_at}.
// Metadata.review: null = pending review, false = cannot be reviewed, integer = review ID, object = the review.
function review(r: unknown, includeContact: boolean) {
  if (r === null) return { state: "pending review" };
  if (r === false) return { state: "not reviewable" };
  if (typeof r === "number") return { review_id: r };
  if (!isObj(r)) return undefined;
  return compact({
    review_id: num(r.id),
    status: str(r.status),
    from_status: str(r.from_status),
    reviewed_by_id: typeof r.reviewed_by === "number" ? r.reviewed_by : num(r.reviewed_by?.id),
    message: redactContacts(r.message, includeContact),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
  });
}

// RecordDocument {id, type: requested|sent|returned, name, status: pending|complete, config, source,
// attachments, completed_at}. Attachments (the files) are never returned.
function recordDocument(d: unknown) {
  if (typeof d === "number") return { document_id: d };
  if (!isObj(d)) return undefined;
  return compact({
    document_id: num(d.id),
    type: str(d.type),
    name: redactContacts(d.name, false),
    status: str(d.status),
    instructions: redactContacts(d.config?.instructions, false),
    attachment_count: Array.isArray(d.attachments) ? d.attachments.length : undefined,
    completed_at: str(d.completed_at),
  });
}

// ClientForm (when a form step is expanded): the answers (`fields`) are the client's data and are
// not returned by this server; the reference, name, type and completion are.
function clientForm(f: unknown) {
  if (typeof f === "string") return { form_reference: f };
  if (!isObj(f)) return undefined;
  return compact({
    form_id: num(f.id),
    form_reference: str(f.reference),
    type: str(f.type),
    name: redactContacts(f.name, false),
    completed_at: str(f.completed_at),
    fields: Array.isArray(f.fields) ? `[${f.fields.length} form fields: the client's answers are not returned by this server]` : undefined,
  });
}

/**
 * Record Steps: every variant is Step {id, type} plus type-specific `preferences`, plus for checks
 * `check` (ID or expanded Check), for document steps `document` (ID or RecordDocument), for forms
 * `form` (reference or ClientForm), plus Metadata {review, cost, completed_at}.
 */
export function step(s: Rec, includeContact: boolean) {
  return compact({
    step_id: num(s.id),
    type: str(s.type),
    completed: s.completed_at !== undefined ? s.completed_at !== null : undefined,
    completed_at: str(s.completed_at),
    cost_in_credits: num(s.cost),
    review: "review" in s ? review(s.review, includeContact) : undefined,
    check: "check" in s ? (typeof s.check === "number" ? { check_id: s.check } : isObj(s.check) ? check(s.check, includeContact) : undefined) : undefined,
    document: "document" in s ? recordDocument(s.document) : undefined,
    form: "form" in s ? clientForm(s.form) : undefined,
    // Preferences are what was asked for (report type, accepted documents, DBS level, a document
    // request's title and instructions); the free text in them is redacted.
    preferences: isObj(s.preferences) ? redactDeep(s.preferences, includeContact) : undefined,
  });
}

// ---- Record ----
// Record: email (the contact email snapshot) only on request. perform_url is "the unique URL to
// complete the record steps in a browser": whoever has it can submit identity documents as the
// client, so it is treated like a credential and only returned on request; whether one exists is.
export function record(r: Rec, includeContact: boolean, steps?: Rec[]) {
  const stepList = steps ?? (Array.isArray(r.steps) ? r.steps : undefined);
  return compact({
    id: num(r.id),
    status: str(r.status),
    client_id: typeof r.client === "number" ? r.client : num(r.client?.id),
    client: isObj(r.client) ? client(r.client, includeContact) : undefined,
    name: name(r.name, includeContact),
    reference: redactContacts(r.reference, includeContact),
    perform_url_available: r.perform_url !== undefined ? typeof r.perform_url === "string" : undefined,
    ...(includeContact ? { perform_url: str(r.perform_url), email: str(r.email) } : {}),
    has_reminders: bool(r.has_reminders),
    is_declaration_required: bool(r.is_declaration_required),
    declaration_confirmed_at: str(r.declaration_confirmed_at),
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    expired_at: str(r.expired_at),
    archived_at: str(r.archived_at),
    step_count: stepList ? stepList.length : undefined,
    steps: stepList ? stepList.map((s) => step(s, includeContact)) : undefined,
  });
}

// ---- Check ----
// Check Response: null (none available), true (available when expanded), {object: "check_response.other"}
// (not yet available from the API), or the Photo ID response {object, status, result, reports, media}.
function checkResponse(resp: unknown, includeContact: boolean) {
  if (resp === null || resp === undefined) return { available: false };
  if (resp === true) return { available: true, note: "Call get_check for this check to see the result." };
  if (!isObj(resp)) return undefined;
  if (typeof resp.object === "string" && resp.object !== "check_response.photo_id" && !("reports" in resp)) {
    return { available: true, object: resp.object, note: "The spec says the response for this check type is not yet available from the API." };
  }
  const scrubbed = scrubCheckData(resp, includeContact) as Rec;
  return compact({
    available: true,
    object: str(resp.object),
    status: str(resp.status),
    result: str(resp.result),
    reports: Array.isArray(scrubbed.reports) ? scrubbed.reports : scrubbed.reports === null ? "not yet processed" : undefined,
    media: scrubbed.media,
  });
}

/** Check {id, type, record (ID or Record), status, response, allow_replay, allow_cancel, requires_consent, created_at, updated_at}. */
export function check(c: Rec, includeContact: boolean) {
  return compact({
    check_id: num(c.id),
    type: str(c.type),
    record_id: typeof c.record === "number" ? c.record : num(c.record?.id),
    status: str(c.status),
    allow_replay: bool(c.allow_replay),
    allow_cancel: bool(c.allow_cancel),
    requires_consent: bool(c.requires_consent),
    created_at: str(c.created_at),
    updated_at: str(c.updated_at),
    response: "response" in c ? checkResponse(c.response, includeContact) : undefined,
  });
}

// ---- Templates ----
// Record Template {id, name, description, presets: {steps, notification, message, reminder,
// is_declaration_required, assignees}, is_enabled}. The presets' message is free text.
export function recordTemplate(t: Rec) {
  const p: Rec = isObj(t.presets) ? t.presets : {};
  return compact({
    template_id: num(t.id),
    name: redactContacts(t.name, false),
    description: redactContacts(t.description, false),
    is_enabled: bool(t.is_enabled),
    steps: arr(p.steps).map((s: Rec) =>
      compact({
        type: str(s.type),
        preferences: isObj(s.preferences) ? redactDeep(s.preferences, false) : undefined,
        invalid: s.object === "invalid_preset_step" ? true : undefined,
        errors: s.object === "invalid_preset_step" && isObj(s.errors) ? redactDeep(s.errors, false) : undefined,
      }),
    ),
    notification: p.notification === false ? "none" : str(p.notification),
    message: redactContacts(p.message, false),
    reminder: bool(p.reminder),
    is_declaration_required: bool(p.is_declaration_required),
    assignee_ids: Array.isArray(p.assignees) && p.assignees.length ? p.assignees : undefined,
    created_at: str(t.created_at),
    updated_at: str(t.updated_at),
  });
}

// Email Template and Document Template {id, name, description, content, is_enabled}.
export function textTemplate(t: Rec) {
  return compact({
    template_id: num(t.id),
    name: redactContacts(t.name, false),
    description: redactContacts(t.description, false),
    is_enabled: bool(t.is_enabled),
    content: redactContacts(t.content, false),
    created_at: str(t.created_at),
    updated_at: str(t.updated_at),
  });
}

// ---- Webhooks ----
// Webhook {id, uuid, url, secret, events, is_enabled}. The secret ("shared secret key used to sign
// webhook payloads") is never returned. A delivery URL may carry a token in its query string, so
// only origin and path are returned, with a flag saying a query string was dropped.
export function webhook(w: Rec) {
  let url: string | undefined = str(w.url);
  let hadQuery: boolean | undefined;
  if (url) {
    try {
      const u = new URL(url);
      hadQuery = u.search !== "" || u.username !== "" || u.password !== "";
      url = u.origin + u.pathname;
    } catch {
      url = redactString(url);
    }
  }
  return compact({
    webhook_id: num(w.id),
    uuid: str(w.uuid),
    url,
    url_query_string_removed: hadQuery || undefined,
    events: Array.isArray(w.events) ? w.events.map(String) : undefined,
    is_enabled: bool(w.is_enabled),
    created_at: str(w.created_at),
    updated_at: str(w.updated_at),
  });
}

// ---- Case status aggregate ----
// {object: "case_status_aggregate", aggregates: [{status, count}]}. Case statuses (spec): pending
// (deprecated), awaiting_response, action_required, reviewed_pending_decision, approved, rejected, on_hold.
export function caseStatusAggregate(a: Rec) {
  const rows = arr(a.aggregates).map((x: Rec) => compact({ status: str(x.status), count: num(x.count) }));
  return { counts: rows, total_cases: rows.reduce((sum, r) => sum + (r.count ?? 0), 0) };
}
