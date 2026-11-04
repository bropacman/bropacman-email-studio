/*
 * servicenow.js - the "ServiceNow import" tab.
 *
 * Imports ServiceNow list-export XML (<unload> root), links notifications to
 * their templates/layouts/mail scripts, shows readable summaries, previews
 * them with editable sample data, and exports for Google Docs / Sheets.
 *
 * Privacy: everything imported lives in the `S` object below, in memory
 * only. Nothing is written to localStorage/sessionStorage/IndexedDB/cookies
 * and nothing is sent over the network. Content leaves the page only when
 * the user clicks a copy or download button.
 */
(function () {
  "use strict";

  const C = window.SNCore;
  const D = window.DocsExport;

  const TABLES = {
    sysevent_email_action: "notifications",
    sysevent_email_template: "templates",
    sys_script_email: "scripts",
    sys_email_layout: "layouts",
  };
  const DEFAULT_FROM = "ServiceNow <noreply@yourinstance.service-now.com>";

  // All imported state. In memory only - see the header comment.
  const S = {
    files: [], // { name, decl, unloadOpenTag }
    notifications: new Map(), // sys_id -> record
    templates: new Map(),
    layouts: new Map(),
    scripts: new Map(), // keyed by sys_id
    scriptsByName: new Map(),
    sample: {}, // variable -> sample value
    meanings: {}, // variable -> plain-English meaning the user typed in
    edits: {}, // sys_id -> { subject?, message_html? }
    selected: null,
    advanced: false,
    editTarget: "auto",
  };

  const $ = (id) => document.getElementById(id);
  const els = {
    tabComposer: $("tab-composer"),
    tabSn: $("tab-sn"),
    composerView: $("composerView"),
    snView: $("snView"),
    presetPicker: $("presetPicker"),
    fileInput: $("snFileInput"),
    dropzone: $("snDropzone"),
    status: $("snImportStatus"),
    loadDemo: $("snLoadDemo"),
    filters: $("snFilters"),
    search: $("snSearch"),
    fCategory: $("snFilterCategory"),
    fTable: $("snFilterTable"),
    fActive: $("snFilterActive"),
    count: $("snCount"),
    list: $("snList"),
    exports: $("snExports"),
    exportCsv: $("snExportCsv"),
    copySheets: $("snCopySheets"),
    advancedToggle: $("snAdvancedToggle"),
    detail: $("snDetail"),
    copyDocs: $("snCopyDocs"),
    docsContent: $("snDocsContent"),
    docsShowNames: $("snDocsShowNames"),
    pvFrom: $("sn-pv-from"),
    pvTo: $("sn-pv-to"),
    pvSubject: $("sn-pv-subject"),
    pvFrame: $("sn-pv-frame"),
  };

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  function showTab(which) {
    const sn = which === "sn";
    els.tabComposer.setAttribute("aria-selected", String(!sn));
    els.tabSn.setAttribute("aria-selected", String(sn));
    els.composerView.hidden = sn;
    els.snView.hidden = !sn;
    els.presetPicker.hidden = sn;
  }
  els.tabComposer.addEventListener("click", () => showTab("composer"));
  els.tabSn.addEventListener("click", () => showTab("sn"));

  // ------------------------------------------------------------------
  // Import
  // ------------------------------------------------------------------

  function parseRecord(raw) {
    const doc = new DOMParser().parseFromString(raw, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("XML parse error");
    const root = doc.documentElement;
    const f = {};
    const dv = {};
    const conditionItems = [];
    for (const child of root.children) {
      // Most fields are plain text. A few (notably <condition>) also carry
      // child elements - ServiceNow appends <item .../> rows describing each
      // query term - so read only the field's own text nodes there.
      f[child.tagName] = child.children.length
        ? [...child.childNodes].filter((x) => x.nodeType === 3 || x.nodeType === 4).map((x) => x.nodeValue).join("").trim()
        : child.textContent;
      if (child.hasAttribute("display_value")) dv[child.tagName] = child.getAttribute("display_value");
      if (child.tagName === "condition") {
        for (const it of child.getElementsByTagName("item")) {
          conditionItems.push({
            field: it.getAttribute("field"),
            operator: it.getAttribute("operator"),
            value: it.getAttribute("value"),
            display_value: it.getAttribute("display_value"),
          });
        }
      }
    }
    return { f, dv, conditionDisplay: C.conditionDisplayValues(conditionItems) };
  }

  function importText(name, text) {
    const u = C.splitUnload(text);
    const fileIdx = S.files.push({ name, decl: u.decl, unloadOpenTag: u.unloadOpenTag }) - 1;
    const counts = { notifications: 0, templates: 0, scripts: 0, layouts: 0, skipped: 0 };
    for (const r of u.records) {
      const kind = TABLES[r.table];
      if (!kind) {
        counts.skipped++;
        continue;
      }
      const { f, dv, conditionDisplay } = parseRecord(r.raw);
      const rec = { table: r.table, sysId: f.sys_id, f, dv, conditionDisplay, raw: r.raw, fileIdx };
      if (!rec.sysId) {
        counts.skipped++;
        continue;
      }
      S[kind].set(rec.sysId, rec);
      if (kind === "scripts" && f.name) S.scriptsByName.set(f.name, rec);
      counts[kind]++;
    }
    return counts;
  }

  async function importFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    const lines = [];
    for (const file of files) {
      try {
        const c = importText(file.name, await file.text());
        lines.push(
          `${file.name}: ${c.notifications} notifications, ${c.templates} templates, ` +
            `${c.scripts} mail scripts, ${c.layouts} layouts` +
            (c.skipped ? ` (${c.skipped} other records ignored)` : "")
        );
      } catch (err) {
        lines.push(`${file.name}: could not import - ${err.message}`);
      }
    }
    setStatus(lines);
    afterImport();
  }

  function setStatus(lines) {
    els.status.replaceChildren(...lines.map((l) => Object.assign(document.createElement("div"), { textContent: l })));
  }

  function afterImport() {
    const has = S.notifications.size > 0;
    els.filters.hidden = !has;
    els.exports.hidden = !has;
    refreshFilterOptions();
    if (!S.selected || !S.notifications.has(S.selected)) {
      const first = filteredNotifications()[0];
      S.selected = first ? first.sysId : null;
    }
    renderList();
    renderSelected();
  }

  els.fileInput.addEventListener("change", (e) => {
    importFiles(e.target.files);
    e.target.value = "";
  });

  // Stop the browser from opening a dropped file anywhere on the page
  // (which would navigate away and wipe everything held in memory).
  ["dragover", "drop"].forEach((type) =>
    window.addEventListener(type, (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes("Files")) e.preventDefault();
    })
  );
  els.dropzone.addEventListener("dragover", () => els.dropzone.classList.add("dragging"));
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("dragging"));
  els.dropzone.addEventListener("drop", (e) => {
    els.dropzone.classList.remove("dragging");
    e.preventDefault();
    importFiles(e.dataTransfer.files);
  });

  els.loadDemo.addEventListener("click", () => {
    if (!window.SN_DEMO_XML) return;
    const c = importText("sample_hr_notifications.xml (fake demo)", window.SN_DEMO_XML);
    setStatus([`Fake demo data: ${c.notifications} notifications, ${c.templates} templates, ${c.scripts} mail scripts, ${c.layouts} layouts`]);
    afterImport();
    showTab("sn");
  });

  // ------------------------------------------------------------------
  // Effective values (original + in-memory edits)
  // ------------------------------------------------------------------

  function val(rec, field) {
    const e = S.edits[rec.sysId];
    if (e && Object.prototype.hasOwnProperty.call(e, field)) return e[field];
    return rec.f[field] || "";
  }

  function isEdited(rec) {
    return !!(rec && S.edits[rec.sysId] && Object.keys(S.edits[rec.sysId]).length);
  }

  function templateOf(n) {
    return n.f.template ? S.templates.get(n.f.template) || null : null;
  }

  function layoutIdOf(n) {
    const t = templateOf(n);
    return n.f.email_layout || (t && t.f.email_layout) || "";
  }

  function layoutOf(n) {
    const id = layoutIdOf(n);
    return id ? S.layouts.get(id) || null : null;
  }

  function effective(n) {
    const t = templateOf(n);
    const layout = layoutOf(n);
    // Like ServiceNow itself: a notification's own subject / message_html
    // win; the template only fills in whichever of them is empty.
    const ownBody = val(n, "message_html");
    const templateBody = t ? val(t, "message_html") : "";
    const source = (own, fromTemplate) =>
      own.trim() ? (fromTemplate.trim() ? "notification (overrides template)" : "notification") : fromTemplate.trim() ? "template" : "none";
    return {
      template: t,
      layout,
      subject: val(n, "subject") || (t ? val(t, "subject") : ""),
      subjectSource: source(val(n, "subject"), t ? val(t, "subject") : ""),
      body: ownBody.trim() ? ownBody : templateBody,
      bodySource: source(ownBody, templateBody),
      layoutHtml: layout ? layout.f.layout || layout.f.html || "" : "",
    };
  }

  function refLabel(rec, field, map, nameField) {
    const id = rec.f[field];
    if (!id) return "";
    const target = map.get(id);
    if (target) return target.f[nameField || "name"] || id;
    return (rec.dv[field] || id) + " (not in imported files)";
  }

  function categoryLabel(n) {
    return n.dv.category || n.f.category || "(No category)";
  }

  // Uncategorized notifications sort to the bottom of the list.
  function categorySortKey(n) {
    return (n.dv.category || n.f.category ? "0" : "1") + categoryLabel(n).toLowerCase();
  }

  function usesMailScripts(n) {
    const e = effective(n);
    return /\$\{\s*mail_script:/i.test(e.subject + e.body + e.layoutHtml);
  }

  // ------------------------------------------------------------------
  // List + filters
  // ------------------------------------------------------------------

  function refreshFilterOptions() {
    const fill = (select, values, allLabel) => {
      const cur = select.value;
      select.replaceChildren(new Option(allLabel, ""));
      [...values].sort((a, b) => a.localeCompare(b)).forEach((v) => select.add(new Option(v, v)));
      select.value = values.has(cur) ? cur : "";
    };
    const cats = new Set();
    const tables = new Set();
    S.notifications.forEach((n) => {
      cats.add(categoryLabel(n));
      tables.add(n.f.collection || "(no table)");
    });
    fill(els.fCategory, cats, "All categories");
    fill(els.fTable, tables, "All tables");
  }

  function filteredNotifications() {
    const q = els.search.value.trim().toLowerCase();
    const cat = els.fCategory.value;
    const table = els.fTable.value;
    const active = els.fActive.value;
    return [...S.notifications.values()]
      .filter((n) => {
        if (cat && categoryLabel(n) !== cat) return false;
        if (table && (n.f.collection || "(no table)") !== table) return false;
        if (active && String(C.isTrue(n.f.active)) !== active) return false;
        if (q) {
          const e = effective(n);
          const hay = [n.f.name, e.subject, n.f.collection, n.f.event_name, n.f.description, categoryLabel(n)]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => categorySortKey(a).localeCompare(categorySortKey(b)) || (a.f.name || "").localeCompare(b.f.name || ""));
  }

  function badge(text, cls) {
    const b = document.createElement("span");
    b.className = "badge " + (cls || "");
    b.textContent = text;
    return b;
  }

  function renderList() {
    const items = filteredNotifications();
    els.count.textContent = `${items.length} of ${S.notifications.size} notifications`;
    els.exportCsv.textContent = `Export inventory CSV (${items.length})`;
    els.copySheets.textContent = `Copy inventory for Google Sheets (${items.length})`;
    const frag = document.createDocumentFragment();
    let lastCat = null;
    items.forEach((n) => {
      const cat = categoryLabel(n);
      if (cat !== lastCat) {
        const h = document.createElement("div");
        h.className = "sn-group";
        h.textContent = cat;
        frag.appendChild(h);
        lastCat = cat;
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sn-item" + (n.sysId === S.selected ? " selected" : "");
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(n.sysId === S.selected));
      const name = document.createElement("span");
      name.className = "sn-item-name";
      name.textContent = n.f.name || n.sysId;
      const meta = document.createElement("span");
      meta.className = "sn-item-meta";
      meta.append(n.f.collection || "(no table)");
      if (!C.isTrue(n.f.active)) meta.append(badge("Inactive", "muted"));
      if (C.hasAdvancedCondition(n.f)) meta.append(badge("Script logic", "warn"));
      const t = templateOf(n);
      if (isEdited(n) || isEdited(t)) meta.append(badge("Edited", "edit"));
      btn.append(name, meta);
      btn.addEventListener("click", () => {
        S.selected = n.sysId;
        S.editTarget = "auto";
        renderList();
        renderSelected();
      });
      frag.appendChild(btn);
    });
    if (!items.length && S.notifications.size) {
      const empty = document.createElement("div");
      empty.className = "sn-empty";
      empty.textContent = "No notifications match these filters.";
      frag.appendChild(empty);
    }
    els.list.replaceChildren(frag);
  }

  [els.search, els.fCategory, els.fTable, els.fActive].forEach((el) => el.addEventListener("input", renderList));

  // ------------------------------------------------------------------
  // Detail panel
  // ------------------------------------------------------------------

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") el.className = v;
        else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
        else if (v !== undefined && v !== null && v !== false) el.setAttribute(k, v === true ? "" : v);
      }
    }
    children.flat(Infinity).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      el.append(c instanceof Node ? c : String(c));
    });
    return el;
  }

  const code = (s) => h("code", null, s);

  function section(title, ...body) {
    return h("section", { class: "sn-section" }, h("h3", null, title), ...body);
  }

  function kv(rows) {
    return h(
      "dl",
      { class: "sn-kv" },
      rows.filter(Boolean).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v === "" || v == null ? h("span", { class: "muted" }, "(none)") : v)])
    );
  }

  function conditionBlock(n) {
    const t = C.translateCondition(n.f.condition, n.conditionDisplay);
    if (!t.queries.length) return h("p", { class: "muted" }, "No condition: sends whenever the trigger happens.");
    const queryList = (clauses) =>
      h(
        "ul",
        { class: "sn-cond" },
        clauses.map((ors, i) =>
          h(
            "li",
            null,
            i > 0 ? h("span", { class: "op" }, "AND ") : null,
            ors.map((term, j) => [j > 0 ? h("span", { class: "op" }, " OR ") : null, term.field ? termNode(term) : h("span", { class: "warn-text" }, term.text)])
          )
        )
      );
    const nonEmpty = t.queries.filter((c) => c.length);
    return h(
      "div",
      null,
      nonEmpty.length > 1
        ? nonEmpty.map((c, i) => h("div", { class: "sn-nq" }, h("div", { class: "op" }, i === 0 ? "Either all of:" : "Or all of:"), queryList(c)))
        : queryList(nonEmpty[0]),
      t.notes.map((note) => h("p", { class: "warn-text" }, note)),
      h("details", { class: "sn-raw" }, h("summary", null, "Encoded query"), h("pre", null, n.f.condition))
    );
  }

  // Field names are shown as-is. If the export itself carried a display
  // label for a reference value (from the condition's <item> rows), show it
  // next to the raw value - otherwise nothing is invented.
  function termNode(term) {
    const rest = term.text.slice(term.field.length + 1);
    const tail = term.label ? ` (${term.label})` : "";
    return h("span", null, code(term.field), " ", tail ? rest.slice(0, -tail.length) : rest, tail ? h("span", { class: "muted" }, tail) : null);
  }

  function listOrNone(v) {
    const items = C.splitList(v);
    return items.length ? h("span", null, items.map((x, i) => [i ? ", " : "", code(x)])) : "";
  }

  function yesNo(v) {
    return C.isTrue(v) ? "Yes" : "No";
  }

  function sampleDataSection(n) {
    const e = effective(n);
    const { variables } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    variables.forEach((v) => {
      if (!(v in S.sample)) S.sample[v] = C.defaultSampleValue(v);
    });
    const rows = variables.map((v) =>
      h(
        "div",
        { class: "sn-sample-row" },
        code("${" + v + "}"),
        h("input", {
          type: "text",
          "aria-label": `Sample value for ${v}`,
          value: S.sample[v],
          oninput: (ev) => {
            S.sample[v] = ev.target.value;
            schedulePreview();
          },
        }),
        h("input", {
          type: "text",
          "aria-label": `Meaning of ${v}`,
          placeholder: "Meaning (shown in Google Docs)",
          value: S.meanings[v] || "",
          oninput: (ev) => {
            if (ev.target.value.trim()) S.meanings[v] = ev.target.value;
            else delete S.meanings[v];
          },
        })
      )
    );
    const importInput = h("input", {
      type: "file",
      accept: ".json,application/json",
      hidden: true,
      onchange: async (ev) => {
        const file = ev.target.files[0];
        ev.target.value = "";
        if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected a JSON object");
          // Current format: { values: {...}, meanings: {...} }. A flat
          // { variable: value } object (the earlier format) also works.
          const isNew = data.values || data.meanings;
          Object.entries(isNew ? data.values || {} : data).forEach(([k, v]) => (S.sample[k] = String(v)));
          Object.entries(isNew ? data.meanings || {} : {}).forEach(([k, v]) => (S.meanings[k] = String(v)));
          renderSelected();
        } catch (err) {
          alert("Could not read sample data: " + err.message);
        }
      },
    });
    return section(
      "Sample data",
      h(
        "p",
        { class: "muted" },
        "Fake values used for ${variables} in this preview, and an optional meaning for each that's listed in the Google Docs copy. " +
          "Shared across all notifications; kept in memory only - export the JSON to reuse them next time."
      ),
      rows.length ? h("div", { class: "sn-sample-head" }, h("span", null, "Variable"), h("span", null, "Sample value"), h("span", null, "Meaning")) : null,
      rows.length ? h("div", { class: "sn-sample" }, rows) : h("p", { class: "muted" }, "This notification uses no ${variables}."),
      h(
        "div",
        { class: "sn-buttons" },
        h("button", { type: "button", class: "secondary", onclick: () => D.download("sample-data.json", JSON.stringify({ values: S.sample, meanings: S.meanings }, null, 2) + "\n", "application/json") }, "Export sample data JSON"),
        h("button", { type: "button", class: "secondary", onclick: () => importInput.click() }, "Import sample data JSON"),
        h(
          "button",
          {
            type: "button",
            class: "secondary",
            onclick: () => {
              variables.forEach((v) => (S.sample[v] = C.defaultSampleValue(v)));
              renderSelected();
            },
          },
          "Reset to defaults"
        ),
        importInput
      )
    );
  }

  function mailScriptSection(n) {
    const e = effective(n);
    const { mailScripts } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    if (!mailScripts.length) return null;
    return section(
      "Mail scripts",
      h("p", { class: "muted" }, "Shown as [Dynamic content: name] in the preview. Source is for developers; it is never executed here."),
      mailScripts.map((name) => {
        const s = S.scriptsByName.get(name);
        return h(
          "details",
          { class: "sn-script" },
          h("summary", null, code(name), s ? "" : h("span", { class: "muted" }, " (not in imported files)")),
          s ? h("pre", null, s.f.script || "") : h("p", { class: "muted" }, "Export sys_script_email to see this script's source.")
        );
      })
    );
  }

  function renderSelected() {
    const n = S.selected ? S.notifications.get(S.selected) : null;
    if (!n) {
      els.detail.replaceChildren(
        h("div", { class: "sn-empty" }, S.notifications.size ? "Select a notification." : "Import one or more ServiceNow XML exports to get started, or load the fake demo data.")
      );
      els.copyDocs.disabled = true;
      renderPreview();
      return;
    }
    const e = effective(n);
    const advancedScript = C.hasAdvancedCondition(n.f);
    els.detail.replaceChildren(
      h(
        "header",
        { class: "sn-detail-head" },
        h("h2", null, n.f.name || "(unnamed)"),
        h(
          "div",
          { class: "sn-item-meta" },
          C.isTrue(n.f.active) ? badge("Active", "ok") : badge("Inactive", "muted"),
          badge(categoryLabel(n)),
          isEdited(n) || isEdited(e.template) ? badge("Edited locally", "edit") : null
        ),
        n.f.description ? h("p", { class: "muted" }, n.f.description) : null
      ),
      section(
        "When it sends",
        kv([
          ["Table", code(n.f.collection || "(none)")],
          ["Trigger", C.triggerParts(n.f).join(", ")],
          ["Insert / update", `insert: ${yesNo(n.f.action_insert)}, update: ${yesNo(n.f.action_update)}`],
          n.f.generation_type === "event" || (!n.f.generation_type && n.f.event_name) ? ["Event", code(n.f.event_name || "(none)")] : null,
          ["Condition", conditionBlock(n)],
          advancedScript
            ? [
                "Advanced condition",
                h(
                  "div",
                  null,
                  h("div", { class: "callout warn" }, "Custom script logic — ask HRIT"),
                  h("details", { class: "sn-raw" }, h("summary", null, "Script (developers)"), h("pre", null, n.f.advanced_condition))
                ),
              ]
            : null,
        ])
      ),
      section(
        "Who receives it",
        kv([
          ["Recipient fields", listOrNone(n.f.recipient_fields)],
          ["Users", listOrNone(n.f.recipient_users)],
          ["Groups", listOrNone(n.f.recipient_groups)],
          ["Event parm 1 is recipient", yesNo(n.f.event_parm_1)],
          ["Event parm 2 is recipient", yesNo(n.f.event_parm_2)],
          ["Send to event creator", yesNo(n.f.send_self)],
        ])
      ),
      section(
        "Content",
        kv([
          ["Template", n.f.template ? refLabel(n, "template", S.templates) : ""],
          ["Layout", layoutIdOf(n) ? (e.layout ? e.layout.f.name : (e.template && e.template.dv.email_layout) || n.dv.email_layout || layoutIdOf(n)) + (e.layout ? "" : " (not in imported files)") : ""],
          ["Subject from", e.subjectSource],
          ["Body from", e.bodySource],
          ["Scope", n.dv.sys_scope || n.f.sys_scope],
          ["Last updated", n.f.sys_updated_on],
          ["sys_id", code(n.sysId)],
        ])
      ),
      sampleDataSection(n),
      mailScriptSection(n),
      S.advanced ? advancedSection(n) : null
    );
    els.copyDocs.disabled = false;
    renderPreview();
  }

  // ------------------------------------------------------------------
  // Preview
  // ------------------------------------------------------------------

  const PREVIEW_HEAD =
    '<base target="_blank"><meta charset="utf-8"><style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1c2430;}</style>';

  // ------------------------------------------------------------------
  // Simplified layout for Google Docs
  //
  // Real layouts shape the email with nested tables, fixed heights/widths,
  // background colours and spacer rows - all of which distort a Doc. For
  // review we keep every piece of *text* the layout contributes, in a flat
  // shape:
  //   - rows above the body  -> one simple coloured banner (text + colour)
  //   - the row holding ${notification:body} -> its full content (headline,
  //     details table, disclaimer, body, signature...), with the cell's
  //     font/size/colour carried onto a wrapper
  //   - rows below the body  -> plain footer text under a thin line
  // Anything outside the table that holds those rows (grey background,
  // spacer tables) is dropped. Falls back to the whole layout if the
  // placeholder isn't inside a table cell.
  // ------------------------------------------------------------------

  const TEXT_STYLE_PROPS = /^(font-family|font-size|font-weight|font-style|color|line-height|text-align)\s*:/i;

  function textStyleOf(el, extra) {
    const props = (el.getAttribute("style") || "")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => TEXT_STYLE_PROPS.test(s));
    if (!props.some((s) => /^text-align/i.test(s)) && el.getAttribute("align")) props.push(`text-align: ${el.getAttribute("align")}`);
    return props.concat(extra || []).join("; ");
  }

  function backgroundOf(el) {
    for (const node of [el, ...el.querySelectorAll("*")]) {
      const m = /background(?:-color)?\s*:\s*(#[0-9a-f]{3,8}|rgba?\([^)]*\)|[a-z]+)/i.exec(node.getAttribute("style") || "");
      if (m && !/^(transparent|none|inherit)$/i.test(m[1])) return m[1];
      if (node.getAttribute("bgcolor")) return node.getAttribute("bgcolor");
    }
    return null;
  }

  function wrapWithStyle(style, html) {
    return style ? `<div style="${C.escapeHtml(style)}">${html}</div>` : html;
  }

  function simplifyLayout(layoutHtml) {
    const marker = "${notification:body}";
    if (!layoutHtml || !layoutHtml.includes(marker)) return layoutHtml;
    const doc = new DOMParser().parseFromString(layoutHtml, "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) && !node.nodeValue.includes(marker));
    const cell = node && node.parentElement.closest("td, th");
    if (!cell) return layoutHtml;
    const row = cell.closest("tr");
    const table = row.closest("table");
    const rows = [...table.rows];
    const bodyIdx = rows.indexOf(row);
    const parts = [];
    rows.forEach((tr, i) => {
      if (i === bodyIdx) {
        parts.push(wrapWithStyle(textStyleOf(cell), cell.innerHTML));
        return;
      }
      const hasImage = !!tr.querySelector("img");
      const text = tr.textContent.replace(/\s+/g, " ").trim();
      if (!text && !hasImage) return; // spacer row
      if (i < bodyIdx) {
        // Banner: the row's text (images become [Logo]) on its background colour.
        const clone = tr.cloneNode(true);
        clone.querySelectorAll("img").forEach((img) => img.replaceWith(doc.createTextNode(C.IMAGE_PLACEHOLDER)));
        const cellsText = [...clone.querySelectorAll("td, th")]
          .filter((c) => !c.querySelector("td, th"))
          .map((c) => c.textContent.replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const label = (cellsText.length ? cellsText : [clone.textContent.replace(/\s+/g, " ").trim()]).join("    ");
        parts.push(D.bannerTable(label, backgroundOf(tr) || "#293e40"));
      } else {
        // Footer: keep its text and inline formatting, drop its box styling.
        const cells = [...tr.cells].map((c) => wrapWithStyle(textStyleOf(c), c.innerHTML));
        parts.push('<hr style="border:0;border-top:1px solid #c7ced9;margin:12pt 0;">' + cells.join(""));
      }
    });
    return parts.join("\n");
  }

  // mode: "full" (whole layout, used by the preview), "simple" (simplified
  // layout for Docs) or "body" (just the notification/template body).
  function renderedEmail(n, mode, fillOpts) {
    const e = effective(n);
    if (!e.layoutHtml || mode === "body") return C.fillHtml(e.body, S.sample, fillOpts);
    // Sizing/spacer cleanup for Docs happens in DocsExport.prepareForDocs.
    if (mode === "simple") return C.fillHtml(C.wrapInLayout(simplifyLayout(e.layoutHtml), e.body), S.sample, fillOpts);
    return C.fillHtml(C.wrapInLayout(e.layoutHtml, e.body), S.sample, fillOpts);
  }

  function renderPreview() {
    const n = S.selected ? S.notifications.get(S.selected) : null;
    if (!n) {
      els.pvFrom.textContent = els.pvTo.textContent = els.pvSubject.textContent = "";
      els.pvFrame.srcdoc = PREVIEW_HEAD + '<p style="color:#6b7688">Nothing selected.</p>';
      return;
    }
    const e = effective(n);
    els.pvFrom.textContent = n.f.from || DEFAULT_FROM;
    els.pvTo.textContent = C.recipientsSummary(n.f);
    els.pvSubject.textContent = C.fillText(e.subject, S.sample) || "(no subject)";
    // Relative image URLs point at the instance and can't load here; show
    // a [Logo] label instead of a broken-image icon. Full URLs still load.
    const html = C.imagesToPlaceholder(renderedEmail(n, "full"), C.isRelativeUrl);
    els.pvFrame.srcdoc = PREVIEW_HEAD + (html || '<p style="color:#6b7688"><em>(empty body)</em></p>');
  }

  els.pvFrame.addEventListener("load", () => {
    try {
      const doc = els.pvFrame.contentDocument;
      if (doc && doc.body) els.pvFrame.style.height = doc.documentElement.scrollHeight + 4 + "px";
    } catch (err) {
      // ignore
    }
  });

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 200);
  }

  // ------------------------------------------------------------------
  // Exports
  // ------------------------------------------------------------------

  // Recipients for a review Doc: owners can't read sys_ids, so users and
  // groups are counted rather than listed (the full ids are in the app and
  // the inventory sheet).
  function recipientsForDocs(n) {
    const bits = [];
    const fields = C.splitList(n.f.recipient_fields);
    const users = C.splitList(n.f.recipient_users).length;
    const groups = C.splitList(n.f.recipient_groups).length;
    if (fields.length) bits.push(fields.join(", "));
    if (users) bits.push(`${users} user${users > 1 ? "s" : ""}`);
    if (groups) bits.push(`${groups} group${groups > 1 ? "s" : ""}`);
    if (C.isTrue(n.f.event_parm_1)) bits.push("event parm 1");
    if (C.isTrue(n.f.event_parm_2)) bits.push("event parm 2");
    if (C.isTrue(n.f.send_self)) bits.push("event creator");
    return bits.length ? bits.join("; ") : "(none configured)";
  }

  els.copyDocs.addEventListener("click", async () => {
    const n = S.selected ? S.notifications.get(S.selected) : null;
    if (!n) return;
    const e = effective(n);
    const showNames = els.docsShowNames.checked;
    const subject = showNames ? C.fillText(e.subject, null) : C.fillText(e.subject, S.sample);
    // Kept short on purpose - the full config is in the inventory sheet.
    const rows = [
      ["Notification", n.f.name || ""],
      ["When it sends", C.triggerSummary(n.f, n.conditionDisplay)],
      ["Last updated", n.f.sys_updated_on || ""],
    ];
    if (isEdited(n) || isEdited(e.template)) rows.push(["Note", "Contains proposed edits that are not yet in ServiceNow."]);
    // The email's own header, right above it - like the inbox preview.
    const emailHead = [
      ["From", n.f.from || DEFAULT_FROM],
      ["To", recipientsForDocs(n)],
      ["Subject", subject],
    ];
    // Review Docs get no images at all - each one becomes a [Logo] label.
    const email = await D.prepareForDocs(C.imagesToPlaceholder(renderedEmail(n, els.docsContent.value, { showNames })));
    // Every ${variable} the email uses, with its meaning and example value.
    const { variables } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    const varRows = variables.map((v) => ["${" + v + "}", S.meanings[v] || "", S.sample[v] != null ? S.sample[v] : C.defaultSampleValue(v)]);
    const varTable = varRows.length ? D.gridTable(["Variable", "Meaning", "Example"], varRows) : "";
    const html = D.headerTable(rows) + varTable + D.headerTable(emailHead) + email;
    const kvText = (list) => list.map(([k, v]) => `${k}: ${v}`).join("\n");
    const text =
      kvText(rows) +
      (varRows.length ? "\n\nVariables:\n" + varRows.map(([v, m, x]) => `${v}${m ? " - " + m : ""} (e.g. ${x})`).join("\n") : "") +
      "\n\n" +
      kvText(emailHead) +
      "\n\n" +
      D.htmlToText(email);
    flash(els.copyDocs, (await D.copyRich(html, text)) ? "Copied! Paste into Google Docs" : "Copy failed");
  });

  const INVENTORY_HEADER = [
    "Name",
    "Category",
    "Table",
    "Trigger summary",
    "Recipients summary",
    "Active",
    "Has advanced condition",
    "Uses mail scripts",
    "Template name",
    "sys_id",
    "sys_updated_on",
  ];

  function inventoryRows() {
    return [
      INVENTORY_HEADER,
      ...filteredNotifications().map((n) => [
        n.f.name || "",
        categoryLabel(n),
        n.f.collection || "",
        C.triggerSummary(n.f, n.conditionDisplay),
        C.recipientsSummary(n.f),
        C.isTrue(n.f.active) ? "true" : "false",
        C.hasAdvancedCondition(n.f) ? "Y" : "N",
        usesMailScripts(n) ? "Y" : "N",
        n.f.template ? refLabel(n, "template", S.templates) : "",
        n.sysId,
        n.f.sys_updated_on || "",
      ]),
    ];
  }

  els.exportCsv.addEventListener("click", () => D.download("notification-inventory.csv", C.toCsv(inventoryRows()), "text/csv;charset=utf-8"));
  els.copySheets.addEventListener("click", async () => {
    flash(els.copySheets, (await D.copyText(C.toTsv(inventoryRows()))) ? "Copied! Paste into cell A1" : "Copy failed");
  });

  function flash(button, msg) {
    const original = button.dataset.label || button.textContent;
    button.dataset.label = original;
    button.textContent = msg;
    setTimeout(() => {
      button.textContent = original;
      delete button.dataset.label;
      renderList(); // restores counts in export button labels
    }, 1600);
  }

  // ------------------------------------------------------------------
  // Advanced: edit subject / message_html and download importable XML
  // ------------------------------------------------------------------

  els.advancedToggle.addEventListener("change", () => {
    S.advanced = els.advancedToggle.checked;
    renderSelected();
  });

  function setEdit(rec, field, value) {
    const e = (S.edits[rec.sysId] = S.edits[rec.sysId] || {});
    if (value === (rec.f[field] || "")) delete e[field];
    else e[field] = value;
    if (!Object.keys(e).length) delete S.edits[rec.sysId];
  }

  function advancedSection(n) {
    const t = templateOf(n);
    if (S.editTarget === "auto") S.editTarget = t && effective(n).bodySource === "template" ? "template" : "notification";
    if (S.editTarget === "template" && !t) S.editTarget = "notification";
    const target = S.editTarget === "template" ? t : n;
    const sharedBy = t ? [...S.notifications.values()].filter((x) => x.f.template === t.sysId).length : 0;
    const status = h("span", { class: "muted" });
    const updateStatus = () => {
      const fields = Object.keys(S.edits[target.sysId] || {});
      status.textContent = fields.length ? `Edited: ${fields.join(", ")}` : "No edits.";
    };
    updateStatus();
    const onEdit = (field) => (ev) => {
      setEdit(target, field, ev.target.value);
      updateStatus();
      schedulePreview();
      renderList();
    };
    return section(
      "Advanced: edit & download XML",
      h(
        "div",
        { class: "callout danger" },
        h("strong", null, "DEV instance only. "),
        "The downloaded XML keeps every original field and sys_id and changes only subject / message_html. Import it into a DEV instance, " +
          "verify, then move it through an update set. Never import it straight into production."
      ),
      h(
        "label",
        { class: "sn-field" },
        "Edit record",
        h(
          "select",
          {
            onchange: (ev) => {
              S.editTarget = ev.target.value;
              renderSelected();
            },
          },
          h("option", { value: "notification", selected: S.editTarget === "notification" }, "Notification: " + (n.f.name || n.sysId)),
          t ? h("option", { value: "template", selected: S.editTarget === "template" }, "Template: " + (t.f.name || t.sysId)) : null
        )
      ),
      target === t && sharedBy > 1 ? h("p", { class: "warn-text" }, `This template is used by ${sharedBy} imported notifications; edits affect all of them.`) : null,
      h("label", { class: "sn-field" }, "subject", h("input", { type: "text", value: val(target, "subject"), oninput: onEdit("subject") })),
      h("label", { class: "sn-field" }, "message_html", h("textarea", { rows: 12, spellcheck: "false", class: "mono", oninput: onEdit("message_html") }, val(target, "message_html"))),
      h(
        "div",
        { class: "sn-buttons" },
        h("button", { type: "button", onclick: () => downloadXml(target) }, "Download updated XML"),
        h(
          "button",
          {
            type: "button",
            class: "secondary",
            onclick: () => {
              delete S.edits[target.sysId];
              renderSelected();
              renderList();
            },
          },
          "Discard edits"
        ),
        status
      )
    );
  }

  function downloadXml(rec) {
    let raw = rec.raw;
    const edits = S.edits[rec.sysId] || {};
    for (const field of ["subject", "message_html"]) {
      if (Object.prototype.hasOwnProperty.call(edits, field)) raw = C.replaceField(raw, field, edits[field]);
    }
    const file = S.files[rec.fileIdx];
    const xml = C.buildUnloadXml(file.decl, file.unloadOpenTag, [raw]);
    D.download(`${rec.table}_${rec.sysId}.xml`, xml, "application/xml");
  }

  window.addEventListener("beforeunload", (e) => {
    if (Object.keys(S.edits).length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  renderSelected();
})();
