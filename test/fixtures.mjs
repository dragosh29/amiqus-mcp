// Fake Amiqus data shaped exactly like the published OpenAPI schemas (validated in e2e.mjs).
// Timestamps use the RFC 3339 "Z" form shown in every example of the spec and the data-formats guide.
// Every name, email, phone number, document number and token here is made up; nothing is real.
const stamp = (d, h = 9, m = 0) => `2026-08-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;

// Team member user IDs (the assignee / created_by filters take these).
export const USER_ALEX = 623;
export const USER_JO = 626;

// ---- Names (Name) ----
const mkName = (title, first, middle, last) => ({
  object: "name",
  title,
  other_title: null,
  first_name: first,
  middle_name: middle,
  last_name: last,
  name: `${first} ${last}`,
  full_name: middle ? `${first} ${middle} ${last}` : `${first} ${last}`,
  complete_name: `${title ? title[0].toUpperCase() + title.slice(1) + " " : ""}${middle ? `${first} ${middle} ${last}` : `${first} ${last}`}`,
});

// ---- Clients (Client) ----
export const CLIENT_MARTIN = 73845;
export const CLIENT_JEN = 73841;
export const CLIENT_DOC = 76219;
export const CLIENT_BIFF = 76220;
const mkClient = (id, status, name, email, extra = {}) => ({
  object: "client",
  id,
  status,
  name,
  email,
  landline: null,
  mobile: null,
  dob: null,
  reference: null,
  national_insurance_number: null,
  is_deletable: true,
  deletion_date: null,
  created_at: stamp(1, 9, 0),
  updated_at: stamp(1, 9, 0),
  archived_at: null,
  ...extra,
});
const named = [
  mkClient(CLIENT_MARTIN, "pending", mkName("mr", "Martin", "Seamus", "McFly"), "marty@example.com", {
    mobile: "07700 900123",
    dob: "1968-06-12",
    reference: "MCFLY-1955",
    national_insurance_number: "QQ123456C",
    deletion_date: "2027-01-14",
    created_at: stamp(2, 14, 15),
    updated_at: stamp(20, 8, 22),
  }),
  // A reference with an email address typed into it, to prove references are redacted by default.
  mkClient(CLIENT_JEN, null, mkName("miss", "Jennifer", "Jane", "Parker"), "jennifer@example.com", {
    dob: "1967-10-29",
    reference: "contact jennifer@example.com",
    deletion_date: "2026-08-10",
    created_at: stamp(3, 10, 0),
    updated_at: stamp(3, 10, 0),
  }),
  mkClient(CLIENT_DOC, "approved", mkName("dr", "Emmett", "Lathrop", "Brown"), "doc@example.com", {
    landline: "0131 496 0000",
    reference: "BROWN-1985",
    created_at: stamp(4, 11, 30),
    updated_at: stamp(15, 16, 0),
    archived_at: stamp(15, 16, 0),
  }),
  mkClient(CLIENT_BIFF, "rejected", mkName(null, "Biff", null, "Tannen"), "biff@example.com", { created_at: stamp(5, 8, 0), updated_at: stamp(6, 8, 0) }),
];
// 116 more clients so the list spans two pages of 100 (total 120).
const bulk = Array.from({ length: 116 }, (_, i) =>
  mkClient(74000 + i, i % 3 === 0 ? "approved" : null, mkName(null, `Person${i}`, null, `Surname${i}`), `person${i}@example.org`, { created_at: stamp(6 + (i % 20), 8, i % 60), updated_at: stamp(6 + (i % 20), 8, i % 60) }),
);
export const clients = [...named, ...bulk];
// Assignees per client (not part of the Client schema; the API filters on them via `assignee`).
export const clientAssignees = { [CLIENT_MARTIN]: [USER_ALEX], [CLIENT_JEN]: [USER_JO], [CLIENT_DOC]: [USER_ALEX] };

// ---- Checks (Check) ----
export const CHECK_MARTIN_PENDING = 82342;
export const CHECK_MARTIN_PHOTO = 82350;
export const CHECK_MARTIN_WATCHLIST = 82351;
export const CHECK_MARTIN_DBS = 82352;
export const CHECK_JEN_PHOTO = 82360;
export const CHECK_DOC_PHOTO = 82370;
export const REC_MARTIN = 983434;
export const REC_MARTIN_DONE = 983500;
export const REC_JEN = 983600;
export const REC_DOC = 983700;

const attachment = (id, original, type, size) => ({ object: "attachment", id, name: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}.${original.split(".").pop()}`, original, type, size, av_status: "clean", created_at: stamp(21, 10, 5), updated_at: stamp(21, 10, 5) });
const clear = { result: "clear" };
// The Photo ID document report, shaped like the spec's documented example: a breakdown of verification
// verdicts (no personal data) plus document_data (the identity-document data read from the document,
// fake here) and media (the document images). The breakdown keys named after fields (first_name,
// date_of_birth, document_numbers) are verdicts about those fields, not the values.
export const PHOTO_ID_RESPONSE = {
  object: "check_response.photo_id",
  status: "complete",
  result: "consider",
  reports: [
    {
      type: "document",
      status: "complete",
      result: "consider",
      breakdown: {
        age_validation: { result: "clear", breakdown: { minimum_accepted_age: clear } },
        compromised_document: { result: "clear", breakdown: { document_database: clear, repeat_attempts: clear } },
        data_comparison: { result: "clear", breakdown: { first_name: clear, last_name: clear, date_of_birth: clear } },
        data_consistency: { result: "clear", breakdown: { issuing_country: clear, document_numbers: clear, nationality: clear, gender: clear, document_type: clear, date_of_expiry: clear, date_of_birth: clear, last_name: clear, first_name: clear } },
        data_validation: { result: "consider", breakdown: { mrz: { result: "consider" }, document_expiration: clear, expiry_date: clear, date_of_birth: clear, gender: clear, document_numbers: clear } },
        image_integrity: {
          result: "clear",
          breakdown: {
            supported_document: clear,
            image_quality: { result: "clear", properties: { glare_on_photo: clear, blurred_photo: clear, covered_photo: clear, other_photo_issue: clear, incorrect_side: clear, cut_off_document: clear, no_document_in_image: clear, two_documents_uploaded: clear } },
            colour_picture: clear,
            conclusive_document_quality: { result: "clear", properties: { watermarks_digital_text_overlay: clear, punctured_document: clear, obscured_security_features: clear, obscured_data_points: clear, missing_back: clear, digital_document: clear, corner_removed: clear, abnormal_document_features: clear } },
          },
        },
        issuing_authority: { result: "clear", breakdown: { nfc_passive_authentication: clear, nfc_active_authentication: clear } },
        police_record: clear,
        visual_authenticity: {
          result: "clear",
          breakdown: { face_detection: clear, digital_tampering: clear, original_document_present: { result: "clear", properties: { screenshot: clear, document_on_printed_paper: clear, photo_of_screen: clear, scan: clear } }, picture_face_integrity: clear, security_features: clear, fonts: clear, template: clear },
        },
      },
      document_data: {
        document_type: "passport",
        first_name: "MARTIN",
        last_name: "MCFLY",
        middle_name: "SEAMUS",
        date_of_birth: "1968-06-12",
        gender: "male",
        document_numbers: [{ type: "document_number", value: "000000000" }],
        issuing_authority: null,
        issuing_country: "GBR",
        issuing_state: null,
        issuing_date: "2019-08-24",
        date_of_expiry: "2029-08-24",
        mrz_line1: "P<GBRMCFLY<<MARTIN<SEAMUS<<<<<<<<<<<<<<<<<<<",
        mrz_line2: "0000000000GBR6806121M2908240<<<<<<<<<<<<<<00",
        mrz_line3: null,
        nationality: "GBR",
        place_of_birth: "HILL VALLEY",
        nfc: null,
      },
    },
    {
      type: "facial_similarity_motion",
      status: "complete",
      result: "clear",
      breakdown: {
        face_comparison: { result: "clear", breakdown: { face_match: { result: "clear", properties: { score: 0.91 } } } },
        image_integrity: { result: "clear", breakdown: { face_detected: clear, source_integrity: clear } },
        visual_authenticity: { result: "clear", breakdown: { liveness_detected: clear, spoofing_detection: { result: "clear", properties: { score: 0.01 } } } },
      },
    },
    {
      type: "evisa",
      status: "complete",
      result: "consider",
      report: {
        name: "Martin McFly",
        reference: "A0B0CD00E",
        conditions: { primary: ["Work is permitted only for the sponsor named on the visa; queries to sponsor@example.com"], voluntary_work: null, additional_part_time_work: null, work_placement: null },
        restrictions: null,
        starts_at: "2023-01-28",
        expires_at: null,
      },
      report_type: "right_to_work",
      breakdown: {
        name_match: { result: "clear", reason: null },
        conditions: { result: "consider", reason: { type: "conditions", message: "Conditions apply to the right to work" } },
        restrictions: { result: "clear", reason: null },
        starts_at: { result: "clear", reason: null },
        expires_at: { result: "clear", reason: null },
        image_match: {
          result: "clear",
          reason: null,
          breakdown: {
            face_comparison: { result: "clear", breakdown: { face_match: { result: "clear", properties: { score: 0.89 } } } },
            image_integrity: { result: "clear", breakdown: { face_detected: clear, source_integrity: clear } },
            visual_authenticity: { result: "clear", breakdown: { spoofing_detection: { result: "clear", properties: { score: 0.02 } } } },
          },
        },
      },
      attachments: { image: attachment(31788, "evisa_selfie.jpeg", "image/jpeg", 24817), pdf: attachment(31789, "evisa_report.pdf", "application/pdf", 118204) },
      errors: null,
    },
  ],
  media: [{ type: "document", attachment: attachment(31785, "passport.jpg", "image/jpeg", 16053), document_type: "passport", side: "front", issuing_country: "GBR", has_nfc: false }],
};

