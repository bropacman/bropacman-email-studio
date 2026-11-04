// Run with:  node --test tests/*.test.js
// Uses only Node's built-in test runner - no dependencies to install.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../sn-core.js");

const FIXTURES = path.join(__dirname, "..", "fixtures");
const combined = fs.readFileSync(path.join(FIXTURES, "sample_hr_notifications.xml"), "utf8");
const single = fs.readFileSync(path.join(FIXTURES, "single_notification.xml"), "utf8");

// The only normalization buildUnloadXml() applies: whitespace between the
// XML declaration, <unload ...>, the record and </unload> becomes a single
// LF, and the file ends with one LF. Implemented independently here (with
// regexes, not the scanner) so the test isn't checking the code against
// itself.
function normalizeWrapperWhitespace(xml) {
  return xml
    .replace(/^﻿?\s*(<\?xml[^>]*\?>)\s*/, "$1\n")
    .replace(/(<unload\b[^>]*>)\s*/, "$1\n")
    .replace(/\s*<\/unload>\s*$/, "\n</unload>\n");
}

test("splits the combined fixture into every record", () => {
  const u = C.splitUnload(combined);
  assert.equal(u.decl, '<?xml version="1.0" encoding="UTF-8"?>');
  assert.equal(u.unloadOpenTag, '<unload unload_date="2026-10-28 17:42:10">');
  const counts = {};
  u.records.forEach((r) => (counts[r.table] = (counts[r.table] || 0) + 1));
  assert.deepEqual(counts, {
    sys_email_layout: 1,
    sysevent_email_template: 1,
    sys_script_email: 2,
    sysevent_email_action: 5,
    sn_hr_core_email_content: 1,
    sn_cd_content_notification: 1,
  });
});

test("record slices are byte-identical substrings of the original", () => {
  const u = C.splitUnload(combined);
  let cursor = 0;
  for (const r of u.records) {
    const at = combined.indexOf(r.raw, cursor);
    assert.ok(at >= 0, "record not found verbatim in source");
    cursor = at + r.raw.length;
    assert.ok(r.raw.startsWith("<" + r.table));
    assert.ok(r.raw.endsWith("</" + r.table + ">"));
  }
});

test("unedited single-record file round-trips byte-identical (after wrapper whitespace normalization)", () => {
  const u = C.splitUnload(single);
  assert.equal(u.records.length, 1);
  const out = C.buildUnloadXml(u.decl, u.unloadOpenTag, [u.records[0].raw]);
  assert.equal(out, normalizeWrapperWhitespace(single));
});

test("every record in the combined fixture exports with its original bytes", () => {
  const u = C.splitUnload(combined);
  for (const r of u.records) {
    const out = C.buildUnloadXml(u.decl, u.unloadOpenTag, [r.raw]);
    const back = C.splitUnload(out);
    assert.equal(back.records.length, 1);
    assert.equal(back.records[0].raw, r.raw);
    assert.equal(back.unloadOpenTag, u.unloadOpenTag);
  }
});

test("CRLF exports keep their CRLFs inside the record", () => {
  const crlf = single.replace(/\n/g, "\r\n");
  const u = C.splitUnload(crlf);
  const out = C.buildUnloadXml(u.decl, u.unloadOpenTag, [u.records[0].raw]);
  assert.equal(out, normalizeWrapperWhitespace(crlf));
  assert.ok(u.records[0].raw.includes("\r\n"));
});

test("editing subject changes only the subject element", () => {
  const raw = C.splitUnload(single).records[0].raw;
  const edited = C.replaceField(raw, "subject", "Hello <b>&</b> welcome");
  assert.equal(C.readField(edited, "subject"), "Hello <b>&</b> welcome");
  assert.ok(edited.includes("<subject>Hello &lt;b&gt;&amp;&lt;/b&gt; welcome</subject>"));
  // Everything before and after the subject element is untouched.
  const start = raw.indexOf("<subject>");
  const end = raw.indexOf("</subject>") + "</subject>".length;
  assert.equal(edited.slice(0, start), raw.slice(0, start));
  assert.equal(edited.slice(edited.length - (raw.length - end)), raw.slice(end));
  // Protected fields are unchanged.
  for (const f of ["sys_id", "sys_updated_on", "sys_mod_count", "message_html"]) {
    assert.equal(C.readField(edited, f), C.readField(raw, f), f);
  }
});

