// End-to-end test: fixtures are validated against Amiqus's published OpenAPI 3.1 schemas, then the
// built MCP server is driven over stdio by a real MCP client against a local mock of the API.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as fx from "./fixtures.mjs";
import { startMock, ACCESS_TOKEN, AUTH, BASE_PATH, RATE_LIMIT } from "./mock-server.mjs";
import * as fmt from "../dist/format.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const started = Date.now();
let passed = 0;
const check = async (name, fn) => {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// 1. Fixtures match the published spec (so the mock returns what the real API documents).
const SPEC_URL = "https://developers.amiqus.co/aqid/openapi.json";
if (!existsSync(`${root}spec.json`)) {
  try {
    const text = await (await fetch(SPEC_URL, { headers: { Accept: "application/json" } })).text();
    JSON.parse(text); // fail here, not later, if the download was an error page
    writeFileSync(`${root}spec.json`, text);
  } catch (err) {
    console.error(`Could not download the Amiqus spec (${err?.cause?.code ?? err.message}). Save it manually:\n  curl -o spec.json ${SPEC_URL}`);
    process.exit(1);
  }
}
const spec = JSON.parse(readFileSync(`${root}spec.json`, "utf8"));
assert.equal(spec.openapi, "3.1.0", "the Amiqus spec is OpenAPI 3.1");
assert.equal(spec.servers?.[0]?.url, "https://id.amiqus.co/api/v2", "the documented base URL");
// OpenAPI 3.1 schemas are JSON Schema 2020-12. The spec uses a "format: integer" that ajv-formats
// does not know; Ajv's logger is off so that warning does not repeat for every compile.
const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);
ajv.addSchema({ $id: "aq", components: spec.components });
// An inline response schema refers to "#/components/..." relative to the spec document, so its refs
// are pointed at the "aq" schema.
const inline = (schema) => JSON.parse(JSON.stringify(schema).replaceAll('"#/components/', '"aq#/components/'));
const compiled = new Map();
const validateWith = (schema, obj, label) => {
  const key = typeof schema === "string" ? schema : JSON.stringify(schema);
  let v = compiled.get(key);
  if (!v) {
    v = typeof schema === "string" ? ajv.compile({ $ref: `aq#/components/schemas/${schema}` }) : ajv.compile(inline(schema));
    compiled.set(key, v);
  }
  assert.ok(v(obj), `${label}: ${ajv.errorsText(v.errors, { dataVar: "" }).slice(0, 600)}`);
};
const validate = (name, obj, id = "") => validateWith(name, obj, `${name} ${id}`);
// A response may be a $ref into components.responses (the shared 401), so that is resolved first.
const responseSchema = (path, method = "get", status = "200") => {
  const r = spec.paths[path][method].responses[status];
  const resolved = r.$ref ? spec.components.responses[r.$ref.replace("#/components/responses/", "")] : r;
  return resolved.content["application/json"].schema;
};
const validateResponse = (path, obj, method = "get", status = "200") => validateWith(responseSchema(path, method, status), obj, `${method.toUpperCase()} ${path} ${status} response`);

console.log("fixtures vs OpenAPI spec");
await check("clients, records and their steps, checks and responses, step reviews, templates, webhooks, case aggregate", async () => {
  const clientItem = responseSchema("/clients").allOf[1].properties.data.items; // Client + status enum
  fx.clients.forEach((c) => validateWith(clientItem, c, `client ${c.id}`));
  fx.records.forEach((r) => validate("Record", r, r.id));
  fx.records.flatMap((r) => r.steps).forEach((s) => validate("RecordSteps", s, s.id));
  Object.values(fx.checks).forEach((c) => validate("Check-2", c, c.id));
  validate("CheckResponse", fx.PHOTO_ID_RESPONSE, "photo id");
  Object.values(fx.reviews).forEach((r) => validate("StepReview", r, r.id));
  fx.recordTemplates.forEach((t) => validate("RecordTemplate", t, t.id));
  fx.emailTemplates.forEach((t) => validate("EmailTemplate", t, t.id));
  fx.documentTemplates.forEach((t) => validate("DocumentTemplate", t, t.id));
  fx.webhooks.forEach((w) => validate("Webhook", w, w.id));
  validate("ClientCaseStatusAggregate", fx.caseStatusAggregate);
  assert.equal(fx.clients.length, 120, "two full pages of 100 plus a partial page");
  assert.equal(fx.records.length, 113);
  // Negative controls, so a schema that accepted anything would be noticed: Client, Record, PaginatedList
  // and Check set additionalProperties: false, and the status enums are closed.
  const client = ajv.compile({ $ref: "aq#/components/schemas/Client" });
  assert.equal(client({ ...fx.clients[0], id: "seven" }), false, "a string id must be rejected");
  assert.equal(client({ ...fx.clients[0], nickname: "x" }), false, "an undeclared key must be rejected");
  const record = ajv.compile({ $ref: "aq#/components/schemas/Record" });
  assert.equal(record({ ...fx.records[0], status: "done" }), false, "an unknown record status must be rejected");
  const list = ajv.compile({ $ref: "aq#/components/schemas/PaginatedList" });
  assert.equal(list({ object: "paginated_list", data: [], links: { next: null } }), false, "links must carry next and previous");
});

