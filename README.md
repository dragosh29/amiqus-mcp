# Amiqus MCP server

An [MCP](https://modelcontextprotocol.io) server that lets Claude, ChatGPT and other MCP clients read an Amiqus ID account (client onboarding with identity, AML, right-to-work and criminal-record checks): clients, records and their steps, check results, templates, case status counts and webhooks, and (when enabled) create records. It is built from Amiqus's public developer documentation and its published OpenAPI 3.1 spec, and nothing else.

Once it's connected, someone on the team can ask things like:

- "Where is Martin McFly's onboarding? Which steps are still open?"
- "Which records are waiting on check results, and who created them?"
- "Did the photo ID check on record 983500 pass? What needed consideration?"
- "How many cases need action from us this month?"
- "Which record templates are enabled, and what steps does 'Identity verification' send?"
- With writes enabled: "Send Jennifer Parker the Identity verification template."

## Tools

| Tool | What it does | API calls |
|---|---|---|
| `list_clients` | Clients with name, decision status, reference, retention date and timestamps. Filters: fuzzy `search`, `status`, `visibility`, `assignee`, exact `reference`, `deletion_date` bucket, `sort_by` and `order_by`; pages by `page`/`limit`. | `GET /clients` |
| `get_client` | One client. | `GET /clients/{id}` |
| `list_client_records` | Every record sent to one client, with its steps. | `GET /clients/{id}/records` |
| `list_records` | Records across the team. Filters: `status`, `visibility`, `created_by`, `assignee` (a user ID, or `false` for unassigned), `client_visibility`, `sort_by`, `order_by`. | `GET /records` |
| `get_record` | One record with its steps. By default the steps are fetched with `expand=check,review`, so each check step shows the check's status and the latest team-member review. | `GET /records/{id}`, `GET /records/{id}/steps?expand=check,review` |
| `get_check` | One check with its response expanded: overall result, and per report the status, result and verification breakdown. | `GET /checks/{id}?expand=response` |
| `list_templates` | Record templates (preset steps, notification, message, reminders, assignees), email templates or document templates; `enabled` filter. | `GET /templates/records`, `/templates/emails`, `/templates/documents` |
| `case_status_summary` | Count of cases per status, with `assigned_to` (ID or `false`), `start_date`, `end_date` and `visibility`. | `GET /aggregates/case-status` |
| `list_webhooks` | Webhook subscriptions: URL (origin and path), events, enabled flag. Never the signing secret. | `GET /webhooks` |
| `create_record` | Creates a record for an existing client from a record template (`template_id`) or from an explicit step list with `notification` (`"email"` or `false`), `message`, `reminder` and `is_declaration_required`. Refuses locally a request that mixes the two forms or lacks `notification` in the step form. Only registered when writes are enabled. | `POST /records` |

Not covered on purpose: the user and team endpoints, client addresses, organisations, assignees, forms and form templates, files and downloads (`/records/{id}/download`, `/clients/{id}/files/{fileId}/download`, `/clients/{id}/forms/{reference}/download`), documents and attachments, credits, cases and case items, step reviews (writing), SDK tokens, webhook creation, and every update, archive, expire and delete endpoint. This server never downloads a file.

## Setup

Requires Node 18 or later.

```bash
npm install
npm run build
```

You need a personal access token for your Amiqus team. Amiqus's authentication guide says a token carries the permissions of the user who created it, is limited to the team active when it was created, expires after one year and can be revoked by the user; the API accepts it as a Bearer token. Amiqus also documents an OAuth2 authorization-code flow (`/oauth/authorize`, `/oauth/token`); this server does not implement it.

**Claude Desktop:** add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "amiqus": {
      "command": "node",
      "args": ["/absolute/path/to/amiqus-mcp/dist/index.js"],
      "env": { "AMIQUS_ACCESS_TOKEN": "your-token" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add amiqus -e AMIQUS_ACCESS_TOKEN=your-token -- node /absolute/path/to/amiqus-mcp/dist/index.js
```

| Variable | Required | Meaning |
|---|---|---|
| `AMIQUS_ACCESS_TOKEN` | yes | A personal access token, sent as `Authorization: Bearer …`. A pasted `Bearer ` prefix is stripped. |
| `AMIQUS_ALLOW_WRITES` | no | `true` to register `create_record`. Off by default. |
| `AMIQUS_BASE_URL` | no | Defaults to `https://id.amiqus.co/api/v2` (the spec's server URL). Used by the tests. Must not contain credentials. |

## Safety defaults

- Read-only unless `AMIQUS_ALLOW_WRITES=true`. Read tools carry the MCP `readOnlyHint` annotation; `create_record` is marked as a non-destructive, non-idempotent write. There are no cancel, archive, expire or delete tools.
- This is identity data, so the default output is names and states, not personal details. Client names, references, statuses, dates and IDs are returned by default. Only returned when a tool is called with `include_contact_details=true`: a client's email address, landline, mobile, date of birth and National Insurance number; a record's contact email and its `perform_url` (the spec calls it "the unique URL to complete the record steps in a browser", so whoever has it can submit identity documents as the client; the default output only says whether one exists); and, inside a check response, the data read from the identity document (`document_data`: names, date of birth, gender, document numbers, issue and expiry dates, MRZ lines, nationality, place of birth, and the `nfc` chip data when the chip was read), the eVisa report's `name` and `reference`, and any bare date in a check response (the eVisa's `starts_at` and `expires_at`, say; a date without a time of day is the shape of a date of birth, so it is redacted by default, while timestamps are kept). The verification breakdown (which checks were `clear` or `consider`, with scores) is returned by default: its entries named after fields (`first_name`, `date_of_birth`, `document_numbers`, `mrz`) are verdicts about those fields, not the values, and only the verdict parts of such an entry come back (`result`, `status`, `type`, nested verdicts, the reason's `type`, scores); anything else stored next to the verdict is withheld.
- Never returned, with or without `include_contact_details`: identity-document images, selfies and motion captures, eVisa PDFs and any other attachment inside a check response (replaced by a placeholder and a count); the attachments of document steps (only a count); a form's answers (only the field count); a webhook's signing secret; and the query string of a webhook delivery URL (which may carry a token; the output flags that it was removed). The server never calls a download endpoint.
- In free text (references, step preferences such as a document request's title and instructions, review messages, template names, descriptions, messages and content, eVisa conditions, error messages from Amiqus) these are replaced by default: email addresses (`[email redacted]`), phone-number-like sequences (`[phone redacted]`), dates without a time of day such as `1968-06-12`, `12/06/1968`, `12.06.1968`, `12 June 1968` or `June 12th, 1968` (`[date redacted]`), UK postcodes (`[postcode redacted]`), National Insurance numbers (`[NI number redacted]`) and NHS numbers, ten digits in 3-3-4 groups whose last digit passes the modulus-11 check (`[NHS number redacted]`). All of these are heuristics. The phone match covers international numbers written with `+` or `00`, UK numbers with a bracketed area code, and UK-style `0…` numbers of 9 to 11 digits with spaces, dots or hyphens; other digit strings starting with `0` may be caught too, and one ten-digit number in eleven passes the NHS check. Not caught: a street address written as words (`12 High Street`; its postcode is), a year-month (`2026-08`) and a date glued to letters. Left alone on purpose: numeric IDs, UUIDs, timestamps (`2026-08-22T09:00:00Z`), version numbers and hyphenated references such as `MCFLY-1955` or `REF-2026-08-22`. Template text has no `include_contact_details` switch and is always redacted. Values nested more than 20 levels deep are replaced by a placeholder.
- The check-response scrubbing is generic because the spec marks check responses as beta ("available data may be incomplete or differ from the specification") and documents only the Photo ID response in full. It works by key name: a key matching this list is withheld unless its value is a `{result: …}` verdict: `name`/`names`, `first_name`, `last_name`, `middle_name`, `full_name`, `complete_name`, `surname`, `forename(s)`, `given_name(s)`, `holder`, `date_of_birth`, `dob`, `birth…` (`birth_date`, `birthday`), `gender`, `sex`, `nationality`, `place_of_birth`, `document_data`, `document_number(s)`, `mrz`, `address`, `street`, `city`, `town`, `county`, `postcode`/`post_code`/`postal_code`, `zip`, `line1`/`line_1`, `email`, `phone`, `mobile`, `landline`, `telephone`, `national_insurance_number`, `ni`, `ni_number`, `nhs…` (`nhs_number`, `nhs_no`), `pin`, `pin_number`, `share_code`, `reference`, `passport`, `passport_number`, `licence_number`/`license_number`, `issuing_date`, `issue_date`, `date_of_expiry`, `expiry`, `expiry_date`, `personal_details`, `applicant`, `account_number`, `sort_code`, `iban`, `card_number`, `personal_number`, `id_number`, `certificate_number`, `identifier`, `nfc`, each matched as a whole word within an underscore-separated key, after splitting camelCase and lower-casing (`dateOfBirth`, `DocumentNumber` and `address_line_1` match; `document_type` does not). Anything else in a check response is returned, with the free-text redaction above applied to every string, so a personal value under a key that is not on the list would come back with its dates, postcodes and contact details redacted but its words (a name, a street) intact. Any key that looks like a file (`media`, `attachment(s)`, `image(s)`, `pdf`, `selfie`, `video`, `photo`) is always withheld.
- IDs are checked before any call is made: every ID this server sends is a positive whole number (the spec types them as integers). The `expand` values sent are the documented ones (`check,review` on steps, `response` on a check), comma-separated as the expandable-properties guide shows. Filter values are the spec's enums; `assignee`/`assigned_to` take a user ID or `false` as documented. A date or date-time given to `case_status_summary` is sent as `YYYY-MM-DDTHH:MM:SSZ`, the form in the data-formats guide: a date alone becomes `T00:00:00Z` (start) or `T23:59:59Z` (end), missing seconds become `:00`, a time without a zone is taken as UTC, an offset such as `+01:00` is converted to UTC and fractions of a second are dropped; an impossible calendar date (`2026-02-30`, `2026-13-01`) or time of day is refused before any call.
- `create_record` sends exactly the two documented request shapes (the spec's "Template" and "Manual" variants) and refuses a mix of them locally. Steps are passed through as given; their types and preferences are the API's, and the API's 422 field errors (`steps.0.type: The selected type is invalid.`) are passed on.
- Rate limits, as documented in Amiqus's rate-limits guide: every response carries `X-RateLimit-Limit` and `X-RateLimit-Remaining` (the guide's example limit is 200, and "rate limits may differ depending on the endpoint"); once exhausted, requests get a 429 with `Retry-After` (seconds until the limit resets) and `X-RateLimit-Reset`; one limit is shared by every token of a user on a team. The window length is not documented. Requests are spaced 250 ms apart (the tests measure at least 240 ms between consecutive requests on an open connection). A 429 is retried at most twice for any method, including `POST /records`, on the assumption that a rate-limited request was not processed (see Status). The retry waits for `Retry-After` (whole or fractional seconds, or an HTTP-date; 2 s then 4 s when the header is absent or unreadable). Each wait is capped at 10 seconds, so one request waits at most 20 seconds in all; a tool call that makes several requests (pages, lookups) can still run past the MCP client's default 60-second request timeout. Past the cap: if Amiqus asks for a longer wait the call gives up at once and the message says how long to wait. The final 429 message quotes `X-RateLimit-Limit` and `Retry-After`.
- 502, 503 and 504 are retried the same way for `GET` only; when all three attempts fail the error says the service may be unavailable or in maintenance (the status-codes guide describes 503 as maintenance) and to try again in a few minutes, without the gateway's HTML. A `POST /records` is never retried after a gateway error, because the record may already have been created and the client emailed; the error tells the assistant to check with `list_records` or `list_client_records` first. Amiqus documents no idempotency key, so there is nothing to send that would make a repeat safe.
- A 200 whose body is not JSON (a proxy or a login page in the way) is reported as an error naming `AMIQUS_BASE_URL`, never as an empty list. A rejected token produces a message that says which variable to fix and never echoes the token; a 403 says the token's user may lack permission or the feature (cases, for example) may not be enabled for the team; a 404 names the path; a 422 lists Amiqus's field errors.

## Tests

```bash
npm test
```

The test suite:

1. Validates every fixture record against the schemas in Amiqus's published OpenAPI 3.1 spec, with Ajv 2020-12: clients (`Client` plus the `/clients` status enum), records (`Record`), every step (`RecordSteps`), checks (`Check`, including the documented Photo ID `CheckResponse` with document, facial-similarity and eVisa reports), step reviews (`StepReview`), record, email and document templates, webhooks and the case status aggregate. Negative controls confirm the schemas reject a string ID, an undeclared key, an unknown status and a malformed `links` object. The spec is downloaded from `developers.amiqus.co/aqid/openapi.json` to `spec.json` on the first run.
2. Starts a local mock of the API under `/api/v2` that serves those fixtures with the documented `page`/`limit` pagination (`PaginatedList` with `links.next`/`previous` carrying the current query parameters, `links: null` for a single page, 422 for a limit above 100, and on request pages capped below the requested limit or responses without `links`), Bearer-token 401s in the `Error` shape, the spec's default 404 texts (`Client not found`, `Record not found`, `Check not found`), 422 field-error maps (including the guide's "expand parameter must be one of" case), the `X-RateLimit-*` headers, `expand=check,review` on steps and `expand=response` on checks (with a collapsed `true`/`null` response otherwise, and no nested expansion, as the guide says), and `POST /records` in both documented shapes (the spec's own request examples are posted and answered with a `Record`). The mock's list, detail, created and error responses are validated against the spec's response schemas. The first `GET /templates/records` is answered with a 429.
3. Starts the built server and drives it over stdio with the official MCP client: 33 checks covering every tool, tool annotations, paging by `page`/`limit` across two pages of 100 and stopping when `links.next` is null, whole-page `max_results` with `next_page` (and the short last page fetched when `total` says it fits), paging through short pages when the API caps the page size (with the stop rule using the applied page size and the throttle's 250 ms spacing measured between requests on an open connection), paging by `current_page`/`total_pages` when a response has no `links`, every documented filter of `list_clients`, `list_records`, `list_templates`, `list_webhooks` and `case_status_summary` passed through with the documented parameter names and values (including `assignee=false`, `created_by` rather than the deprecated `creator`, and seven date/date-time input forms each sent as `YYYY-MM-DDTHH:MM:SSZ` while nine malformed or impossible ones are refused with the intended message and no request), the default redaction and its opt-in for client contact details, a record's email and perform URL, step preferences, review messages and check responses (verdicts kept, `document_data`, eVisa name/reference and bare dates withheld, images and files never returned even on request), the 'not yet available' and pending check responses, the 429 retry waiting for `Retry-After` in the seconds, fractional-seconds and HTTP-date forms, giving up after three attempts on a persistent 429 and at once on a `Retry-After` above the cap, a 429 on `POST /records` retried once, a 502 and a 504 retried for `GET` and a 502 never for `POST /records`, a `GET` failing three times with 503 reported with advice and without the gateway HTML, a 403 reported with the permissions hint and the email, phone, postcode, date, NI and NHS number in Amiqus's own message redacted, a 200 with a non-JSON body reported as an error, the `POST /records` bodies validated against the spec's request schema and its Template and Manual branches, the local refusal of mixed or incomplete create requests and the pass-through of 422 field errors, ID validation before any call, the 401 and 404 messages, the write gate with the variable unset and set to `false`, a base URL with credentials refused at start-up, that every request used the Bearer token, asked for JSON and matched a documented method and path, and, directly on the formatter, the reduction of an expanded document step to counts and a form to its field count, the 20-level nesting placeholder, the withholding of values stored next to a verdict under a personal-data key (with the documented Photo ID breakdown unchanged), the key spellings and camelCase forms on the list above, NFC chip data withheld by default and returned on request, and the free-text patterns with their intended non-matches (shapes the server never requests, so the mock never serves them).

The suite makes 106 requests to the mock and takes about 35 seconds; it never contacts Amiqus except to download the spec.

## Status

This is a working prototype. It has **not yet been run against the live API**, because it was built without an Amiqus account (there is no self-serve trial; the getting-started guide says to contact Amiqus for a sandbox). Everything below is taken from the published documentation and should be confirmed on a real account, sandbox first:

- Authentication end to end with a personal access token, the body of a real 401 (the spec gives only `{error}`), and whether a token limited to one team sees exactly that team's data.
- Pagination: that `links.next` is null on the last page and `links` null on a single page as the guide says (the server also treats `current_page` below `total_pages` as "more pages", so a response without `links` is still paged, and it sizes the next page from the response's `limit` and `total`), what `limit` and `page` values outside 1..100 and 1.. answer (the mock answers 422), whether any endpoint used here has a page limit below 100 (the guide says some may), and that `total`, `total_pages`, `current_page` and `limit` are always filled.
- The default sort order of `GET /clients` ("ID order" per the parameter description) and `GET /records` ("created_at order"), and the exact semantics of the `search` (fuzzy) and `reference` (exact) filters.
- `assignee=false` on `GET /records` and `assigned_to=false` on the aggregate: the spec types them as integer-or-`false`; the server sends the literal `false` as a query string.
- The `expand` parameter: that `expand=check,review` on `GET /records/{id}/steps` and `expand=response` on `GET /checks/{id}` are accepted with a comma-separated list, what the expanded `review` looks like on a step that has never been reviewed (the spec says `null`) and on one that cannot be (`false`), and whether an embedded check's `response` is collapsed to `true`/`null`.
- The shape of check responses on a live account. The spec marks them as beta and documents only the Photo ID response (`check_response.photo_id`) in detail, and its examples label that check `type: "identity"` while the `Check.type` enum also has `photo_id`; other types come back as `check_response.other`. Which fields carry personal data in the responses of watchlist, criminal-record, credit and other checks is unknown, which is why the scrubbing is by key name and generic. Confirm on real responses that nothing personal slips through by default.
- Which fields the live API fills: `national_insurance_number` and `is_declaration_required` are "available where feature enabled on team only"; `perform_url` is `false` when nothing can be submitted; `deletion_date` may be null.
- `GET /aggregates/case-status` on a team without cases (the spec says cases "may not be enabled for all teams"; the server reports a 403 with that hint) and the exact meaning of `start_date`/`end_date` ("statuses updated on or after/before").
- `POST /records`: that a record created from a template with `assignees: false` really gets no assignees, what the created record's `steps` look like for document and form steps (the mock resolves a `{template}` preference to a title and instructions, as the spec's 201 example does), and whether a 429 on `POST /records` can ever arrive after the record was created (the server retries a 429 once on the assumption that it was not processed).
- The wording of Amiqus's error messages and whether any of them echo request data; the texts here are placeholders (the 404 texts are the spec's defaults), and the server redacts contact details from them regardless.
- The date-time format on the wire: the data-formats guide says RFC 3339 with `Z`, which is what the fixtures use and what `ajv-formats` requires.
- How many requests per second the API tolerates within its limit; the window is not documented, so the 250 ms spacing is a guess on the polite side.

## Going to production

This version runs locally over stdio, with the account holder's own personal access token. For customers to connect from claude.ai or ChatGPT without handling tokens, the next step is a remote server (Streamable HTTP) behind Amiqus's own OAuth2 authorization-code flow, hosted by Amiqus, and then a listing in the Claude and ChatGPT connector directories.

## Licence

MIT. Built by Alexandru Dragoș (alexandru.dragos96@gmail.com) with an AI agent (Claude) working under his direction.