test("editing message_html round-trips through escaping", () => {
  const raw = C.splitUnload(single).records[0].raw;
  const html = '<p>New ${subject_person.first_name} &amp; "quotes"</p>\n${mail_script:hr_portal_link}';
  const edited = C.replaceField(raw, "message_html", html);
  assert.equal(C.readField(edited, "message_html"), html);
  const reparsed = C.splitUnload(C.buildUnloadXml(null, "<unload>", [edited]));
  assert.equal(C.readField(reparsed.records[0].raw, "message_html"), html);
});

test("replacing a self-closing field fills it in; clearing restores <x/>", () => {
  const u = C.splitUnload(combined);
  const assigned = u.records.find((r) => C.readField(r.raw, "name") === "Sample - HR case assigned to agent").raw;
  assert.ok(assigned.includes("<subject/>"));
  const filled = C.replaceField(assigned, "subject", "Hi");
  assert.ok(filled.includes("<subject>Hi</subject>"));
  assert.equal(C.replaceField(filled, "subject", ""), assigned);
});

test("setting a field to its current value is a no-op", () => {
  const raw = C.splitUnload(single).records[0].raw;
  // replaceField escapes & < > only; the fixture's subject has none of
  // those, so re-writing it must give back identical bytes.
  assert.equal(C.replaceField(raw, "subject", C.readField(raw, "subject")), raw);
});