// 2. The mock's responses (lists, single records, errors) match the documented response schemas.
const { server: mock, port, requests, arm, arm429, disarm, setPageCap, setOmitLinks, created } = await startMock();
const base = `http://127.0.0.1:${port}${BASE_PATH}`;
const raw = async (method, path, init = {}) => {
  const res = await fetch(base + path, { method, headers: { Authorization: AUTH, "Content-Type": "application/json", Accept: "application/json" }, ...init });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
};
await check("mock responses match the documented list, detail, created and error schemas, with the documented headers", async () => {
  const keys = (obj, ...names) => names.forEach((k) => assert.ok(k in obj, `response is missing "${k}"`));
  const clients = await raw("GET", "/clients?limit=100");
  validateResponse("/clients", clients.json);
  keys(clients.json, "object", "data", "total", "count", "limit", "current_page", "total_pages", "links");
  assert.deepEqual([clients.json.total, clients.json.count, clients.json.limit, clients.json.current_page, clients.json.total_pages], [120, 100, 100, 1, 2]);
  assert.match(clients.json.links.next, /\/api\/v2\/clients\?limit=100&page=2$/, "links.next carries the current query parameters (pagination guide)");
  assert.equal(clients.json.links.previous, null);
  assert.equal(clients.headers.get("x-ratelimit-limit"), String(RATE_LIMIT), "rate-limits guide: X-RateLimit-Limit on every response");
  assert.ok(Number(clients.headers.get("x-ratelimit-remaining")) < RATE_LIMIT);
  const last = await raw("GET", "/clients?limit=100&page=2");
  assert.deepEqual([last.json.count, last.json.links.next, last.json.current_page], [20, null, 2]);
  const past = await raw("GET", "/clients?limit=100&page=5");
  assert.deepEqual([past.json.count, past.json.links.next], [0, null], "a page past the end is empty");
  assert.match(past.json.links.previous, /page=4$/, "and still links to the page before it");
  assert.equal((await raw("GET", "/clients?limit=100&search=mcfly")).json.links, null, "a single page has links: null");
  assert.equal((await raw("GET", "/clients?limit=101")).status, 422, "limit above the documented maximum of 100");
  validateResponse("/clients/{id}", (await raw("GET", `/clients/${fx.CLIENT_MARTIN}`)).json);
  validateResponse("/clients/{id}/records", (await raw("GET", `/clients/${fx.CLIENT_MARTIN}/records`)).json);
  const records = await raw("GET", "/records?limit=100");
  validateResponse("/records", records.json);
  assert.deepEqual([records.json.total, records.json.total_pages], [113, 2]);
  validateResponse("/records/{id}", (await raw("GET", `/records/${fx.REC_MARTIN_DONE}`)).json);
  const steps = await raw("GET", `/records/${fx.REC_MARTIN_DONE}/steps?expand=check,review`);
  validateResponse("/records/{id}/steps", steps.json);
  assert.equal(steps.json.data[0].check.object, "check", "expand=check embeds the check");
  assert.equal(steps.json.data[0].check.response, true, "an embedded check's response is collapsed to true (no nested expansion, per the guide)");
  assert.equal(steps.json.data[2].review.object, "step_review", "expand=review embeds the latest review");
  const plainSteps = await raw("GET", `/records/${fx.REC_MARTIN_DONE}/steps`);
  assert.equal(plainSteps.json.data[0].check, fx.CHECK_MARTIN_PHOTO, "collapsed: the check ID");
  assert.equal((await raw("GET", `/records/${fx.REC_MARTIN_DONE}/steps?expand=bogus`)).status, 422, "an undocumented expand value is rejected, as in the guide's example");
  for (const id of Object.keys(fx.checks).slice(0, 8)) {
    validateResponse("/checks/{id}", (await raw("GET", `/checks/${id}?expand=response`)).json);
    validateResponse("/checks/{id}", (await raw("GET", `/checks/${id}`)).json);
  }
  assert.equal((await raw("GET", `/checks/${fx.CHECK_MARTIN_PHOTO}`)).json.response, true, "not expanded: response is true when one is available");
  const limited = await raw("GET", "/templates/records"); // the mock answers the first call with a 429
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  validateResponse("/templates/records", (await raw("GET", "/templates/records")).json);
  validateResponse("/templates/emails", (await raw("GET", "/templates/emails")).json);
  validateResponse("/templates/documents", (await raw("GET", "/templates/documents")).json);
  validateResponse("/aggregates/case-status", (await raw("GET", "/aggregates/case-status")).json);
  validateResponse("/webhooks", (await raw("GET", "/webhooks")).json);
  // Errors in the documented shapes.
  const noAuth = await fetch(`${base}/clients`, { headers: { Authorization: "Bearer aq-wrong-token" } });
  assert.equal(noAuth.status, 401);
  validateResponse("/clients", await noAuth.json(), "get", "401");
  const missing = await raw("GET", "/clients/1");
  assert.equal(missing.status, 404);
  validateResponse("/clients/{id}", missing.json, "get", "404");
  assert.equal(missing.json.error, responseSchema("/clients/{id}", "get", "404").properties.error.default, "the spec's default 404 text");
  assert.equal((await raw("GET", "/records/1")).json.error, responseSchema("/records/{id}", "get", "404").properties.error.default);
  assert.equal((await raw("GET", "/checks/1")).json.error, responseSchema("/checks/{id}", "get", "404").properties.error.default);
  // POST /records: the spec's own request examples are accepted and answered with a Record (201).
  const rb = spec.paths["/records"].post.requestBody.content["application/json"];
  for (const [name, ex] of Object.entries(rb.examples)) {
    const body = { ...ex.value, client: fx.CLIENT_MARTIN, ...(ex.value.template !== undefined ? { template: fx.TEMPLATE_IDV } : {}) };
    const res = await raw("POST", "/records", { body: JSON.stringify(body) });
    assert.equal(res.status, 201, `example ${name}: ${JSON.stringify(res.json)}`);
    validateResponse("/records", res.json, "post", "201");
  }
  const bad = await raw("POST", "/records", { body: JSON.stringify({ client: fx.CLIENT_MARTIN, steps: [{ type: "check.photo_id" }] }) });
  assert.equal(bad.status, 422);
  validateResponse("/records", bad.json, "post", "422");
});
requests.length = 0; // only count what the MCP server does from here on
created.length = 0; // and forget the records the schema check posted
arm429();

// 3. Drive the server through MCP. `writes` is the literal AMIQUS_ALLOW_WRITES value; null leaves it unset.
const connect = async (token, writes = "true") => {
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, AMIQUS_ACCESS_TOKEN: token, AMIQUS_BASE_URL: base };
  delete env.AMIQUS_ALLOW_WRITES;
  if (writes !== null) env.AMIQUS_ALLOW_WRITES = writes;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" }));
  return client;
};
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { res, data: res.isError ? undefined : JSON.parse(res.content[0].text), text: res.content[0].text };
};
const since = (n) => requests.slice(n);
const READ_TOOLS = ["case_status_summary", "get_check", "get_client", "get_record", "list_client_records", "list_clients", "list_records", "list_templates", "list_webhooks"];

const client = await connect(ACCESS_TOKEN);
console.log("mcp tools");

