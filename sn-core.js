/*
 * sn-core.js - DOM-free helpers for working with ServiceNow XML exports.
 *
 * Loaded as a plain <script> in the browser (exposes window.SNCore) and as a
 * CommonJS module by the Node tests in tests/. Nothing in here touches the
 * network, storage, or the DOM, so it can be unit tested without a browser.
 *
 * Covers:
 *   - splitting an <unload> export into raw, byte-exact record slices
 *   - reading and replacing a single field inside a raw record
 *   - rebuilding a single-record, ServiceNow-importable XML file
 *   - translating encoded queries (the `condition` field) into plain English
 *   - trigger / recipient summaries, ${variable} discovery and substitution
 *   - CSV / TSV output
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SNCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Raw XML scanning
  //
  // DOMParser is great for reading values but can't give back the original
  // bytes of a record, and re-serializing a DOM changes quoting, escaping and
  // whitespace. For the "download updated XML" round trip we need to change
  // one field and leave every other byte alone, so we find element
  // boundaries ourselves with a tiny scanner that understands just enough
  // XML: tags (with quoted attribute values), CDATA, comments and
  // processing instructions.
  // ---------------------------------------------------------------------

  function findTagEnd(text, lt) {
    let quote = null;
    for (let i = lt + 1; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        return i;
      }
    }
    throw new Error("Unterminated tag at offset " + lt);
  }

  // Returns the direct child elements found between [from, to).
  // Each: { name, start, openEnd, closeStart, end, selfClosing }.
  function scanChildren(text, from, to) {
    const out = [];
    let i = from;
    let depth = 0;
    let cur = null;
    while (i < to) {
      const lt = text.indexOf("<", i);
      if (lt === -1 || lt >= to) break;
      if (text.startsWith("<![CDATA[", lt)) {
        const e = text.indexOf("]]>", lt + 9);
        if (e === -1) throw new Error("Unterminated CDATA at offset " + lt);
        i = e + 3;
        continue;
      }
      if (text.startsWith("<!--", lt)) {
        const e = text.indexOf("-->", lt + 4);
        if (e === -1) throw new Error("Unterminated comment at offset " + lt);
        i = e + 3;
        continue;
      }
      if (text.startsWith("<?", lt)) {
        const e = text.indexOf("?>", lt + 2);
        if (e === -1) throw new Error("Unterminated processing instruction at offset " + lt);
        i = e + 2;
        continue;
      }
      if (text.startsWith("<!", lt)) {
        i = findTagEnd(text, lt) + 1;
        continue;
      }
      const tagEnd = findTagEnd(text, lt);
      if (text[lt + 1] === "/") {
        depth--;
        if (depth < 0) break;
        if (depth === 0 && cur) {
          cur.closeStart = lt;
          cur.end = tagEnd + 1;
          out.push(cur);
          cur = null;
        }
        i = tagEnd + 1;
        continue;
      }
      const selfClosing = text[tagEnd - 1] === "/";
      const name = /^<([^\s/>]+)/.exec(text.slice(lt, tagEnd + 1))[1];
      if (depth === 0) {
        cur = { name, start: lt, openEnd: tagEnd + 1, selfClosing };
        if (selfClosing) {
          cur.closeStart = tagEnd + 1;
          cur.end = tagEnd + 1;
          out.push(cur);
          cur = null;
        }
      }
      if (!selfClosing) depth++;
      i = tagEnd + 1;
    }
    if (cur) throw new Error("Unclosed element <" + cur.name + "> at offset " + cur.start);
    return out;
  }

  // Splits a ServiceNow <unload> export into its records, keeping each
  // record's exact original text.
  function splitUnload(text) {
    const declMatch = /^﻿?\s*(<\?xml[\s\S]*?\?>)/.exec(text);
    const top = scanChildren(text, 0, text.length);
    const root = top.find((e) => e.name === "unload");
    if (!root) throw new Error("Not a ServiceNow export: no <unload> root element found.");
    const unloadOpenTag = text.slice(root.start, root.openEnd);
    const children = root.selfClosing ? [] : scanChildren(text, root.openEnd, root.closeStart);
    return {
      decl: declMatch ? declMatch[1] : null,
      unloadOpenTag,
      records: children.map((c) => ({ table: c.name, raw: text.slice(c.start, c.end) })),
    };
  }

  function recordFields(raw) {
    const rec = scanChildren(raw, 0, raw.length)[0];
    if (!rec) throw new Error("Empty record");
    return { rec, fields: rec.selfClosing ? [] : scanChildren(raw, rec.openEnd, rec.closeStart) };
  }

  function decodeXmlText(s) {
    let out = "";
    const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
    let last = 0;
    let m;
    // Outside CDATA, any "<" is markup (text content has it escaped), e.g.
    // the <item .../> children ServiceNow appends inside <condition>. Only
    // the field's own text is wanted, so drop those child elements.
    let hadChildren = false;
    const text = (seg) =>
      decodeEntities(
        seg.replace(/<[^>]*>/g, () => {
          hadChildren = true;
          return "";
        })
      );
    while ((m = re.exec(s))) {
      out += text(s.slice(last, m.index)) + m[1];
      last = re.lastIndex;
    }
    out += text(s.slice(last));
    return hadChildren ? out.trim() : out;
  }

  // Reads display labels ServiceNow stores on the <item> children of a
  // <condition> field, keyed "field|operator|value" -> display_value.
  function conditionDisplayValues(items) {
    const map = {};
    (items || []).forEach((it) => {
      if (it.display_value) map[`${it.field}|${it.operator}|${it.value}`] = it.display_value;
    });
    return map;
  }

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (all, e) => {
      if (e === "lt") return "<";
      if (e === "gt") return ">";
      if (e === "amp") return "&";
      if (e === "quot") return '"';
      if (e === "apos") return "'";
      if (e[1] === "x") return String.fromCodePoint(parseInt(e.slice(2), 16));
      return String.fromCodePoint(parseInt(e.slice(1), 10));
    });
  }

  // Reads a field's decoded text value straight from the raw record (used by
  // the Node tests; the browser uses DOMParser for reading).
  function readField(raw, name) {
    const { fields } = recordFields(raw);
    const f = fields.find((x) => x.name === name);
    if (!f) return undefined;
    return f.selfClosing ? "" : decodeXmlText(raw.slice(f.openEnd, f.closeStart));
  }

  function escapeXmlText(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Replaces one direct-child field of a raw record, leaving every other
  // byte untouched (including the field's own start tag and attributes).
  function replaceField(raw, name, value) {
    const { rec, fields } = recordFields(raw);
    const f = fields.find((x) => x.name === name);
    const v = String(value);
    if (!f) {
      const insert = v === "" ? `<${name}/>` : `<${name}>${escapeXmlText(v)}</${name}>`;
      return raw.slice(0, rec.closeStart) + insert + "\n" + raw.slice(rec.closeStart);
    }
    let replacement;
    if (v === "") {
      replacement = f.selfClosing ? raw.slice(f.start, f.end) : `<${name}/>`;
    } else {
      let openTag = raw.slice(f.start, f.openEnd);
      if (f.selfClosing) openTag = openTag.replace(/\s*\/>$/, ">");
      // ServiceNow exports HTML/script fields as CDATA; keep that style when
      // the original used it so the diff in the downloaded file stays small.
      const wasCdata = !f.selfClosing && raw.startsWith("<![CDATA[", f.openEnd);
      const body = wasCdata && !v.includes("]]>") ? `<![CDATA[${v}]]>` : escapeXmlText(v);
      replacement = openTag + body + `</${name}>`;
    }
    return raw.slice(0, f.start) + replacement + raw.slice(f.end);
  }

  // Single-record export. The record text is copied verbatim; only the
  // wrapper is rebuilt: XML declaration, the original <unload ...> start
  // tag, the record and </unload>, each on its own line with LF line
  // endings and a trailing newline. That wrapper whitespace is the only
  // normalization applied (see README "Round-trip guarantees").
  function buildUnloadXml(decl, unloadOpenTag, recordRaws) {
    return (
      (decl || '<?xml version="1.0" encoding="UTF-8"?>') +
      "\n" +
      (unloadOpenTag || "<unload>") +
      "\n" +
      recordRaws.join("\n") +
      "\n</unload>\n"
    );
  }

  // ---------------------------------------------------------------------
  // Friendly labels for business readers
  //
  // Derived from the technical name - no dictionary export needed:
  //   fields: drop a leading u_, underscores -> spaces, sentence case,
  //           acronyms upper-cased, dot-walks joined with " › "
  //           (opened_for.first_name -> "Opened for › First name")
  //   tables: same, Title Case, with the scope prefix dropped
  //           (sn_hr_core_case -> "HR Case"), plus a few standard tables
  //           whose label doesn't follow the name.
  // ---------------------------------------------------------------------

  const ACRONYMS = new Set(["hr", "id", "url", "uri", "sla", "it", "pdf", "sms", "api", "ui", "pto", "vip", "faq", "kb", "csv", "ip", "le"]);

  const FIELD_LABELS = {
    sys_updated_on: "Updated",
    sys_created_on: "Created",
    sys_updated_by: "Updated by",
    sys_created_by: "Created by",
    sys_id: "Sys ID",
    sys_class_name: "Class",
    sys_mod_count: "Updates",
    sys_domain: "Domain",
  };

  const TABLE_LABELS = {
    task: "Task",
    sys_user: "User",
    sys_user_group: "Group",
    incident: "Incident",
    sc_request: "Request",
    sc_req_item: "Requested Item",
    sc_task: "Catalog Task",
    sn_hr_le_case: "Lifecycle Event Case",
  };

  function words(name) {
    return String(name || "")
      .replace(/^u_/, "")
      .split("_")
      .filter(Boolean)
      .map((w) => w.toLowerCase());
  }

  function upperFirst(w) {
    return w ? w[0].toUpperCase() + w.slice(1) : w;
  }

  function friendlySegment(seg) {
    if (FIELD_LABELS[seg]) return FIELD_LABELS[seg];
    const ws = words(seg);
    if (!ws.length) return seg;
    return ws.map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? upperFirst(w) : w)).join(" ");
  }

  function friendlyField(path) {
    if (!path) return path;
    return String(path).split(".").map(friendlySegment).join(" › ");
  }

  function friendlyTable(name) {
    const t = String(name || "").trim();
    if (!t) return t;
    if (TABLE_LABELS[t]) return TABLE_LABELS[t];
    let rest = t;
    let prefix = "";
    const hr = /^sn_hr_(?:core_|le_|sp_)?(.*)$/.exec(t);
    if (hr) {
      rest = hr[1];
      if (!/^hr(_|$)/.test(rest)) prefix = "HR ";
    } else {
      rest = t.replace(/^x_[a-z0-9]+_[a-z0-9]+_/, "").replace(/^sn_[a-z0-9]+_/, "");
    }
    const label = words(rest)
      .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : upperFirst(w)))
      .join(" ");
    return (prefix + label).trim() || t;
  }

  // ---------------------------------------------------------------------
  // Encoded query -> plain English
  // ---------------------------------------------------------------------

  // Order matters: longer operators must come before their prefixes.
  const OPERATORS = [
    ["ISNOTEMPTY", () => "is not empty"],
    ["ISEMPTY", () => "is empty"],
    ["EMPTYSTRING", () => "is an empty string"],
    ["ANYTHING", () => "is anything"],
    ["VALCHANGES", () => "changes"],
    ["CHANGESFROM", (v) => `changes from ${q(v)}`],
    ["CHANGESTO", (v) => `changes to ${q(v)}`],
    ["CHANGES", () => "changes"],
    ["STARTSWITH", (v) => `starts with ${q(v)}`],
    ["ENDSWITH", (v) => `ends with ${q(v)}`],
    ["NOT LIKE", (v) => `does not contain ${q(v)}`],
    ["NOTLIKE", (v) => `does not contain ${q(v)}`],
    ["LIKE", (v) => `contains ${q(v)}`],
    ["NOT IN", (v) => `is not one of ${list(v)}`],
    ["NSAMEAS", (v, name) => `is different from field ${name(v)}`],
    ["SAMEAS", (v, name) => `is the same as field ${name(v)}`],
    ["BETWEEN", (v) => `is between ${v.split("@").map(q).join(" and ")}`],
    ["NOTON", (v) => `is not on ${q(dateLabel(v))}`],
    ["ON", (v) => `is on ${q(dateLabel(v))}`],
    ["DYNAMIC", (v) => `matches dynamic filter ${q(v)}`],
    ["IN", (v) => `is one of ${list(v)}`],
    ["!=", (v) => `is not ${q(v)}`],
    [">=", (v) => `is at least ${q(v)}`],
    ["<=", (v) => `is at most ${q(v)}`],
    [">", (v) => `is greater than ${q(v)}`],
    ["<", (v) => `is less than ${q(v)}`],
    ["=", (v) => `is ${q(v)}`],
  ];

  const OP_RE = new RegExp(
    "^([a-z0-9_.$]+?)(" + OPERATORS.map(([op]) => op.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")([\\s\\S]*)$"
  );

  function q(v) {
    if (/^javascript:/i.test(v)) return `(script value: ${v})`;
    return `"${v}"`;
  }
  function list(v) {
    return v.split(",").map((x) => q(x.trim())).join(", ");
  }
  function dateLabel(v) {
    return v.split("@")[0];
  }

  // displayValues (optional): labels the export itself carried for
  // reference values, keyed "field|operator|value" (see
  // conditionDisplayValues). opts.friendly shows field names as friendly
  // labels (see friendlyField); otherwise they're shown as-is.
  function translateTerm(term, displayValues, opts) {
    const m = OP_RE.exec(term);
    if (!m) return { field: null, text: `(untranslated: ${term})`, raw: term };
    const [, field, op, value] = m;
    const friendly = !!(opts && opts.friendly);
    const name = friendly ? friendlyField : (x) => x;
    const fn = OPERATORS.find(([o]) => o === op)[1];
    const label = displayValues && displayValues[`${field}|${op}|${value}`];
    const fieldLabel = name(field);
    const phrase = fn(value, name);
    return { field, fieldLabel, op, value, label, phrase, text: `${fieldLabel} ${phrase}` + (label ? ` (${label})` : ""), raw: term };
  }

  // Returns { queries: [ [ [term, ...OR'd], ...AND'd ], ...NQ OR'd ], text, notes }.
  // ^OR binds tighter than ^ (a^ORb^c means (a OR b) AND c), and ^NQ starts a
  // whole new query that is OR'd with the previous ones.
  function translateCondition(encoded, displayValues, opts) {
    const src = (encoded || "").trim();
    if (!src) return { queries: [], text: "", notes: [] };
    const notes = [];
    const queries = src.split("^NQ").map((part) => {
      const clauses = [];
      part.split("^").forEach((tok, idx) => {
        if (!tok || tok === "EQ") return;
        if (/^ORDERBY/.test(tok)) return;
        if (/^RLQUERY/.test(tok) || /^ENDRLQUERY/.test(tok)) {
          notes.push("Contains a related-list query, which is not translated.");
          clauses.push([{ field: null, text: `(untranslated: ${tok})`, raw: tok }]);
          return;
        }
        if (idx > 0 && /^OR(?![A-Z]*BY)/.test(tok) && clauses.length) {
          clauses[clauses.length - 1].push(translateTerm(tok.slice(2), displayValues, opts));
          return;
        }
        clauses.push([translateTerm(tok, displayValues, opts)]);
      });
      return clauses;
    });
    const queryText = (clauses) =>
      clauses
        .map((ors) => (ors.length > 1 ? "(" + ors.map((t) => t.text).join(" OR ") + ")" : ors[0].text))
        .join(" AND ");
    const parts = queries.filter((c) => c.length).map(queryText);
    const text = parts.length > 1 ? parts.map((p, i) => `[${i + 1}] ${p}`).join(" OR ") : parts[0] || "";
    return { queries, text, notes: [...new Set(notes)] };
  }

  // ---------------------------------------------------------------------
  // Summaries
  // ---------------------------------------------------------------------

  function isTrue(v) {
    return v === true || v === "true" || v === "1";
  }

  function splitList(v) {
    return (v || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // n: flat object of notification field values.
  function triggerParts(n) {
    const gen = (n.generation_type || "").trim();
    const parts = [];
    if (gen === "event" || (!gen && n.event_name && !isTrue(n.action_insert) && !isTrue(n.action_update))) {
      parts.push(n.event_name ? `when event "${n.event_name}" fires` : "when an event fires (no event name set)");
    } else if (gen === "triggered") {
      parts.push("only when triggered by a flow or script");
    } else {
      const ins = isTrue(n.action_insert);
      const upd = isTrue(n.action_update);
      if (ins && upd) parts.push("when a record is inserted or updated");
      else if (ins) parts.push("when a record is inserted");
      else if (upd) parts.push("when a record is updated");
      else parts.push("never on insert/update (both are unchecked)");
    }
    return parts;
  }

  function hasAdvancedCondition(n) {
    return !!(n.advanced_condition || "").trim();
  }

  // opts.friendly: table and field names as friendly labels.
  function triggerSummary(n, displayValues, opts) {
    const friendly = !!(opts && opts.friendly);
    const cond = translateCondition(n.condition, displayValues, opts);
    const table = n.collection ? (friendly ? friendlyTable(n.collection) : n.collection) : "(no table)";
    let s = `${table}: ${triggerParts(n).join(", ")}`;
    if (cond.text) s += `; if ${cond.text}`;
    if (hasAdvancedCondition(n)) s += "; plus custom script logic (ask HRIT)";
    return s;
  }

  function recipientsSummary(n, opts) {
    const bits = [];
    const fields = splitList(n.recipient_fields).map((f) => (opts && opts.friendly ? friendlyField(f) : f));
    const users = splitList(n.recipient_users);
    const groups = splitList(n.recipient_groups);
    if (fields.length) bits.push(`Fields: ${fields.join(", ")}`);
    if (users.length) bits.push(`Users: ${users.join(", ")}`);
    if (groups.length) bits.push(`Groups: ${groups.join(", ")}`);
    if (isTrue(n.event_parm_1)) bits.push("Event parm 1 contains recipient");
    if (isTrue(n.event_parm_2)) bits.push("Event parm 2 contains recipient");
    if (isTrue(n.send_self)) bits.push(opts && opts.friendly ? "Also sent to event creator" : "Also sent to event creator (send_self)");
    return bits.length ? bits.join("; ") : "(no recipients configured)";
  }

  // ---------------------------------------------------------------------
  // ${variables}
  // ---------------------------------------------------------------------

  const VAR_RE = /\$\{([^}]+)\}/g;

  function findVariables(text) {
    const vars = new Set();
    const scripts = new Set();
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(text || ""))) {
      const token = m[1].trim();
      if (/^mail_script:/i.test(token)) scripts.add(token.slice(12).trim());
      else if (/^notification:/i.test(token)) continue;
      else vars.add(token);
    }
    return { variables: [...vars], mailScripts: [...scripts] };
  }

  function defaultSampleValue(name) {
    const lower = name.toLowerCase();
    const last = lower.split(".").pop();
    if (lower === "uri" || lower === "uri_ref") return lower === "uri" ? "https://yourinstance.service-now.com/nav_to.do?uri=sample" : "HRC0001234";
    if (last.includes("email")) return "jane.sample@example.com";
    if (last === "first_name") return "Jane";
    if (last === "last_name") return "Sample";
    if (last === "number") return "HRC0001234";
    if (last === "short_description") return "Sample short description";
    if (last === "description" || last === "comments" || last === "work_notes") return "Sample description text.";
    if (last === "state") return "In Progress";
    if (last === "priority") return "3 - Moderate";
    if (/(^|_)(date|deadline)($|_)|_on$|_at$/.test(last)) return "2026-01-15";
    if (/group/.test(last)) return "HR Shared Services";
    if (/^(name|full_name|display_name|user_name)$/.test(last)) return "Jane Sample";
    if (/(assigned_to|opened_for|opened_by|subject_person|manager|caller|requested_for|_by)$/.test(last)) return "Jane Sample";
    return "Sample " + last.replace(/^u_/, "").replace(/_/g, " ");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const MAIL_SCRIPT_STYLE =
    "display:inline-block;border:1px dashed #b26a00;background:#fff4e0;color:#7a4a00;" +
    "padding:2px 6px;border-radius:4px;font-family:Arial,sans-serif;font-size:12px;font-style:normal;font-weight:normal;";
  const UNKNOWN_VAR_STYLE = "background:#fff3b0;padding:0 2px;border-radius:3px;";

  // A typed-in example of a mail script's output, shown in place of the
  // [Dynamic content] box. Plain text (escaped, newlines kept), still in a
  // dashed outline so readers can tell it's generated, not fixed wording.
  function mailScriptExample(name, example) {
    const text = escapeHtml(example).replace(/\r?\n/g, "<br>");
    return (
      `<span style="display:inline-block;border:1px dashed #b26a00;padding:1px 5px;border-radius:4px;" ` +
      `title="Example output of mail script ${escapeHtml(name)} (typed in, not executed)">${text}</span>`
    );
  }

  function mailScriptPlaceholder(name) {
    return `<span style="${MAIL_SCRIPT_STYLE}" title="Mail script: ${escapeHtml(name)} (not executed)">[Dynamic content: ${escapeHtml(name)}]</span>`;
  }

  // Same trick as fillLayoutPlaceholders() in app.js: carry the font-family
  // declared right before ${notification:body} onto an explicit wrapper, so
  // block-level body content doesn't fall out of the layout's font scope.
  function detectFontFamilyBefore(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const matches = [...html.slice(0, idx).matchAll(/font-family:\s*([^;"']+)/gi)];
    return matches.length ? matches[matches.length - 1][1].trim() : null;
  }

  function wrapInLayout(layoutHtml, bodyHtml) {
    if (!layoutHtml) return bodyHtml;
    const marker = "${notification:body}";
    const font = detectFontFamilyBefore(layoutHtml, marker);
    const wrapped = font ? `<div style="font-family:${font};">${bodyHtml}</div>` : bodyHtml;
    return layoutHtml.split(marker).join(wrapped);
  }

  const VAR_CHIP_STYLE =
    "background:#e8f0fe;color:#1a4fb5;padding:0 3px;border-radius:3px;font-family:Consolas,'Courier New',monospace;font-size:0.9em;font-style:normal;";

  function variableChip(token) {
    return `<span style="${VAR_CHIP_STYLE}">${escapeHtml("${" + token + "}")}</span>`;
  }

  // Fills an HTML string: mail scripts -> placeholder boxes (or, with
  // opts.scriptExamples { name: text }, that script's typed-in example
  // output), known variables -> escaped sample values (or, with
  // opts.showNames, a ${name} chip so readers learn what each variable is),
  // anything else left visible and highlighted.
  function fillHtml(html, values, opts) {
    const showNames = !!(opts && opts.showNames);
    const examples = (opts && opts.scriptExamples) || null;
    return (html || "").replace(VAR_RE, (match, token) => {
      const t = token.trim();
      if (/^mail_script:/i.test(t)) {
        const name = t.slice(12).trim();
        const ex = examples && Object.prototype.hasOwnProperty.call(examples, name) ? String(examples[name] || "") : "";
        return ex.trim() ? mailScriptExample(name, ex) : mailScriptPlaceholder(name);
      }
      if (showNames) return variableChip(t);
      if (values && Object.prototype.hasOwnProperty.call(values, t)) return escapeHtml(values[t]);
      return `<span style="${UNKNOWN_VAR_STYLE}" title="Dynamic ServiceNow value">${escapeHtml(match)}</span>`;
    });
  }

  function fillText(text, values) {
    return (text || "").replace(VAR_RE, (match, token) => {
      const t = token.trim();
      if (/^mail_script:/i.test(t)) return `[Dynamic content: ${t.slice(12).trim()}]`;
      if (values && Object.prototype.hasOwnProperty.call(values, t)) return values[t];
      return match;
    });
  }

  // ---------------------------------------------------------------------
  // Images -> "[Logo]" placeholder
  //
  // ServiceNow layouts reference images relative to the instance
  // (/sys_attachment.do?sys_id=..., logo.pngx), which can't load here and
  // would show a broken-image icon. Images also aren't wanted in the review
  // Docs. Swapping each <img> for a short text label keeps the layout
  // readable without the picture.
  // ---------------------------------------------------------------------

  const IMAGE_PLACEHOLDER = "[Logo]";

  function imgSrc(tag) {
    const m = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    return m ? (m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]) : "";
  }

  // Relative URLs resolve against this tool, not the instance.
  function isRelativeUrl(src) {
    return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test((src || "").trim());
  }

  // shouldReplace(src) decides per image; omit it to replace every image.
  function imagesToPlaceholder(html, shouldReplace) {
    return (html || "").replace(/<img\b[^>]*>/gi, (tag) =>
      shouldReplace && !shouldReplace(imgSrc(tag)) ? tag : `<span>${IMAGE_PLACEHOLDER}</span>`
    );
  }

  // ---------------------------------------------------------------------
  // Small helpers for the program cover page
  // ---------------------------------------------------------------------

  // <unload unload_date="2026-11-04 01:46:40"> -> "2026-11-04 01:46:40"
  function parseUnloadDate(unloadOpenTag) {
    const m = /\sunload_date\s*=\s*"([^"]*)"/.exec(unloadOpenTag || "");
    return m ? m[1] : "";
  }

  // Only plain http(s) links go into a Doc; anything else (javascript:,
  // data:, typos) is rejected. Bare hosts get https:// added.
  function safeHttpUrl(v) {
    const t = String(v || "").trim();
    if (!t) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : "https://" + t;
    if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(withScheme) || /\s/.test(withScheme)) return null;
    return withScheme;
  }

  // ---------------------------------------------------------------------
  // CSV / TSV
  // ---------------------------------------------------------------------

  // Prefix values that a spreadsheet would treat as a formula.
  function guardFormula(v) {
    const s = v == null ? "" : String(v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function toCsv(rows) {
    return (
      "﻿" +
      rows.map((r) => r.map((v) => '"' + guardFormula(v).replace(/"/g, '""') + '"').join(",")).join("\r\n") +
      "\r\n"
    );
  }

  function toTsv(rows) {
    return rows.map((r) => r.map((v) => guardFormula(v).replace(/[\t\r\n]+/g, " ")).join("\t")).join("\n") + "\n";
  }

  return {
    scanChildren,
    splitUnload,
    readField,
    replaceField,
    buildUnloadXml,
    escapeXmlText,
    decodeXmlText,
    conditionDisplayValues,
    translateCondition,
    translateTerm,
    triggerParts,
    triggerSummary,
    recipientsSummary,
    hasAdvancedCondition,
    isTrue,
    splitList,
    findVariables,
    defaultSampleValue,
    escapeHtml,
    mailScriptPlaceholder,
    wrapInLayout,
    fillHtml,
    fillText,
    isRelativeUrl,
    friendlyField,
    friendlyTable,
    parseUnloadDate,
    safeHttpUrl,
    imagesToPlaceholder,
    IMAGE_PLACEHOLDER,
    toCsv,
    toTsv,
  };
});