test("CDATA fields are read correctly and survive untouched", () => {
  const u = C.splitUnload(combined);
  const script = u.records.find((r) => r.table === "sys_script_email");
  assert.ok(script.raw.includes("<![CDATA["));
  assert.match(C.readField(script.raw, "script"), /template\.print\('<a href="'/);
});

test("rejects files without an <unload> root", () => {
  assert.throws(() => C.splitUnload("<xml><a/></xml>"), /no <unload> root/);
});

test("condition translation: AND, OR, NQ and common operators", () => {
  const t = C.translateCondition(
    "hr_service.nameSTARTSWITHOnboarding^ORhr_service.nameLIKEnew hire^active=true^NQpriority=1^stateIN10,18^EQ"
  );
  assert.equal(
    t.text,
    '[1] (hr_service.name starts with "Onboarding" OR hr_service.name contains "new hire") AND active is "true"' +
      ' OR [2] priority is "1" AND state is one of "10", "18"'
  );
  const cases = {
    "stateISEMPTY": "state is empty",
    "stateISNOTEMPTY": "state is not empty",
    "assigned_toVALCHANGES": "assigned_to changes",
    "stateCHANGESTO3": 'state changes to "3"',
    "stateCHANGESFROM2": 'state changes from "2"',
    "priority!=4": 'priority is not "4"',
    "stateNOT IN6,7": 'state is not one of "6", "7"',
    "short_descriptionNOT LIKEtest": 'short_description does not contain "test"',
    "assigned_to=javascript:gs.getUserID()": "assigned_to is (script value: javascript:gs.getUserID())",
    "u_weird_opXYZ": "(untranslated: u_weird_opXYZ)",
  };
  for (const [q, expected] of Object.entries(cases)) {
    assert.equal(C.translateCondition(q).text, expected, q);
  }
  assert.equal(C.translateCondition("").text, "");
  assert.equal(C.translateCondition("active=true^ORDERBYnumber^EQ").text, 'active is "true"');
});

test("trigger and recipient summaries", () => {
  assert.equal(
    C.triggerSummary({ collection: "x", action_insert: "true", action_update: "true", condition: "a=1" }),
    'x: when a record is inserted or updated; if a is "1"'
  );
  assert.equal(
    C.triggerSummary({ collection: "x", generation_type: "event", event_name: "e.fired", advanced_condition: "answer=true" }),
    'x: when event "e.fired" fires; plus custom script logic (ask HRIT)'
  );
  assert.equal(
    C.recipientsSummary({ recipient_fields: "a,b", recipient_groups: "g1", event_parm_1: "true", send_self: "true" }),
    "Fields: a, b; Groups: g1; Event parm 1 contains recipient; Also sent to event creator (send_self)"
  );
  assert.equal(C.recipientsSummary({}), "(no recipients configured)");
});

test("variable discovery, sample values and filling", () => {
  const html = "<p>${number} ${opened_for.name} ${mail_script:x} ${notification:body} ${unknown_thing}</p>";
  const found = C.findVariables(html);
  assert.deepEqual(found.variables, ["number", "opened_for.name", "unknown_thing"]);
  assert.deepEqual(found.mailScripts, ["x"]);
  assert.equal(C.defaultSampleValue("opened_for.name"), "Jane Sample");
  assert.equal(C.defaultSampleValue("assigned_to.first_name"), "Jane");
  assert.equal(C.defaultSampleValue("number"), "HRC0001234");
  const out = C.fillHtml(html, { number: "HRC1", "opened_for.name": "<Jane>" });
  assert.match(out, /HRC1 &lt;Jane&gt;/);
  assert.match(out, /\[Dynamic content: x\]/);
  assert.match(out, /\$\{unknown_thing\}/);
  assert.equal(C.fillText("Case ${number} ${mail_script:x}", { number: "HRC1" }), "Case HRC1 [Dynamic content: x]");
});

test("CSV escapes quotes and guards formulas", () => {
  const csv = C.toCsv([["a", 'b "c"'], ["=SUM(1)", "-x"]]);
  assert.equal(csv, '﻿"a","b ""c"""\r\n"\'=SUM(1)","\'-x"\r\n');
  assert.equal(C.toTsv([["a\tb", "c\nd"]]), "a b\tc d\n");
});

test("condition fields with <item> children read as just the encoded query", () => {
  const u = C.splitUnload(combined);
  const r = u.records.find((x) => x.raw.includes("<sys_id>4d5e6f708192a3b4c5d6e7f8091a2b3c</sys_id>"));
  assert.ok(r.raw.includes("<item "));
  assert.equal(
    C.readField(r.raw, "condition"),
    "assigned_toVALCHANGES^assigned_toISNOTEMPTY^hr_service=9f8e7d6c5b4a39281706f5e4d3c2b1a0^EQ"
  );
  // The nested items don't confuse field boundaries for later fields.
  assert.equal(C.readField(r.raw, "sys_id"), "4d5e6f708192a3b4c5d6e7f8091a2b3c");
  assert.deepEqual(
    C.conditionDisplayValues([{ field: "hr_service", operator: "=", value: "abc", display_value: "General Inquiry" }]),
    { "hr_service|=|abc": "General Inquiry" }
  );
  assert.equal(
    C.translateCondition("hr_service=abc^active=true", { "hr_service|=|abc": "General Inquiry" }).text,
    'hr_service is "abc" (General Inquiry) AND active is "true"'
  );
});

test("editing a CDATA field keeps it as CDATA", () => {
  const raw = C.splitUnload(single).records[0].raw;
  assert.ok(raw.includes("<message_html><![CDATA["));
  const edited = C.replaceField(raw, "message_html", "<p>New & improved</p>");
  assert.ok(edited.includes("<message_html><![CDATA[<p>New & improved</p>]]></message_html>"));
  // A value containing ]]> can't go in CDATA, so it falls back to escaping.
  const tricky = C.replaceField(raw, "message_html", "a ]]> b");
  assert.ok(tricky.includes("<message_html>a ]]&gt; b</message_html>"));
  assert.equal(C.readField(tricky, "message_html"), "a ]]> b");
});

test("fixtures/demo-data.js is in sync with the XML fixture", () => {
  const src = fs.readFileSync(path.join(FIXTURES, "demo-data.js"), "utf8");
  const json = /window\.SN_DEMO_XML = (".*");\s*$/.exec(src)[1];
  assert.equal(JSON.parse(json), combined.replace(/\r\n/g, "\n"), "run: node scripts/build-demo-data.js");
});

test("images become a [Logo] label (all, or only relative URLs)", () => {
  const html =
    '<td><img src="/sys_attachment.do?sys_id=1" alt="Beacon"> HR</td>' +
    "<p><img src='https://cdn.example.com/x.png' alt='x'><img src=logo.pngx></p>";
  assert.equal(C.imagesToPlaceholder(html), "<td><span>[Logo]</span> HR</td><p><span>[Logo]</span><span>[Logo]</span></p>");
  assert.equal(
    C.imagesToPlaceholder(html, C.isRelativeUrl),
    "<td><span>[Logo]</span> HR</td><p><img src='https://cdn.example.com/x.png' alt='x'><span>[Logo]</span></p>"
  );
  assert.equal(C.isRelativeUrl("data:image/png;base64,AA"), false);
  assert.equal(C.isRelativeUrl("//cdn.example.com/a.png"), false);
  assert.equal(C.isRelativeUrl("assets/banner.png"), true);
});

test("fillHtml can show ${variable} names instead of sample values", () => {
  const out = C.fillHtml("<p>${number} for ${opened_for.name} ${mail_script:x}</p>", { number: "HRC1" }, { showNames: true });
  assert.match(out, />\$\{number\}<\/span>/);
  assert.match(out, />\$\{opened_for\.name\}<\/span>/);
  assert.doesNotMatch(out, /HRC1/);
  assert.match(out, /\[Dynamic content: x\]/);
});

test("index.html is stamped with the current build version", () => {
  const V = require("../scripts/stamp-version.js");
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.deepEqual(V.stampedVersions(html), [V.computeVersion()], "run: node scripts/stamp-version.js");
});

test("cover page helpers: export date and safe links", () => {
  assert.equal(C.parseUnloadDate('<unload unload_date="2026-11-04 01:46:40">'), "2026-11-04 01:46:40");
  assert.equal(C.parseUnloadDate("<unload>"), "");
  assert.equal(C.safeHttpUrl("https://docs.google.com/document/d/abc"), "https://docs.google.com/document/d/abc");
  assert.equal(C.safeHttpUrl("docs.google.com/spreadsheets/d/x"), "https://docs.google.com/spreadsheets/d/x");
  assert.equal(C.safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(C.safeHttpUrl("data:text/html,hi"), null);
  assert.equal(C.safeHttpUrl("not a link"), null);
  assert.equal(C.safeHttpUrl(""), null);
});

test("mail scripts can show a typed-in example instead of the placeholder", () => {
  const html = "<p>${mail_script:signature}</p><p>${mail_script:other}</p>";
  const out = C.fillHtml(html, {}, { scriptExamples: { signature: "Thanks,\nHR <Team>", other: "   " } });
  assert.match(out, /Thanks,<br>HR &lt;Team&gt;<\/span>/);
  assert.match(out, /dashed/);
  assert.doesNotMatch(out, /Dynamic content: signature/);
  // Blank examples (and scripts without one) keep the placeholder box.
  assert.match(out, /\[Dynamic content: other\]/);
  assert.match(C.fillHtml(html, {}), /\[Dynamic content: signature\]/);
});

test("friendly labels for fields and tables", () => {
  const f = C.friendlyField;
  assert.equal(f("opened_for"), "Opened for");
  assert.equal(f("u_start_date"), "Start date");
  assert.equal(f("opened_for.first_name"), "Opened for › First name");
  assert.equal(f("subject_person.manager.name"), "Subject person › Manager › Name");
  assert.equal(f("hr_service"), "HR service");
  assert.equal(f("u_employee_id"), "Employee ID");
  assert.equal(f("sys_updated_on"), "Updated");
  assert.equal(f("active"), "Active");
  const t = C.friendlyTable;
  assert.equal(t("sn_hr_core_case"), "HR Case");
  assert.equal(t("sn_hr_core_case_benefits"), "HR Case Benefits");
  assert.equal(t("sn_hr_core_task"), "HR Task");
  assert.equal(t("sn_hr_le_case"), "Lifecycle Event Case");
  assert.equal(t("sys_user"), "User");
  assert.equal(t("u_hr_requests"), "HR Requests");
  assert.equal(t("x_acme_hrapp_onboarding_task"), "Onboarding Task");
});

test("summaries can use friendly labels", () => {
  const n = {
    collection: "sn_hr_core_case",
    action_insert: "true",
    condition: "transferred_fromISEMPTY^hr_service=abc^ORopened_for.u_start_dateISNOTEMPTY^stateNSAMEASu_prior_state",
    recipient_fields: "opened_for,watch_list",
    send_self: "true",
  };
  assert.equal(
    C.triggerSummary(n, { "hr_service|=|abc": "General Inquiry" }, { friendly: true }),
    'HR Case: when a record is inserted; if Transferred from is empty AND (HR service is "abc" (General Inquiry) OR ' +
      "Opened for › Start date is not empty) AND State is different from field Prior state"
  );
  assert.equal(C.recipientsSummary(n, { friendly: true }), "Fields: Opened for, Watch list; Also sent to event creator");
  // Without the option, technical names are unchanged.
  assert.match(C.triggerSummary(n), /^sn_hr_core_case: .* transferred_from is empty/);
});

test("CSV parser handles quotes, embedded newlines, CRLF, BOM and TSV", () => {
  const csv = '\uFEFF"Type","Name","Meaning / what it does","Example"\r\n"Mail script","sig","Signature, team","Thanks,\nHR ""Team"""\r\n';
  assert.deepEqual(C.parseCsv(csv), [
    ["Type", "Name", "Meaning / what it does", "Example"],
    ["Mail script", "sig", "Signature, team", 'Thanks,\nHR "Team"'],
  ]);
  assert.deepEqual(C.parseCsv("a\tb\nc\td\n"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(C.parseCsv("a,b\n\n,\n"), [["a", "b"]]);
});

test("glossary round-trips through CSV and reads back what was typed", () => {
  const rows = [
    C.GLOSSARY_HEADER,
    ["Mail script", "signature_HRcase_bps_cob", "Signature block", "Thanks,\nHR", "14 notifications"],
    ["Mail script", "headline_cob_notification", "", "", "9 notifications"],
    ["Variable", "${opened_for.first_name}", "Employee's first name", "Jane", "22 notifications"],
    ["Variable", "${number}", "", "-5", "3 notifications"],
    ["", "", "", "", ""],
  ];
  const g = C.readGlossary(C.parseCsv(C.toCsv(rows)));
  assert.deepEqual(g.mailScripts, { signature_HRcase_bps_cob: { description: "Signature block", example: "Thanks,\nHR" } });
  // The formula guard's apostrophe on "-5" is removed again on import.
  assert.deepEqual(g.variables, { "opened_for.first_name": { meaning: "Employee's first name", example: "Jane" }, number: { example: "-5" } });
  // Columns can be reordered or renamed slightly, and Type can be missing.
  const loose = C.readGlossary([["Name", "Description", "Example"], ["${x}", "An x", "1"], ["my_script", "Does y", ""]]);
  assert.deepEqual(loose.variables, { x: { meaning: "An x", example: "1" } });
  assert.deepEqual(loose.mailScripts, { my_script: { description: "Does y" } });
  assert.throws(() => C.readGlossary([["Foo"], ["bar"]]), /No "Name" column/);
});

test("HR email content and content delivery: summaries say where it's configured", () => {
  const content = { __source: "sn_hr_core_email_content", collection: "sn_hr_le_case", type: "activity_notification" };
  assert.equal(
    C.triggerSummary(content, null, { friendly: true }),
    "Lifecycle Event Case: sent by an HR Lifecycle Event activity (Activity notification); when it sends is set on that activity"
  );
  assert.equal(C.recipientsSummary(content), "Set on the Lifecycle Event activity that sends it");
  const cd = { sys_class_name: "sn_cd_content_notification", state: "draft", user_reference_table: "sys_user" };
  assert.equal(
    C.triggerSummary(cd, null, { friendly: true }),
    "Content delivery: sent by Content Delivery on the schedule set in Content Publishing (state: Draft)"
  );
  assert.equal(C.recipientsSummary(cd, { friendly: true }), "The audience chosen in Content Publishing (User records)");
  assert.equal(C.SOURCES.sn_cd_content_notification.body, "rich_text_plain_html");
});

test("content delivery body edits keep CDATA and change only that field", () => {
  const u = C.splitUnload(combined);
  const raw = u.records.find((r) => r.table === "sn_cd_content_notification").raw;
  const edited = C.replaceField(raw, "rich_text_plain_html", "<p>New wording</p>");
  assert.ok(edited.includes("<rich_text_plain_html><![CDATA[<p>New wording</p>]]></rich_text_plain_html>"));
  for (const f of ["sys_id", "sys_updated_on", "sys_mod_count", "subject", "title", "state"]) {
    assert.equal(C.readField(edited, f), C.readField(raw, f), f);
  }
  const back = C.splitUnload(C.buildUnloadXml(u.decl, u.unloadOpenTag, [raw]));
  assert.equal(back.records[0].raw, raw);
});

test("inventory CSV: categories are read by sys_id; glossary CSVs aren't mistaken for it", () => {
  const rows = C.parseCsv(
    C.toCsv([
      ["Name", "Source", "Category", "Category source", "sys_id"],
      ["Welcome content", "HR email content", "Onboarding", "Not assigned", "9A0B1C2D3E4F5A6B7C8D9E0F1A2B3C4D"],
      ["Reminder", "Content delivery", "", "Not assigned", "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5"],
      ["Bad id", "Content delivery", "X", "", "not-a-sys-id"],
    ])
  );
  assert.deepEqual(C.readInventoryCategories(rows), { "9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d": "Onboarding" });
  assert.equal(C.readInventoryCategories([C.GLOSSARY_HEADER, ["Variable", "${x}", "", "", ""]]), null);
});