await check("tools/list exposes 10 tools; the nine reads are read-only, create_record is a non-destructive write", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...READ_TOOLS, "create_record"].sort());
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, t.name !== "create_record", `${t.name} readOnlyHint`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} destructiveHint`);
    assert.equal(t.annotations?.idempotentHint, t.name !== "create_record", `${t.name} idempotentHint`);
  }
});

await check("list_clients pages by page/limit (1, 2) and stops when links.next is null", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_clients", { max_results: 500 });
  assert.deepEqual([data.count, data.total, data.total_pages, data.complete, data.page_size], [120, 120, 2, true, 100]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page, r.query.limit]), [["/clients", "1", "100"], ["/clients", "2", "100"]], "two pages of 100, no third call once links.next is null");
  assert.ok(since(n)[1].t - since(n)[0].t >= 150, `requests are throttled (250 ms slots; the first request also pays for the connection, so the gap seen by the mock may be a little under 250 ms; without the throttle it would be a few ms) (measured ${since(n)[1].t - since(n)[0].t} ms)`);
  const martin = data.clients.find((c) => c.id === fx.CLIENT_MARTIN);
  assert.deepEqual(martin.name, { title: "mr", first_name: "Martin", middle_name: "Seamus", last_name: "McFly", full_name: "Martin Seamus McFly", complete_name: "Mr Martin Seamus McFly" });
  assert.deepEqual([martin.status, martin.reference, martin.deletion_date, martin.archived], ["pending", "MCFLY-1955", "2027-01-14", false]);
  for (const k of ["email", "mobile", "landline", "date_of_birth", "national_insurance_number"]) assert.equal(martin[k], undefined, `${k} only on request`);
  assert.equal(data.clients.find((c) => c.id === fx.CLIENT_JEN).status, "no decision yet", "a null status is spelled out");
  assert.equal(data.clients.find((c) => c.id === fx.CLIENT_DOC).archived, true);
  const text = JSON.stringify(data);
  assert.ok(!text.includes("@example."), "no email address anywhere in the default output");
  assert.ok(!text.includes("07700") && !text.includes("QQ123456C") && !text.includes("1968-06-12"), "no phone, NI number or date of birth in the default output");
});

await check("list_clients honours max_results in whole pages and reports how to continue", async () => {
  const { data } = await call(client, "list_clients", { max_results: 110 });
  assert.deepEqual([data.count, data.complete, data.next_page], [100, false, 2], "page 2 holds 20 (total 120), and 100 + 20 > 110, so one page and a next_page");
  assert.match(data.note, /page 2 and the same max_results \(110\)/);
  const next = await call(client, "list_clients", { max_results: 110, page: 2 });
  assert.deepEqual([next.data.count, next.data.complete, requests.at(-1).query.page], [20, true, "2"]);
  const small = await call(client, "list_clients", { max_results: 10 });
  assert.deepEqual([small.data.count, small.data.page_size, requests.at(-1).query.limit, small.data.complete, small.data.next_page], [10, 10, "10", false, 2]);
  let n = requests.length;
  const exact = await call(client, "list_clients", { max_results: 120 });
  assert.deepEqual([exact.data.count, exact.data.complete, since(n).map((r) => r.query.page)], [120, true, ["1", "2"]], "max_results equal to the total fetches the short last page (its size is known from total)");
  n = requests.length;
  const roomy = await call(client, "list_clients", { max_results: 150 });
  assert.deepEqual([roomy.data.count, roomy.data.complete, since(n).map((r) => r.query.page)], [120, true, ["1", "2"]], "150 leaves room for the 20-item last page");
  n = requests.length;
  const records = await call(client, "list_records", { max_results: 113 });
  assert.deepEqual([records.data.count, records.data.complete, since(n).length], [113, true, 2]);
});

await check("list_clients passes search, status, visibility, assignee, reference, deletion_date, sort_by and order_by through as documented", async () => {
  const q = () => requests.at(-1).query;
  const search = await call(client, "list_clients", { search: "  McFly " });
  assert.deepEqual(search.data.clients.map((c) => c.id), [fx.CLIENT_MARTIN]);
  assert.deepEqual(q(), { search: "McFly", page: "1", limit: "100" }, "trimmed search, nothing else sent");
  const status = await call(client, "list_clients", { status: "rejected" });
  assert.deepEqual([status.data.clients.map((c) => c.id), q().status], [[fx.CLIENT_BIFF], "rejected"]);
  const archived = await call(client, "list_clients", { visibility: "archived" });
  assert.deepEqual([archived.data.clients.map((c) => c.id), q().visibility], [[fx.CLIENT_DOC], "archived"]);
  const assignee = await call(client, "list_clients", { assignee: fx.USER_JO });
  assert.deepEqual([assignee.data.clients.map((c) => c.id), q().assignee], [[fx.CLIENT_JEN], String(fx.USER_JO)]);
  const reference = await call(client, "list_clients", { reference: "brown-1985" });
  assert.deepEqual([reference.data.clients.map((c) => c.id), q().reference], [[fx.CLIENT_DOC], "brown-1985"]);
  const overdue = await call(client, "list_clients", { deletion_date: "overdue" });
  assert.deepEqual([overdue.data.clients.map((c) => c.id), q().deletion_date], [[fx.CLIENT_JEN], "overdue"]);
  const sorted = await call(client, "list_clients", { sort_by: "name.last_name", order_by: "desc", max_results: 3 });
  assert.deepEqual([q().sort_by, q().order_by], ["name.last_name", "desc"]);
  assert.deepEqual(sorted.data.clients.map((c) => c.name.last_name), ["Tannen", "Surname99", "Surname98"]);
  const combined = await call(client, "list_clients", { search: "person", status: "approved", visibility: "active", sort_by: "created_at", order_by: "asc", max_results: 100 });
  assert.equal(combined.data.count, 39);
  assert.deepEqual(q(), { search: "person", status: "approved", visibility: "active", sort_by: "created_at", order_by: "asc", page: "1", limit: "100" });
});

await check("get_client hides contact details, date of birth and NI number by default, redacts an email typed into the reference, and returns them on request", async () => {
  const { data } = await call(client, "get_client", { client_id: fx.CLIENT_JEN });
  assert.equal(requests.at(-1).path, `/clients/${fx.CLIENT_JEN}`);
  assert.equal(data.client.reference, "contact [email redacted]");
  assert.equal(data.client.email, undefined);
  assert.equal(data.client.date_of_birth, undefined);
  const full = await call(client, "get_client", { client_id: fx.CLIENT_MARTIN, include_contact_details: true });
  assert.deepEqual(
    [full.data.client.email, full.data.client.mobile, full.data.client.landline, full.data.client.date_of_birth, full.data.client.national_insurance_number],
    ["marty@example.com", "07700 900123", undefined, "1968-06-12", "QQ123456C"],
  );
  const jen = await call(client, "get_client", { client_id: fx.CLIENT_JEN, include_contact_details: true });
  assert.equal(jen.data.client.reference, "contact jennifer@example.com");
  const doc = await call(client, "get_client", { client_id: fx.CLIENT_DOC, include_contact_details: true });
  assert.equal(doc.data.client.landline, "0131 496 0000");
});

await check("list_records pages across 113 records and passes status, visibility, created_by, assignee (ID or false), client_visibility, sort_by and order_by through", async () => {
  const q = () => requests.at(-1).query;
  const n = requests.length;
  const all = await call(client, "list_records", { max_results: 500 });
  assert.deepEqual([all.data.count, all.data.total, all.data.complete], [113, 113, true]);
  assert.deepEqual(since(n).map((r) => [r.path, r.query.page]), [["/records", "1"], ["/records", "2"]]);
  const byCreated = [...fx.records].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id));
  assert.equal(all.data.records[0].id, byCreated[0].id, "created_at order, as the spec documents for the default");
  const status = await call(client, "list_records", { status: "waiting" });
  assert.deepEqual([status.data.records.map((r) => r.id), q().status], [[fx.REC_JEN], "waiting"]);
  const archived = await call(client, "list_records", { visibility: "archived" });
  assert.deepEqual([archived.data.records.map((r) => r.id), q().visibility], [[fx.REC_DOC], "archived"]);
  const creator = await call(client, "list_records", { created_by: fx.USER_ALEX });
  assert.deepEqual([creator.data.records.map((r) => r.id).sort(), q().created_by, q().creator], [[fx.REC_MARTIN, fx.REC_MARTIN_DONE].sort(), String(fx.USER_ALEX), undefined], "created_by, not the deprecated creator");
  const assigned = await call(client, "list_records", { assignee: fx.USER_JO });
  assert.deepEqual([assigned.data.records.map((r) => r.id), q().assignee], [[fx.REC_JEN], String(fx.USER_JO)]);
  const unassigned = await call(client, "list_records", { assignee: false, max_results: 500 });
  assert.equal(q().assignee, "false", "unassigned records are asked for with assignee=false, as documented");
  assert.ok(unassigned.data.records.some((r) => r.id === fx.REC_MARTIN_DONE) && !unassigned.data.records.some((r) => r.id === fx.REC_MARTIN));
  const cv = await call(client, "list_records", { client_visibility: "archived" });
  assert.deepEqual([cv.data.records.map((r) => r.id), q().client_visibility], [[fx.REC_DOC], "archived"]);
  const sorted = await call(client, "list_records", { sort_by: "client.name.last_name", order_by: "desc", max_results: 2 });
  assert.deepEqual([q().sort_by, q().order_by, sorted.data.records.map((r) => r.name.last_name)], ["client.name.last_name", "desc", ["Surname99", "Surname98"]]);
  const rec = all.data.records.find((r) => r.id === fx.REC_MARTIN);
  assert.deepEqual([rec.client_id, rec.status, rec.step_count, rec.perform_url_available, rec.perform_url, rec.email], [fx.CLIENT_MARTIN, "pending", 3, true, undefined, undefined]);
});

await check("list_client_records lists a client's records with steps; the contact email, perform URL and free text in preferences are redacted by default and returned on request", async () => {
  const { data } = await call(client, "list_client_records", { client_id: fx.CLIENT_MARTIN });
  assert.equal(requests.at(-1).path, `/clients/${fx.CLIENT_MARTIN}/records`);
  assert.deepEqual(data.records.map((r) => [r.id, r.status]).sort(), [[fx.REC_MARTIN, "pending"], [fx.REC_MARTIN_DONE, "complete"]].sort());
  const pending = data.records.find((r) => r.id === fx.REC_MARTIN);
  assert.deepEqual(pending.steps.map((s) => [s.step_id, s.type, s.completed]), [[2, "check.photo_id", false], [3, "document.request", false], [4, "form", false]]);
  assert.deepEqual(pending.steps[0].check, { check_id: fx.CHECK_MARTIN_PENDING });
  assert.deepEqual(pending.steps[0].review, { state: "pending review" });
  assert.deepEqual(pending.steps[1].review, { state: "not reviewable" });
  assert.equal(pending.steps[1].preferences.instructions, "A utility bill dated within the last three months. Questions: [phone redacted].");
  assert.deepEqual(pending.steps[1].document, { document_id: 23123 });
  assert.deepEqual(pending.steps[2].form, { form_reference: "4bd9bfca-e61d-4a68-99b3-ca61a02f650f" });
  assert.deepEqual(pending.steps[0].preferences.docs, ["passport", "driving_licence", "national_id"]);
  const done = data.records.find((r) => r.id === fx.REC_MARTIN_DONE);
  assert.equal(done.perform_url_available, false, "perform_url false means no step can be submitted");
  const text = JSON.stringify(data);
  assert.ok(!text.includes("test-perform") && !text.includes("@example.") && !text.includes("0117 496"), "perform URL, email and phone leaked in the default output");
  const full = await call(client, "list_client_records", { client_id: fx.CLIENT_MARTIN, include_contact_details: true });
  const pendingFull = full.data.records.find((r) => r.id === fx.REC_MARTIN);
  assert.deepEqual([pendingFull.email, pendingFull.perform_url], ["marty@example.com", `https://id.amiqus.co/i/test-perform-${fx.REC_MARTIN}`]);
  assert.match(pendingFull.steps[1].preferences.instructions, /0117 496 0000/);
});