const mkCheck = (id, type, record, status, response, extra = {}) => ({
  object: "check",
  id,
  type,
  record,
  status,
  response,
  allow_replay: true,
  allow_cancel: true,
  requires_consent: true,
  created_at: stamp(20, 8, 22),
  updated_at: stamp(21, 10, 5),
  ...extra,
});
// `response` here is what GET /checks/{id}?expand=response returns; the mock collapses an object to
// `true` when the response is not expanded (spec: "true when there is an expandable response available").
export const checks = {
  [CHECK_MARTIN_PENDING]: mkCheck(CHECK_MARTIN_PENDING, "photo_id", REC_MARTIN, "pending", null),
  [CHECK_MARTIN_PHOTO]: mkCheck(CHECK_MARTIN_PHOTO, "photo_id", REC_MARTIN_DONE, "refer", PHOTO_ID_RESPONSE),
  // A check type whose response the spec says is "not yet available from the API".
  [CHECK_MARTIN_WATCHLIST]: mkCheck(CHECK_MARTIN_WATCHLIST, "identity", REC_MARTIN_DONE, "accepted", { object: "check_response.other" }),
  [CHECK_MARTIN_DBS]: mkCheck(CHECK_MARTIN_DBS, "criminal_record", REC_MARTIN_DONE, "submitted", null, { allow_cancel: false }),
  [CHECK_JEN_PHOTO]: mkCheck(CHECK_JEN_PHOTO, "photo_id", REC_JEN, "submitted", null),
  [CHECK_DOC_PHOTO]: mkCheck(CHECK_DOC_PHOTO, "photo_id", REC_DOC, "accepted", { object: "check_response.other" }),
};