await check("get_record fetches the record and its steps with expand=check,review, showing each check's status and the latest review", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_record", { record_id: fx.REC_MARTIN_DONE });
  assert.deepEqual(since(n).map((r) => [r.path, r.query]), [
    [`/records/${fx.REC_MARTIN_DONE}`, {}],
    [`/records/${fx.REC_MARTIN_DONE}/steps`, { expand: "check,review", page: "1", limit: "100" }],
  ], "expand is sent comma-separated, as the expandable-properties guide shows");
  const r = data.record;
  assert.deepEqual([r.id, r.status, r.client_id, r.step_count], [fx.REC_MARTIN_DONE, "complete", fx.CLIENT_MARTIN, 3]);
  assert.deepEqual(r.steps.map((s) => [s.type, s.completed, s.check.check_id, s.check.status]), [
    ["check.photo_id", true, fx.CHECK_MARTIN_PHOTO, "refer"],
    ["check.watchlist", true, fx.CHECK_MARTIN_WATCHLIST, "accepted"],
    ["check.criminal_record", true, fx.CHECK_MARTIN_DBS, "submitted"],
  ]);
  assert.deepEqual(r.steps[0].check.response, { available: true, note: "Call get_check for this check to see the result." });
  assert.deepEqual(r.steps[2].check.response, { available: false });
  assert.deepEqual(r.steps[2].review, { review_id: fx.REVIEW_DBS, status: "approved", from_status: "pending", reviewed_by_id: fx.USER_ALEX, message: "Checked against the register; call me on [phone redacted] if unsure.", created_at: "2026-08-22T09:00:00Z", updated_at: "2026-08-22T09:00:00Z" });
  assert.deepEqual(r.steps[0].review, { state: "pending review" });
  assert.equal(r.steps[0].cost_in_credits, 1);
  assert.equal(r.steps[2].cost_in_credits, 16);
  const m = requests.length;
  const plain = await call(client, "get_record", { record_id: fx.REC_MARTIN_DONE, include_step_details: false, include_contact_details: true });
  assert.equal(since(m).length, 1, "no steps call without step details");
  assert.deepEqual(plain.data.record.steps[0].check, { check_id: fx.CHECK_MARTIN_PHOTO });
  assert.deepEqual(plain.data.record.steps[2].review, { review_id: fx.REVIEW_DBS });
  assert.equal(plain.data.record.email, "marty@example.com");
});

await check("get_check expands the response and keeps the verification breakdown while withholding document data, the eVisa name and reference, and never the images", async () => {
  const n = requests.length;
  const { data } = await call(client, "get_check", { check_id: fx.CHECK_MARTIN_PHOTO });
  assert.deepEqual(since(n).map((r) => [r.path, r.query]), [[`/checks/${fx.CHECK_MARTIN_PHOTO}`, { expand: "response" }]]);
  const c = data.check;
  assert.deepEqual([c.check_id, c.type, c.record_id, c.status, c.allow_cancel], [fx.CHECK_MARTIN_PHOTO, "photo_id", fx.REC_MARTIN_DONE, "refer", true]);
  assert.deepEqual([c.response.available, c.response.object, c.response.status, c.response.result], [true, "check_response.photo_id", "complete", "consider"]);
  const [doc, face, evisa] = c.response.reports;
  assert.deepEqual([doc.type, doc.status, doc.result], ["document", "complete", "consider"]);
  assert.equal(doc.breakdown.data_validation.result, "consider");
  assert.equal(doc.breakdown.data_validation.breakdown.mrz.result, "consider", "a verdict keyed by a field name is kept");
  assert.equal(doc.breakdown.data_comparison.breakdown.first_name.result, "clear");
  assert.equal(doc.breakdown.data_consistency.breakdown.document_numbers.result, "clear");
  assert.equal(doc.breakdown.image_integrity.breakdown.image_quality.properties.glare_on_photo.result, "clear");
  assert.equal(doc.document_data, "[withheld: personal or identity-document data; available with include_contact_details]", "the data read from the document is withheld");
  assert.equal(face.breakdown.face_comparison.breakdown.face_match.properties.score, 0.91, "scores are kept");
  assert.deepEqual([evisa.type, evisa.result, evisa.report_type], ["evisa", "consider", "right_to_work"]);
  assert.equal(evisa.report.name, "[withheld: personal or identity-document data; available with include_contact_details]");
  assert.equal(evisa.report.reference, "[withheld: personal or identity-document data; available with include_contact_details]");
  assert.deepEqual(evisa.report.conditions.primary, ["Work is permitted only for the sponsor named on the visa; queries to [email redacted]"]);
  assert.equal(evisa.report.starts_at, "[date redacted]", "a bare date in a check response (visa start) is redacted by default");
  assert.equal(evisa.report.expires_at, null);
  assert.equal(evisa.breakdown.name_match.result, "clear");
  assert.match(evisa.attachments, /^\[attachment: identity-document images and files are never returned/);
  assert.match(c.response.media, /never returned by this server.*\(1 item\)/);
  const text = JSON.stringify(data);
  for (const leak of ["MCFLY", "MARTIN", "000000000", "P<GBR", "1968-06-12", "HILL VALLEY", "A0B0CD00E", "passport.jpg", "evisa_selfie", "evisa_report.pdf", "31785", "31788", "31789", "@example."]) assert.ok(!text.includes(leak), `${leak} leaked in the default output`);
  const full = await call(client, "get_check", { check_id: fx.CHECK_MARTIN_PHOTO, include_contact_details: true });
  const [docFull, , evisaFull] = full.data.check.response.reports;
  assert.deepEqual(docFull.document_data.document_numbers, [{ type: "document_number", value: "000000000" }]);
  assert.equal(docFull.document_data.mrz_line2, fx.PHOTO_ID_RESPONSE.reports[0].document_data.mrz_line2);
  assert.deepEqual([evisaFull.report.name, evisaFull.report.reference, evisaFull.report.starts_at], ["Martin McFly", "A0B0CD00E", "2023-01-28"]);
  assert.match(evisaFull.report.conditions.primary[0], /sponsor@example.com/);
  const fullText = JSON.stringify(full.data);
  for (const leak of ["passport.jpg", "evisa_selfie", "evisa_report.pdf", "31785", "31788", "31789", "image/jpeg"]) assert.ok(!fullText.includes(leak), `${leak}: an image or file must never be returned, even on request`);
  assert.match(full.data.check.response.media, /never returned/);
});

await check("get_check reports a pending check, a 'not yet available' response type, and a submitted check with no response", async () => {
  const pending = await call(client, "get_check", { check_id: fx.CHECK_MARTIN_PENDING });
  assert.deepEqual([pending.data.check.status, pending.data.check.response], ["pending", { available: false }]);
  const other = await call(client, "get_check", { check_id: fx.CHECK_MARTIN_WATCHLIST });
  assert.deepEqual(other.data.check.response, { available: true, object: "check_response.other", note: "The spec says the response for this check type is not yet available from the API." });
  const dbs = await call(client, "get_check", { check_id: fx.CHECK_MARTIN_DBS });
  assert.deepEqual([dbs.data.check.type, dbs.data.check.status, dbs.data.check.allow_cancel, dbs.data.check.response], ["criminal_record", "submitted", false, { available: false }]);
});

await check("list_templates (after a 429 retry that waits for Retry-After) lists record, email and document templates with text redacted and the enabled filter passed through", async () => {
  const n = requests.length;
  const { data } = await call(client, "list_templates");
  const tries = since(n).filter((r) => r.path === "/templates/records");
  assert.equal(tries.length, 2, "templates should be retried once after 429");
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1000 && gap < 1900, `retry should wait the Retry-After of 1 s, not the 2 s fallback (waited ${gap} ms)`);
  assert.deepEqual([data.kind, data.count, data.complete], ["records", 2, true]);
  const [idv, staff] = data.templates;
  assert.deepEqual([idv.template_id, idv.name, idv.is_enabled, idv.notification, idv.reminder], [fx.TEMPLATE_IDV, "Identity verification", true, "email", true]);
  assert.equal(idv.message, "Please complete these steps to begin onboarding. Questions to [email redacted].");
  assert.deepEqual(idv.steps.map((s) => s.type), ["check.photo_id", "document.request"]);
  assert.deepEqual(idv.steps[1].preferences, { template: 78432 });
  assert.deepEqual([staff.notification, staff.assignee_ids, staff.is_declaration_required], ["none", [fx.USER_ALEX, fx.USER_JO], true]);
  assert.deepEqual(staff.steps[2], { type: "check.watchlist", preferences: { silent: true }, invalid: true, errors: { type: ["Step type check.watchlist is not available for this team"] } }, "an invalid preset step is flagged with the spec's errors map");
  const enabled = await call(client, "list_templates", { enabled: true });
  assert.deepEqual([enabled.data.templates.map((t) => t.template_id), requests.at(-1).query.enabled], [[fx.TEMPLATE_IDV], "true"]);
  const emails = await call(client, "list_templates", { kind: "emails" });
  assert.equal(requests.at(-1).path, "/templates/emails");
  assert.equal(emails.data.templates[0].content, "Hello, please complete your checks. Call us on [phone redacted] with any questions.");
  const docs = await call(client, "list_templates", { kind: "documents", enabled: false });
  assert.deepEqual([requests.at(-1).path, requests.at(-1).query.enabled, docs.data.templates.map((t) => t.name)], ["/templates/documents", "false", ["Old terms"]]);
  const docsAll = await call(client, "list_templates", { kind: "documents" });
  assert.match(docsAll.data.templates[0].content, /Contact \[email redacted\] to negotiate/);
});

await check("case_status_summary sums the aggregate and passes assigned_to (ID or false), start_date, end_date and visibility through as documented", async () => {
  const { data } = await call(client, "case_status_summary");
  assert.deepEqual(requests.at(-1), { ...requests.at(-1), path: "/aggregates/case-status", query: {} });
  assert.equal(data.total_cases, 83);
  assert.deepEqual(data.counts.find((c) => c.status === "approved"), { status: "approved", count: 59 });
  await call(client, "case_status_summary", { assigned_to: false, start_date: "2026-08-01", end_date: "2026-08-31", visibility: "active" });
  assert.deepEqual(requests.at(-1).query, { assigned_to: "false", start_date: "2026-08-01T00:00:00Z", end_date: "2026-08-31T23:59:59Z", visibility: "active" }, "dates are completed to the documented date-time format");
  await call(client, "case_status_summary", { assigned_to: fx.USER_ALEX, start_date: "2026-08-01T09:30:00Z" });
  assert.deepEqual(requests.at(-1).query, { assigned_to: String(fx.USER_ALEX), start_date: "2026-08-01T09:30:00Z" });
  for (const [given, sent] of [
    ["2026-09-01T09:00", "2026-09-01T09:00:00Z"],
    ["2026-09-01T09:00:00", "2026-09-01T09:00:00Z"],
    ["2026-09-01T09:00Z", "2026-09-01T09:00:00Z"],
    ["2026-09-01T09:00:00+01:00", "2026-09-01T08:00:00Z"],
    ["2026-09-01T23:30:00-02:00", "2026-09-02T01:30:00Z"],
    ["2026-09-01T09:00:00.1234567Z", "2026-09-01T09:00:00Z"],
    ["2026-09-01T09:00:00.5+01:00", "2026-09-01T08:00:00Z"],
  ]) {
    await call(client, "case_status_summary", { start_date: given, end_date: given });
    assert.deepEqual([requests.at(-1).query.start_date, requests.at(-1).query.end_date], [sent, sent], `${given} must be sent as ${sent} (data-formats guide: YYYY-MM-DDTHH:MM:SSZ)`);
  }
  const n = requests.length;
  for (const [bad, message] of [
    ["2026-02-30", "Not a real calendar date"],
    ["2026-13-01", "Not a real calendar date"],
    ["2026-00-10", "Not a real calendar date"],
    ["2026-09-01T25:00:00Z", "Not a valid time of day"],
    ["2026-09-01T09:60:00Z", "Not a valid time of day"],
    ["2026-09-01T09:00:60Z", "Not a valid time of day"],
    ["2026-09-01 09:00:00", "Use an ISO 8601 date or date-time"],
    ["01/09/2026", "Use an ISO 8601 date or date-time"],
    ["2026-09-01T09:00:00+0100", "Use an ISO 8601 date or date-time"],
  ]) {
    const res = await client.callTool({ name: "case_status_summary", arguments: { start_date: bad } });
    assert.ok(res.isError, `${bad} must be refused locally`);
    assert.ok(res.content[0].text.includes(message), `${bad}: expected "${message}", got: ${res.content[0].text}`);
    assert.ok(!res.content[0].text.includes("Invalid time value"), `${bad}: a thrown RangeError leaked instead of the validation message`);
  }
  assert.equal(requests.length, n, "no request for a refused date");
});

await check("list_webhooks never returns the signing secret, strips query strings from delivery URLs, and passes the enabled filter through", async () => {
  const { data } = await call(client, "list_webhooks");
  assert.equal(requests.at(-1).path, "/webhooks");
  assert.deepEqual(data.webhooks.map((w) => [w.webhook_id, w.url, w.url_query_string_removed, w.events, w.is_enabled]), [
    [2154, "https://example.org/incoming/webhooks/amiqus", true, ["client.*", "record.*"], true],
    [2159, "https://beta.example.org/webhooks/incoming", undefined, ["*"], false],
  ]);
  const text = JSON.stringify(data);
  assert.ok(!text.includes(fx.WEBHOOK_SECRET_1) && !text.includes(fx.WEBHOOK_SECRET_2) && !text.includes("secret"), "webhook secret leaked");
  assert.ok(!text.includes(fx.WEBHOOK_TOKEN), "query-string token leaked");
  const enabled = await call(client, "list_webhooks", { enabled: true });
  assert.deepEqual([enabled.data.webhooks.map((w) => w.webhook_id), requests.at(-1).query.enabled], [[2154], "true"]);
});

const rb = spec.paths["/records"].post.requestBody.content["application/json"];
const manualBranch = rb.schema.oneOf.find((s) => s.title === "Manual");
const templateBranch = rb.schema.oneOf.find((s) => s.title === "Template");
const advancedSteps = rb.examples.advanced.value.steps; // the spec's documented multi-step example