// ---- Step reviews (Step Review) ----
export const REVIEW_DBS = 5101;
export const reviews = {
  [REVIEW_DBS]: { object: "step_review", id: REVIEW_DBS, reviewed_by: USER_ALEX, status: "approved", from_status: "pending", message: "Checked against the register; call me on 07700 900456 if unsure.", created_at: stamp(22, 9, 0), updated_at: stamp(22, 9, 0) },
};

// ---- Records (Record) and their steps (Record Steps) ----
// A record's own `steps` carry the check/document/form as IDs and the review as null (pending),
// false (not reviewable) or an ID; GET /records/{id}/steps?expand=check,review expands them.
const photoIdStep = (id, check, docs = ["passport", "driving_licence", "national_id"], completed_at = null, review = null) => ({
  object: "step",
  id,
  type: "check.photo_id",
  preferences: { report_type: "standard", face: true, liveness: true, facial_similarity: false, live_document: false, docs, issuing_countries: null, right_to_work: null, right_to_rent: null },
  check,
  review,
  cost: 1,
  completed_at,
});
const mkRecord = (id, status, clientId, name, reference, email, steps, extra = {}) => ({
  object: "record",
  id,
  status,
  perform_url: `https://id.amiqus.co/i/test-perform-${id}`,
  email,
  client: clientId,
  name,
  reference,
  steps,
  has_reminders: true,
  created_at: stamp(20, 8, 22),
  updated_at: stamp(20, 8, 22),
  expired_at: stamp(30, 8, 22),
  archived_at: null,
  is_declaration_required: false,
  declaration_confirmed_at: null,
  ...extra,
});
const martin = named[0];
const jen = named[1];
const doc = named[2];
const namedRecords = [
  mkRecord(REC_MARTIN, "pending", CLIENT_MARTIN, martin.name, martin.reference, martin.email, [
    photoIdStep(2, CHECK_MARTIN_PENDING),
    // A document request whose instructions carry a phone number, to prove step preferences are redacted by default.
    { object: "step", id: 3, type: "document.request", preferences: { title: "Utility bill", instructions: "A utility bill dated within the last three months. Questions: 0117 496 0000." }, document: 23123, review: false, cost: 0, completed_at: null },
    { object: "step", id: 4, type: "form", form: "4bd9bfca-e61d-4a68-99b3-ca61a02f650f", review: false, cost: 0, completed_at: null },
  ]),
  mkRecord(
    REC_MARTIN_DONE,
    "complete",
    CLIENT_MARTIN,
    martin.name,
    martin.reference,
    martin.email,
    [
      photoIdStep(12, CHECK_MARTIN_PHOTO, ["passport"], stamp(21, 10, 5)),
      { object: "step", id: 13, type: "check.watchlist", preferences: { silent: true, monitor: false, search_profile: "peps_sanctions_media", all_entity_types: false }, check: CHECK_MARTIN_WATCHLIST, review: null, cost: 1, completed_at: stamp(21, 10, 6) },
      { object: "step", id: 14, type: "check.criminal_record", preferences: { region: "england", type: "standard", enable_payment: false }, check: CHECK_MARTIN_DBS, review: REVIEW_DBS, cost: 16, completed_at: stamp(21, 10, 7) },
    ],
    { perform_url: false, created_at: stamp(10, 9, 0), updated_at: stamp(22, 9, 0), expired_at: stamp(20, 9, 0) },
  ),
  mkRecord(REC_JEN, "waiting", CLIENT_JEN, jen.name, jen.reference, jen.email, [photoIdStep(22, CHECK_JEN_PHOTO, ["passport", "driving_licence"], stamp(23, 12, 0))], { created_at: stamp(18, 9, 0), updated_at: stamp(23, 12, 0) }),
  mkRecord(REC_DOC, "reviewed", CLIENT_DOC, doc.name, doc.reference, doc.email, [photoIdStep(32, CHECK_DOC_PHOTO, ["passport"], stamp(8, 15, 0), false)], {
    perform_url: false,
    created_at: stamp(5, 9, 0),
    updated_at: stamp(15, 16, 0),
    expired_at: stamp(15, 9, 0),
    archived_at: stamp(15, 16, 0),
  }),
];
// 109 more one-step records for the bulk clients so the list spans two pages of 100 (total 113).
const bulkRecords = bulk.slice(0, 109).map((c, i) => {
  const checkId = 90000 + i;
  checks[checkId] = mkCheck(checkId, "photo_id", 990000 + i, "pending", null, { created_at: c.created_at, updated_at: c.created_at });
  return mkRecord(990000 + i, i % 4 === 0 ? "started" : "pending", c.id, c.name, c.reference, c.email, [photoIdStep(1000 + i, checkId)], { created_at: c.created_at, updated_at: c.created_at, expired_at: stamp(28, 8, 0) });
});
export const records = [...namedRecords, ...bulkRecords];
// Creator and assignees per record (not part of the Record schema; the API filters on them).
export const recordMeta = {
  [REC_MARTIN]: { created_by: USER_ALEX, assignees: [USER_ALEX] },
  [REC_MARTIN_DONE]: { created_by: USER_ALEX, assignees: [] },
  [REC_JEN]: { created_by: USER_JO, assignees: [USER_JO] },
  [REC_DOC]: { created_by: USER_JO, assignees: [USER_ALEX] },
};

// ---- Templates (Record Template, Email Template, Document Template) ----
export const TEMPLATE_IDV = 43723;
export const TEMPLATE_STAFF = 43812;
export const recordTemplates = [
  {
    object: "record_template",
    id: TEMPLATE_IDV,
    name: "Identity verification",
    description: "Identity verification for new clients",
    presets: {
      steps: [
        { object: "preset_step", type: "check.photo_id", preferences: { report_type: "standard", face: true, liveness: true, facial_similarity: true, live_document: true, docs: ["passport", "driving_licence", "national_id"], issuing_countries: null, right_to_work: null, right_to_rent: null } },
        { object: "preset_step", type: "document.request", preferences: { template: 78432 } },
      ],
      notification: "email",
      // A preset message with an email address typed into it, to prove template text is redacted.
      message: "Please complete these steps to begin onboarding. Questions to onboarding@example.com.",
      reminder: true,
      is_declaration_required: false,
    },
    is_enabled: true,
    created_at: stamp(1, 14, 12),
    updated_at: stamp(1, 14, 12),
  },
  {
    object: "record_template",
    id: TEMPLATE_STAFF,
    name: "Staff onboarding",
    description: "Onboarding for new staff members",
    presets: {
      steps: [
        { object: "preset_step", type: "check.criminal_record", preferences: { region: "scotland", enable_payment: false } },
        { object: "preset_step", type: "check.photo_id", preferences: { report_type: "standard", face: true, liveness: true, facial_similarity: true, live_document: true, docs: ["passport", "driving_licence"] } },
        // The spec's Invalid preset step: a step the team can no longer run.
        { object: "invalid_preset_step", type: "check.watchlist", preferences: { silent: true }, errors: { type: ["Step type check.watchlist is not available for this team"] } },
      ],
      notification: false,
      message: "Welcome to the team, please complete the onboarding steps.",
      reminder: false,
      is_declaration_required: true,
      assignees: [USER_ALEX, USER_JO],
    },
    is_enabled: false,
    created_at: stamp(2, 11, 26),
    updated_at: stamp(2, 11, 26),
  },
];
export const emailTemplates = [
  { object: "email_template", id: 501, name: "New request", description: "Sent with every new record", content: "Hello, please complete your checks. Call us on 0131 496 0000 with any questions.", is_enabled: true, created_at: stamp(1, 9, 0), updated_at: stamp(1, 9, 0) },
];
export const documentTemplates = [
  { object: "document_template", id: 601, name: "Terms of business", description: "Standard terms for new clients", content: "These terms apply to every engagement. Contact terms@example.com to negotiate.", is_enabled: true, created_at: stamp(1, 9, 5), updated_at: stamp(1, 9, 5) },
  { object: "document_template", id: 602, name: "Old terms", description: "Retired 2025 terms", content: "Superseded.", is_enabled: false, created_at: stamp(1, 9, 6), updated_at: stamp(1, 9, 6) },
];