await check("create_record posts bodies that validate against the spec's Template and Manual request schemas", async () => {
  const n = requests.length;
  const fromTemplate = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: fx.TEMPLATE_IDV, template_assignees: false });
  assert.ok(!fromTemplate.res.isError, fromTemplate.text);
  assert.deepEqual(since(n).map((r) => [r.method, r.path, r.contentType]), [["POST", "/records", "application/json"]]);
  const post = requests.at(-1);
  validateWith(rb.schema, post.body, "POST /records body vs requestBody schema (oneOf)");
  validateWith(templateBranch, post.body, "POST /records body vs Template branch");
  assert.deepEqual(post.body, { client: fx.CLIENT_MARTIN, template: fx.TEMPLATE_IDV, assignees: false });
  assert.deepEqual([fromTemplate.data.result, fromTemplate.data.record.status, fromTemplate.data.record.client_id, fromTemplate.data.record.steps.map((s) => s.type)], ["created", "pending", fx.CLIENT_MARTIN, ["check.photo_id", "document.request"]]);
  assert.equal(fromTemplate.data.record.email, undefined, "the created record's contact email is not echoed");
  assert.equal(fromTemplate.data.record.perform_url, undefined);
  const manual = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, steps: advancedSteps, notification: "email", message: "Please complete the following request.", reminder: true, is_declaration_required: false });
  assert.ok(!manual.res.isError, manual.text);
  const body = requests.at(-1).body;
  validateWith(rb.schema, body, "POST /records manual body vs requestBody schema (oneOf)");
  validateWith(manualBranch, body, "POST /records manual body vs Manual branch");
  assert.deepEqual(body, { client: fx.CLIENT_MARTIN, steps: advancedSteps, notification: "email", message: "Please complete the following request.", reminder: true, is_declaration_required: false });
  assert.deepEqual(manual.data.record.steps.map((s) => s.type), advancedSteps.map((s) => s.type));
  const silent = await call(client, "create_record", { client_id: fx.CLIENT_JEN, steps: [{ type: "check.photo_id", preferences: { report_type: "biometric" } }], notification: false });
  assert.ok(!silent.res.isError, silent.text);
  assert.equal(requests.at(-1).body.notification, false);
  validateWith(manualBranch, requests.at(-1).body, "POST /records silent body vs Manual branch");
});

await check("create_record refuses mixed or incomplete requests locally and passes the API's 422 field errors on", async () => {
  const n = requests.length;
  const both = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: fx.TEMPLATE_IDV, steps: advancedSteps, notification: "email" });
  assert.match(both.text, /Not created\. Give either template_id or steps, not both\./);
  const neither = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN });
  assert.match(neither.text, /Not created\. Give template_id .* or steps/);
  const mixed = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: fx.TEMPLATE_IDV, notification: "email", reminder: true });
  assert.match(mixed.text, /notification, reminder cannot be set when creating from a template/);
  const noNotification = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, steps: advancedSteps });
  assert.match(noNotification.text, /notification is required when creating from steps/);
  assert.equal(since(n).length, 0, "no request for a refused create");
  const unknownTemplate = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: 1 });
  assert.ok(unknownTemplate.res.isError);
  assert.match(unknownTemplate.text, /rejected POST \/records as invalid \(422\)\. template: The selected template is invalid\./);
  const badStep = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, steps: [{ type: "check.bogus" }], notification: false });
  assert.match(badStep.text, /\(422\)\. steps\.0\.type: The selected type is invalid\./);
});

await check("bad IDs are rejected before any API call; unknown IDs give a clear 404", async () => {
  const before = requests.length;
  for (const [tool, args] of [
    ["get_client", { client_id: 0 }],
    ["get_client", { client_id: -5 }],
    ["get_client", { client_id: "73845" }],
    ["get_record", { record_id: 1.5 }],
    ["get_check", { check_id: "../records" }],
    ["list_client_records", { client_id: "abc" }],
    ["list_clients", { assignee: 0 }],
    ["list_records", { assignee: true }],
    ["create_record", { client_id: "x", template_id: 1 }],
  ]) {
    const bad = await client.callTool({ name: tool, arguments: args });
    assert.ok(bad.isError, `${tool} should reject ${JSON.stringify(args)}`);
  }
  assert.equal(requests.length, before, "no request for invalid IDs");
  const missing = await call(client, "get_client", { client_id: 1 });
  assert.match(missing.text, /^Not found: \/clients\/1\. Check the ID\. Client not found$/);
  assert.match((await call(client, "get_record", { record_id: 1 })).text, /^Not found: \/records\/1\. Check the ID\. Record not found$/);
  assert.match((await call(client, "get_check", { check_id: 1 })).text, /^Not found: \/checks\/1\. Check the ID\. Check not found$/);
  assert.match((await call(client, "list_client_records", { client_id: 1 })).text, /^Not found: \/clients\/1\/records\. Check the ID\. Client not found$/);
});

await check("a persistent 429 gives up after 3 attempts with the documented limit and Retry-After in the message", async () => {
  arm429({ persistent: true, retryAfter: "0" });
  const n = requests.length;
  const { res, text } = await call(client, "list_templates");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/templates/records").length, 3, "exactly three attempts");
  assert.match(text, /^Amiqus rate limit reached \(429\)\. The limit reported by Amiqus is 200 requests \(X-RateLimit-Limit\), shared by every token of this user on this team\. Amiqus says to retry after 0 seconds\. Wait and try again\.$/);
  disarm();
});

await check("a Retry-After longer than the cap makes the call give up at once, naming the wait", async () => {
  arm429({ retryAfter: "600" });
  const n = requests.length;
  const { res, text } = await call(client, "list_templates");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/templates/records").length, 1, "no retry when the server asks for a wait longer than the cap");
  assert.match(text, /asked to wait 600 seconds before retrying GET \/templates\/records \(HTTP 429\)/);
  disarm();
});

await check("an HTTP-date Retry-After is honoured", async () => {
  // HTTP-dates have 1 s resolution, so aim at a whole second 4 to 5 s ahead: after the first request's
  // round trip the wait is 3.5 to 5 s, clearly apart from both "retry at once" and the 2 s fallback.
  arm429({ retryAfter: new Date(Math.ceil((Date.now() + 4000) / 1000) * 1000).toUTCString() });
  const n = requests.length;
  const { res } = await call(client, "list_templates");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/templates/records");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 3000 && gap < 5600, `retry should wait until the given date (3.5 to 5 s), not retry at once or use the 2 s fallback (waited ${gap} ms)`);
  disarm();
});

await check("a fractional Retry-After is read as seconds, not as a date", async () => {
  arm429({ retryAfter: "1.5" }); // Date.parse("1.5") is a date in 2001, which would mean "retry now"
  const n = requests.length;
  const { res } = await call(client, "list_templates");
  assert.ok(!res.isError);
  const tries = since(n).filter((r) => r.path === "/templates/records");
  assert.equal(tries.length, 2);
  const gap = tries[1].t - tries[0].t;
  assert.ok(gap >= 1400 && gap < 1900, `retry should wait 1.5 s (waited ${gap} ms)`);
  disarm();
});

await check("a GET that keeps failing with 503 gives up after three attempts with advice and without the gateway's HTML", async () => {
  arm({ method: "GET", path: "/webhooks", status: 503, times: 3, headers: { "Retry-After": "0" } });
  const n = requests.length;
  const { res, text } = await call(client, "list_webhooks");
  assert.ok(res.isError);
  assert.equal(since(n).filter((r) => r.path === "/webhooks").length, 3);
  assert.match(text, /^Amiqus returned 503 for GET \/webhooks 3 times in a row\. The service may be unavailable or in maintenance; try again in a few minutes\.$/);
  assert.ok(!text.includes("<html>"), "gateway HTML should not be passed on");
  disarm();
});

await check("a 403 is reported with the permissions hint, and Amiqus's own message has contact details redacted", async () => {
  arm({ method: "GET", path: "/aggregates/case-status", status: 403, body: { message: "Access denied for marty@example.com (call 07700 900123; EH1 2AB; born 1968-06-12; NI QQ123456C; NHS 943 476 5919)." } });
  const { res, text } = await call(client, "case_status_summary");
  assert.ok(res.isError);
  assert.equal(text, "Amiqus refused GET /aggregates/case-status (403). The token's user may lack permission for this resource, or the feature may not be enabled for this team. Access denied for [email redacted] (call [phone redacted]; [postcode redacted]; born [date redacted]; NI [NI number redacted]; NHS [NHS number redacted]).");
  disarm();
});