// ---- Webhooks (Webhook) ----
// A delivery URL with a token in its query string and a signing secret: neither may reach the assistant.
export const WEBHOOK_TOKEN = "hook-test-token-not-real";
export const WEBHOOK_SECRET_1 = "hook-signing-secret-not-real-0001";
export const WEBHOOK_SECRET_2 = "hook-signing-secret-not-real-0002";
export const webhooks = [
  { object: "webhook", id: 2154, uuid: "e4085749-1c11-4ac8-9361-df7f33c37ecb", url: `https://example.org/incoming/webhooks/amiqus?token=${WEBHOOK_TOKEN}`, secret: WEBHOOK_SECRET_1, events: ["client.*", "record.*"], is_enabled: true, created_at: stamp(2, 11, 26), updated_at: stamp(2, 11, 26) },
  { object: "webhook", id: 2159, uuid: "0c416908-3a4a-4ee5-96fb-a780783e8b64", url: "https://beta.example.org/webhooks/incoming", secret: WEBHOOK_SECRET_2, events: ["*"], is_enabled: false, created_at: stamp(2, 12, 5), updated_at: stamp(9, 12, 5) },
];

// ---- Case status aggregate ----
export const caseStatusAggregate = {
  object: "case_status_aggregate",
  aggregates: [
    { status: "awaiting_response", count: 12 },
    { status: "action_required", count: 4 },
    { status: "reviewed_pending_decision", count: 2 },
    { status: "approved", count: 59 },
    { status: "rejected", count: 5 },
    { status: "on_hold", count: 1 },
  ],
};