await check("a 200 whose body is not JSON is an error, not an empty list", async () => {
  arm({ method: "GET", path: "/clients", status: 200 }); // the mock answers with an HTML page
  const { res, text } = await call(client, "list_clients");
  assert.ok(res.isError, `a non-JSON 200 must not be reported as success: ${text}`);
  assert.match(text, /returned 200 for GET \/clients but the body was not JSON \(text\/html, \d+ bytes\)\. Check AMIQUS_BASE_URL/);
  disarm();
  const ok = await call(client, "list_clients", { max_results: 1 });
  assert.ok(!ok.res.isError);
});

await check("a 429 on POST /records is retried once (a rate-limited request is assumed not to have been processed)", async () => {
  arm({ method: "POST", path: "/records", status: 429, headers: { "Retry-After": "0" }, body: { error: "Too Many Attempts." } });
  const n = requests.length;
  const { res, data } = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: fx.TEMPLATE_IDV });
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.result, "created");
  assert.equal(since(n).filter((r) => r.method === "POST").length, 2, "one retry after the 429");
  disarm();
});

await check("a 502 on a GET is retried once, even with a non-JSON gateway body; a 502 on POST /records is never retried", async () => {
  arm({ method: "GET", path: "/webhooks", status: 502, headers: { "Retry-After": "1" } });
  const n = requests.length;
  const { res, data } = await call(client, "list_webhooks");
  assert.ok(!res.isError, res.content[0].text);
  assert.equal(data.count, 2);
  assert.equal(since(n).filter((r) => r.path === "/webhooks").length, 2);
  disarm();
  arm({ method: "GET", path: "/webhooks", status: 504, headers: { "Retry-After": "0" } });
  const k = requests.length;
  const after504 = await call(client, "list_webhooks");
  assert.ok(!after504.res.isError, after504.text);
  assert.equal(since(k).filter((r) => r.path === "/webhooks").length, 2, "a 504 on a GET is retried once too");
  disarm();
  arm({ method: "POST", path: "/records", status: 502, headers: { "Retry-After": "1" } });
  const m = requests.length;
  const post = await call(client, "create_record", { client_id: fx.CLIENT_MARTIN, template_id: fx.TEMPLATE_IDV });
  assert.ok(post.res.isError, "a 502 on a create must surface as an error, not a success");
  assert.equal(since(m).filter((r) => r.method === "POST").length, 1, "exactly one POST /records");
  assert.match(post.text, /^Amiqus returned 502 for POST \/records\. The request was not retried because it may already have been processed: check with list_records \(or list_client_records for the client\) before repeating it\.$/);
  disarm();
});

await check("when pages come back shorter than requested, paging follows links.next to the end", async () => {
  setPageCap(30); // pagination guide: "Some endpoints may have different limits"
  const n = requests.length;
  const { data } = await call(client, "list_clients", { max_results: 500 });
  assert.deepEqual([data.count, data.total, data.complete], [120, 120, true]);
  assert.deepEqual(since(n).map((r) => r.query.page), ["1", "2", "3", "4"], "four pages of 30 until links.next is null");
  const gaps = since(n).slice(1).map((r, i) => r.t - since(n)[i].t);
  for (const gap of gaps.slice(1)) assert.ok(gap >= 240, `requests after the first (connection already open) are spaced by the 250 ms throttle (gaps ${gaps.join(", ")} ms)`);
  const m = requests.length;
  const bounded = await call(client, "list_clients", { max_results: 150 });
  assert.deepEqual([bounded.data.count, bounded.data.complete, since(m).map((r) => r.query.page)], [120, true, ["1", "2", "3", "4"]], "the stop rule uses the page size the API applied (30), not the 100 requested");
  const k = requests.length;
  const partial = await call(client, "list_clients", { max_results: 100 });
  assert.deepEqual([partial.data.count, partial.data.complete, partial.data.next_page, since(k).length], [90, false, 4, 3], "three whole pages of 30 fit in 100; the fourth would not");
  setPageCap(undefined);
});

await check("when a list response omits links, current_page below total_pages still means more pages", async () => {
  setOmitLinks(true);
  const n = requests.length;
  const { data } = await call(client, "list_clients", { max_results: 500 });
  assert.deepEqual([data.count, data.total, data.total_pages, data.complete], [120, 120, 2, true]);
  assert.deepEqual(since(n).map((r) => r.query.page), ["1", "2"], "two pages, decided by current_page < total_pages");
  assert.equal("links" in JSON.parse(JSON.stringify(requests.at(-1))), false, "sanity: the request record carries no links");
  const one = await call(client, "list_clients", { search: "McFly" });
  assert.deepEqual([one.data.count, one.data.complete, one.data.total_pages], [1, true, 1]);
  setOmitLinks(false);
});

await check("every request used the Bearer token, asked for JSON, and hit a documented method+path", async () => {
  const templates = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).filter((m) => m !== "parameters").map((m) => ({ m: m.toUpperCase(), re: new RegExp("^" + p.replace(/\{[^}]+\}/g, "[^/]+") + "$") })));
  assert.ok(requests.length > 50);
  for (const r of requests) {
    assert.equal(r.auth, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(r.accept, "application/json");
    assert.ok(templates.some((t) => t.m === r.method && t.re.test(r.path)), `undocumented call ${r.method} ${r.path}`);
  }
  const used = new Set(requests.map((r) => `${r.method} ${r.path.replace(/\/\d+(?=\/|$)/g, "/{id}")}`));
  assert.deepEqual(
    [...used].sort(),
    ["GET /aggregates/case-status", "GET /checks/{id}", "GET /clients", "GET /clients/{id}", "GET /clients/{id}/records", "GET /records", "GET /records/{id}", "GET /records/{id}/steps", "GET /templates/documents", "GET /templates/emails", "GET /templates/records", "GET /webhooks", "POST /records"],
  );
  // The token never appears in any tool output seen so far (error messages are scrubbed).
});
await client.close();

await check("writes are off when AMIQUS_ALLOW_WRITES is unset, and when it is 'false'", async () => {
  for (const value of [null, "false"]) {
    const ro = await connect(ACCESS_TOKEN, value);
    const { tools } = await ro.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), READ_TOOLS, `writes exposed with AMIQUS_ALLOW_WRITES ${value === null ? "unset" : `= "${value}"`}`);
    await ro.close();
  }
});

await check("a wrong access token gives an actionable error that does not echo the token", async () => {
  const bad = await connect("Bearer aq-wrong-token-not-real");
  const { res, text } = await call(bad, "list_clients");
  assert.ok(res.isError);
  assert.match(text, /^Amiqus rejected the access token \(401\)\. Check AMIQUS_ACCESS_TOKEN: it must be a personal access token created by a user in Amiqus \(the authentication guide: .* Unauthenticated\.$/);
  assert.ok(!text.includes("aq-wrong-token"), "the token must not appear in the message");
  assert.equal(requests.at(-1).auth, "Bearer aq-wrong-token-not-real", "a pasted 'Bearer ' prefix is stripped, not doubled");
  await bad.close();
});

await check("the server refuses a base URL that carries credentials instead of sending them", async () => {
  const c = new Client({ name: "e2e", version: "1.0.0" });
  const env = { ...process.env, AMIQUS_ACCESS_TOKEN: ACCESS_TOKEN, AMIQUS_BASE_URL: `http://${["user", "secret-not-real"].join(":")}@127.0.0.1:${port}${BASE_PATH}` };
  await assert.rejects(c.connect(new StdioClientTransport({ command: process.execPath, args: [`${root}dist/index.js`], env, stderr: "ignore" })), "the server must exit at start-up");
  await c.close().catch(() => {});
});

await check("the formatter reduces an expanded document step to counts, a form to its field count, and deep nesting to a placeholder (paths the mock never exercises)", async () => {
  // The server never asks for expand=document or expand=form, so these shapes only reach the
  // formatter if the live API returned them expanded anyway; they are checked directly.
  const documentStep = fmt.step({ object: "step", id: 3, type: "document.request", preferences: { title: "Utility bill", instructions: "Email it to docs@example.com" }, document: { object: "record_document", id: 23123, type: "requested", name: "Utility bill", status: "complete", config: { instructions: "Email it to docs@example.com" }, attachments: [{ object: "attachment", id: 1, name: "a.pdf", original: "bill.pdf", type: "application/pdf", size: 10, av_status: "clean", created_at: "2026-08-21T10:05:00Z", updated_at: "2026-08-21T10:05:00Z" }], completed_at: "2026-08-21T10:05:00Z" }, review: false, cost: 0, completed_at: "2026-08-21T10:05:00Z" }, false);
  assert.deepEqual(documentStep.document, { document_id: 23123, type: "requested", name: "Utility bill", status: "complete", instructions: "Email it to [email redacted]", attachment_count: 1, completed_at: "2026-08-21T10:05:00Z" });
  assert.ok(!JSON.stringify(documentStep).includes("bill.pdf") && !JSON.stringify(documentStep).includes("@example."), "an attachment or email leaked from a document step");
  const formStep = fmt.step({ object: "step", id: 4, type: "form", form: { object: "client_form", id: 9, reference: "4bd9bfca-e61d-4a68-99b3-ca61a02f650f", type: "requested", client: 1, record: 2, name: "Source of funds", description: null, instructions: null, fields: [{ type: "section", title: "About you" }, { type: "text", title: "Employer", value: "Acme, ask for sam@example.com" }], version: 1, created_at: "2026-08-21T10:05:00Z", updated_at: "2026-08-21T10:05:00Z", completed_at: null, archived_at: null }, review: false, cost: 0, completed_at: null }, false);
  assert.deepEqual(formStep.form, { form_id: 9, form_reference: "4bd9bfca-e61d-4a68-99b3-ca61a02f650f", type: "requested", name: "Source of funds", fields: "[2 form fields: the client's answers are not returned by this server]" });
  assert.ok(!JSON.stringify(formStep).includes("Acme"), "a form answer leaked");
  const deep = (levels) => (levels === 0 ? { leaf: "deep@example.com" } : { n: deep(levels - 1) });
  const redacted = fmt.redactDeep(deep(24), false);
  let node = redacted;
  for (let i = 0; i < 19; i++) node = node.n;
  assert.match(node.n, /^\[value nested deeper than 20 levels omitted\]$/, "the 21st level is replaced by the placeholder");
  assert.ok(!JSON.stringify(redacted).includes("@example."), "the deep email leaked");
  assert.equal(fmt.redactDeep(deep(3), false).n.n.n.leaf, "[email redacted]");
});

await check("the formatter withholds the siblings of a verdict under a personal-data key, matches common key spellings and camelCase, and returns NFC chip data only on request", async () => {
  // A beta response might put the compared value next to the verdict. Only the verdict parts survive.
  const verdicts = fmt.scrubCheckData({ breakdown: { first_name: { result: "clear", value: "MARTIN", extracted: "MARTIN" }, date_of_birth: { result: "clear", document_value: "1968-06-12" }, name_match: { result: "consider", reason: { type: "mismatch", message: "Document says MARTIN MCFLY" }, properties: { score: 0.4 } }, mrz: { result: "consider", breakdown: { checksum: { result: "consider", line: "P<GBRMCFLY<<MARTIN" } } }, face_match: { result: "clear", properties: { score: 0.91 } } } }, false);
  assert.deepEqual(verdicts, { breakdown: { first_name: { result: "clear", value: fmt.WITHHELD, extracted: fmt.WITHHELD }, date_of_birth: { result: "clear", document_value: fmt.WITHHELD }, name_match: { result: "consider", reason: { type: "mismatch", message: fmt.WITHHELD }, properties: { score: 0.4 } }, mrz: { result: "consider", breakdown: { checksum: { result: "consider", line: fmt.WITHHELD } } }, face_match: { result: "clear", properties: { score: 0.91 } } } });
  assert.ok(!JSON.stringify(verdicts).includes("MARTIN"), "a value next to a verdict leaked");
  // The documented Photo ID response is unchanged by that rule: every verdict keyed by a field name is {result}.
  const documented = fmt.scrubCheckData(fx.PHOTO_ID_RESPONSE.reports[0].breakdown, false);
  assert.deepEqual(documented, fx.PHOTO_ID_RESPONSE.reports[0].breakdown, "the documented breakdown has no siblings to withhold");
  // Spellings a beta criminal-record or credit response might use, including camelCase.
  const spelled = fmt.scrubCheckData({ holder: "Martin McFly", surname: "MCFLY", forename: "Martin", birth_date: "1968-06-12", dateOfBirth: "1968-06-12", documentNumber: "000000000", post_code: "EH1 2AB", postalCode: "EH1 2AB", street: "12 High Street", city: "Hill Valley", town: "Hill Valley", county: "Lothian", address_line_1: "12 High Street", ni: "QQ123456C", nhs_no: "943 476 5919", personal_number: "8806302345", id_number: "X1234567", certificate_number: "001234567890", identifier: "X", score: 0.9, status: "complete", report_type: "basic", created_at: "2026-08-22T09:00:00Z", starts_at: "2023-01-28", note: "Certificate issued 12/06/2026 to EH1 2AB", nfc: { first_name: "MARTIN", personal_number: "8806302345", mrz_line_1: "P<GBR" } }, false);
  for (const k of ["holder", "surname", "forename", "birth_date", "dateOfBirth", "documentNumber", "post_code", "postalCode", "street", "city", "town", "county", "address_line_1", "ni", "nhs_no", "personal_number", "id_number", "certificate_number", "identifier", "nfc"]) assert.equal(spelled[k], fmt.WITHHELD, `${k} must be withheld by default`);
  assert.deepEqual([spelled.score, spelled.status, spelled.report_type, spelled.created_at, spelled.starts_at, spelled.note], [0.9, "complete", "basic", "2026-08-22T09:00:00Z", "[date redacted]", "Certificate issued [date redacted] to [postcode redacted]"], "verdict-like and system fields are kept; bare dates and postcodes in text are redacted");
  const onRequest = fmt.scrubCheckData({ surname: "MCFLY", nfc: { first_name: "MARTIN", mrz_line_1: "P<GBR" }, starts_at: "2023-01-28", media: [{ type: "document" }] }, true);
  assert.deepEqual([onRequest.surname, onRequest.nfc, onRequest.starts_at], ["MCFLY", { first_name: "MARTIN", mrz_line_1: "P<GBR" }, "2023-01-28"], "with include_contact_details the data, including NFC chip data, is returned");
  assert.match(onRequest.media, /never returned/, "files are never returned, even on request");
  // Free text: dates, UK postcodes, NI and NHS numbers are caught next to emails and phones; timestamps, references and version numbers are not.
  assert.equal(fmt.redactContacts("Born 1968-06-12 at 12 High St EH1 2AB, +447700900123. NI QQ 12 34 56 C. NHS 943 476 5919", false), "Born [date redacted] at 12 High St [postcode redacted], [phone redacted]. NI [NI number redacted]. NHS [NHS number redacted]");
  assert.equal(fmt.redactContacts("DOB 12/06/1968, 12.06.1968, 12 June 1968, June 12th, 1968; sw1a 1aa; QQ123456C", false), "DOB [date redacted], [date redacted], [date redacted], [date redacted]; [postcode redacted]; [NI number redacted]");
  assert.equal(fmt.redactContacts("Approved 2026-08-22T09:00:00Z, ref MCFLY-1955, REF-2026-08-22, order 1234567890, v1.2.3, NHS 943 476 5918, statement 2026-08", false), "Approved 2026-08-22T09:00:00Z, ref MCFLY-1955, REF-2026-08-22, order 1234567890, v1.2.3, NHS 943 476 5918, statement 2026-08", "a timestamp, hyphenated references, a ten-digit number with a wrong NHS check digit and a year-month are left alone");
  assert.equal(fmt.redactContacts("Born 1968-06-12, EH1 2AB", true), "Born 1968-06-12, EH1 2AB", "returned as typed on request");
});

mock.close();
console.log(`\n${passed} checks passed, ${requests.length} API calls made against the mock, ${((Date.now() - started) / 1000).toFixed(1)} s.`);
