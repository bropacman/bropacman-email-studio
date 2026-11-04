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
    // Other places HR emails come from - listed alongside notifications.
    sn_hr_core_email_content: "notifications",
    sn_cd_content_notification: "notifications",
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
    programs: {}, // category -> { description, ownerGroup, strategyUrl, inventoryUrl, reviewText } for cover pages
    scriptInfo: {}, // mail script name -> { description, example } typed in by the user
    assignedCategories: {}, // sys_id -> category, for HR email content / content delivery (no category in ServiceNow)
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
    copyGlossary: $("snCopyGlossary"),
    exportGlossary: $("snExportGlossary"),
    importGlossary: $("snImportGlossary"),
    importGlossaryInput: $("snImportGlossaryInput"),
    advancedToggle: $("snAdvancedToggle"),
    detail: $("snDetail"),
    copyDocs: $("snCopyDocs"),
    docsContent: $("snDocsContent"),
    docsShowNames: $("snDocsShowNames"),
    showScriptExamples: $("snShowScriptExamples"),
    coverHint: $("snCoverHint"),
    coverFields: $("snCoverFields"),
    coverTitle: $("snCoverTitle"),
    coverDesc: $("snCoverDesc"),
    coverOwner: $("snCoverOwner"),
    coverStrategy: $("snCoverStrategy"),
    coverInventory: $("snCoverInventory"),
    coverReview: $("snCoverReview"),
    coverLinkStatus: $("snCoverLinkStatus"),
    copyCover: $("snCopyCover"),
    copyProgram: $("snCopyProgram"),
    programSeparator: $("snProgramSeparator"),
    exportSettings: $("snExportSettings"),
    importSettings: $("snImportSettings"),
    importSettingsInput: $("snImportSettingsInput"),
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
    const fileIdx = S.files.push({ name, decl: u.decl, unloadOpenTag: u.unloadOpenTag, unloadDate: C.parseUnloadDate(u.unloadOpenTag) }) - 1;
    const counts = { notifications: 0, templates: 0, scripts: 0, layouts: 0, skipped: 0 };
    for (const r of u.records) {
      const kind = TABLES[r.table];
      if (!kind) {
        counts.skipped++;
        continue;
      }
      const { f, dv, conditionDisplay } = parseRecord(r.raw);
      if (kind === "notifications") {
        // In-memory conveniences only (rec.raw, used for XML downloads, is
        // untouched): which source this is, plus the common name/table fields.
        f.__source = r.table;
        if (!f.name && f.title) f.name = f.title;
        if (!f.collection && r.table === "sn_hr_core_email_content" && f.table) f.collection = f.table;
      }
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
      // Glossary CSVs and settings JSON can be dropped in the same place.
      if (/\.(csv|tsv|txt)$/i.test(file.name)) {
        lines.push(await importCsvFile(file));
        continue;
      }
      if (/\.json$/i.test(file.name)) {
        lines.push(`${file.name}: ${(await importSettingsFile(file)) ? "settings applied" : "could not read settings"}`);
        continue;
      }
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
    updateCoverPanel(true);
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

  function isNotification(rec) {
    return rec.table === "sysevent_email_action";
  }

  function sourceLabel(rec) {
    return (C.SOURCES[rec.table] || {}).label || "Notification";
  }

  // The field holding a record's HTML body.
  function bodyField(rec) {
    return (C.SOURCES[rec.table] || {}).body || "message_html";
  }

  // HR email content has no active flag (the activity decides); everything
  // else uses its own active field.
  function isActive(n) {
    return n.table === "sn_hr_core_email_content" ? true : C.isTrue(n.f.active);
  }

  function effective(n) {
    if (!isNotification(n)) {
      return {
        template: null,
        layout: null,
        subject: val(n, "subject"),
        subjectSource: "this record",
        body: val(n, bodyField(n)),
        bodySource: `this record (${bodyField(n)})`,
        layoutHtml: "",
      };
    }
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

  // HR email content and content delivery records have no category; they
  // group under their source instead.
  // A category assigned in this tool to an HR email content or content
  // delivery record (notifications always use ServiceNow's category).
  function assignedCategory(n) {
    return isNotification(n) ? "" : S.assignedCategories[n.sysId] || "";
  }

  function categoryLabel(n) {
    if (!isNotification(n)) return assignedCategory(n) || sourceLabel(n);
    return n.dv.category || n.f.category || "(No category)";
  }

  // Uncategorized notifications sort to the bottom of the list.
  function categorySortKey(n) {
    const categorized = !isNotification(n) || n.dv.category || n.f.category;
    return (categorized ? "0" : "1") + categoryLabel(n).toLowerCase();
  }

  function usesMailScripts(n) {
    const e = effective(n);
    return /\$\{\s*mail_script:/i.test(e.subject + e.body + e.layoutHtml);
  }

  // ------------------------------------------------------------------
  // List + filters
  // ------------------------------------------------------------------

  function refreshFilterOptions() {
    const fill = (select, values, allLabel, labelOf) => {
      const cur = select.value;
      select.replaceChildren(new Option(allLabel, ""));
      const label = labelOf || ((v) => v);
      [...values].sort((a, b) => label(a).localeCompare(label(b))).forEach((v) => select.add(new Option(label(v), v)));
      select.value = values.has(cur) ? cur : "";
    };
    const cats = new Set();
    const tables = new Set();
    S.notifications.forEach((n) => {
      cats.add(categoryLabel(n));
      tables.add(n.f.collection || "(no table)");
    });
    fill(els.fCategory, cats, "All categories");
    fill(els.fTable, tables, "All tables", (t) => (t === "(no table)" ? t : C.friendlyTable(t)));
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
        if (active && String(isActive(n)) !== active) return false;
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
      meta.append(n.f.collection ? C.friendlyTable(n.f.collection) : isNotification(n) ? "(no table)" : sourceLabel(n));
      if (!isActive(n)) meta.append(badge("Inactive", "muted"));
      if (n.table === "sn_cd_content_notification" && n.f.state && n.f.state !== "published") meta.append(badge(cap(n.f.state), "warn"));
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
  els.fCategory.addEventListener("input", () => updateCoverPanel());

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
    const t = C.translateCondition(n.f.condition, n.conditionDisplay, { friendly: true });
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

  // A friendly label with the technical name beside it in small grey type,
  // so business readers see the label and admins can still see the name.
  function labelWithName(label, name) {
    return label === name ? code(name) : h("span", null, h("strong", null, label), " ", h("code", { class: "tech" }, name));
  }

  // Condition term: friendly field label (technical name beside it). If the
  // export carried a display label for a reference value (from the
  // condition's <item> rows), it's shown after the raw value.
  function termNode(term) {
    return h(
      "span",
      null,
      labelWithName(term.fieldLabel, term.field),
      " ",
      term.phrase,
      term.label ? h("span", { class: "muted" }, ` (${term.label})`) : null
    );
  }

  function listOrNone(v) {
    const items = C.splitList(v);
    return items.length ? h("span", null, items.map((x, i) => [i ? ", " : "", code(x)])) : "";
  }

  function fieldListOrNone(v) {
    const items = C.splitList(v);
    return items.length ? h("span", null, items.map((x, i) => [i ? ", " : "", labelWithName(C.friendlyField(x), x)])) : "";
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
        await importSettingsFile(file);
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
        h("button", { type: "button", class: "secondary", onclick: exportSettingsFile }, "Export settings JSON"),
        h("button", { type: "button", class: "secondary", onclick: () => importInput.click() }, "Import settings JSON"),
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

  // Settings JSON: sample values, variable meanings and program cover
  // fields - the things worth typing once and reloading next session.
  // Format: { values, meanings, programs }. A flat { variable: value }
  // object (the first sample-data format) still imports.
  function exportSettingsFile() {
    const mailScripts = {};
    Object.entries(S.scriptInfo).forEach(([name, info]) => {
      if (info && (info.description || info.example)) mailScripts[name] = { description: info.description || "", example: info.example || "" };
    });
    const data = { values: S.sample, meanings: S.meanings, programs: S.programs, mailScripts, categories: S.assignedCategories };
    D.download("email-studio-settings.json", JSON.stringify(data, null, 2) + "\n", "application/json");
  }

  async function importSettingsFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("expected a JSON object");
      const isNew = data.values || data.meanings || data.programs || data.mailScripts || data.categories;
      Object.entries(isNew ? data.values || {} : data).forEach(([k, v]) => (S.sample[k] = String(v)));
      Object.entries(isNew ? data.meanings || {} : {}).forEach(([k, v]) => (S.meanings[k] = String(v)));
      Object.entries(isNew ? data.programs || {} : {}).forEach(([cat, p]) => {
        if (!p || typeof p !== "object") return;
        const target = programFor(cat);
        COVER_FIELDS.forEach((k) => {
          if (p[k] != null) target[k] = String(p[k]);
        });
      });
      Object.entries(isNew ? data.mailScripts || {} : {}).forEach(([name, info]) => {
        if (!info || typeof info !== "object") return;
        const target = scriptInfoFor(name);
        if (info.description != null) target.description = String(info.description);
        if (info.example != null) target.example = String(info.example);
      });
      Object.entries(isNew ? data.categories || {} : {}).forEach(([id, cat]) => {
        if (cat != null && String(cat).trim()) S.assignedCategories[id] = String(cat).trim();
      });
      refreshFilterOptions();
      renderList();
      renderSelected();
      updateCoverPanel(true);
      return true;
    } catch (err) {
      alert("Could not read settings: " + err.message);
      return false;
    }
  }

  // Returns (creating if needed) the typed-in info for a mail script. The
  // entry is dropped again by the field handlers once both fields are empty.
  function scriptInfoFor(name) {
    return (S.scriptInfo[name] = S.scriptInfo[name] || { description: "", example: "" });
  }

  // name -> example text, for scripts that have one, when the toggle is on.
  function scriptExamples() {
    if (!els.showScriptExamples.checked) return null;
    const out = {};
    Object.entries(S.scriptInfo).forEach(([name, info]) => {
      if (info && String(info.example || "").trim()) out[name] = info.example;
    });
    return out;
  }

  function mailScriptSection(n) {
    const e = effective(n);
    const { mailScripts } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    if (!mailScripts.length) return null;
    return section(
      "Mail scripts",
      h(
        "p",
        { class: "muted" },
        "Scripts are never executed here. Describe what each one does and type an example of its output: the example replaces " +
          "the [Dynamic content] box in the preview and the Google Docs copy (in a dashed outline), and both are listed in the " +
          "Docs copy's Mail scripts table. Saved with the settings JSON."
      ),
      mailScripts.map((name) => {
        const s = S.scriptsByName.get(name);
        const info = scriptInfoFor(name);
        const onField = (key) => (ev) => {
          info[key] = ev.target.value;
          if (!info.description && !info.example) delete S.scriptInfo[name];
          if (key === "example") schedulePreview();
        };
        return h(
          "div",
          { class: "sn-script" },
          h("div", { class: "sn-script-name" }, code(name), s ? "" : h("span", { class: "muted" }, " (source not in imported files)")),
          h(
            "label",
            { class: "sn-field" },
            "What it does",
            h("input", { type: "text", value: info.description || "", placeholder: "e.g. Signature block for the HR case team", oninput: onField("description") })
          ),
          h(
            "label",
            { class: "sn-field" },
            "Example output",
            h("textarea", { rows: 2, placeholder: "e.g. Thanks, HR Shared Services", oninput: onField("example") }, info.example || "")
          ),
          s
            ? h("details", { class: "sn-raw" }, h("summary", null, "Script source (developers)"), h("pre", null, s.f.script || ""))
            : h("p", { class: "muted" }, "Export sys_script_email to see this script's source.")
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
    // Sections that don't apply are null; replaceChildren would print those as "null".
    els.detail.replaceChildren(...[
      h(
        "header",
        { class: "sn-detail-head" },
        h("h2", null, n.f.name || "(unnamed)"),
        h(
          "div",
          { class: "sn-item-meta" },
          n.table === "sn_hr_core_email_content"
            ? badge("Activity-driven", "muted")
            : isActive(n)
            ? badge("Active", "ok")
            : badge("Inactive", "muted"),
          n.table === "sn_cd_content_notification" && n.f.state ? badge(cap(n.f.state), n.f.state === "published" ? "ok" : "warn") : null,
          badge(assignedCategory(n) ? `${categoryLabel(n)} (assigned here)` : categoryLabel(n), assignedCategory(n) ? "edit" : ""),
          isEdited(n) || isEdited(e.template) ? badge("Edited locally", "edit") : null
        ),
        n.f.description ? h("p", { class: "muted" }, n.f.description) : null
      ),
      isNotification(n) ? null : categoryField(n),
      isNotification(n) ? null : otherSourceWhen(n),
      isNotification(n) ? null : otherSourceWho(n),
      !isNotification(n)
        ? null
        : section(
        "When it sends",
        kv([
          ["Table", n.f.collection ? labelWithName(C.friendlyTable(n.f.collection), n.f.collection) : "(none)"],
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
      !isNotification(n)
        ? null
        : section(
        "Who receives it",
        kv([
          ["Recipient fields", fieldListOrNone(n.f.recipient_fields)],
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
          isNotification(n) ? ["Template", n.f.template ? refLabel(n, "template", S.templates) : ""] : null,
          !isNotification(n) ? null : ["Layout", layoutIdOf(n) ? (e.layout ? e.layout.f.name : (e.template && e.template.dv.email_layout) || n.dv.email_layout || layoutIdOf(n)) + (e.layout ? "" : " (not in imported files)") : ""],
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
    ].filter(Boolean));
    els.copyDocs.disabled = false;
    renderPreview();
  }

  function cap(s) {
    const t = String(s || "");
    return t ? t[0].toUpperCase() + t.slice(1) : t;
  }

  // "When it sends" / "Who receives it" for HR email content and content
  // delivery records: these say where that's configured instead of guessing.
  // Category for records ServiceNow doesn't categorize. Suggests the
  // existing notification categories so a record can join that program.
  function categoryField(n) {
    const known = new Set();
    S.notifications.forEach((x) => {
      if (isNotification(x) && (x.dv.category || x.f.category)) known.add(x.dv.category || x.f.category);
      if (assignedCategory(x)) known.add(assignedCategory(x));
    });
    const listId = "snCategoryOptions";
    const apply = (value) => {
      const v = value.trim();
      if (v && v !== sourceLabel(n)) S.assignedCategories[n.sysId] = v;
      else delete S.assignedCategories[n.sysId];
      refreshFilterOptions();
      renderList();
      renderSelected();
      updateCoverPanel(true);
    };
    return section(
      "Category",
      h(
        "p",
        { class: "muted" },
        `ServiceNow has no category for ${sourceLabel(n)}. Assign one here so it joins that program's list, Doc and cover - ` +
          "or fill the Category column in the inventory sheet and import that CSV. Kept in memory and saved with the settings JSON."
      ),
      h(
        "div",
        { class: "sn-buttons" },
        h("input", {
          type: "text",
          class: "sn-category-input",
          list: listId,
          value: assignedCategory(n),
          placeholder: `e.g. ${[...known][0] || "Human Resources"}`,
          "aria-label": "Assigned category",
          onchange: (ev) => apply(ev.target.value),
        }),
        h("datalist", { id: listId }, [...known].sort().map((c) => h("option", { value: c }))),
        assignedCategory(n) ? h("button", { type: "button", class: "secondary", onclick: () => apply("") }, "Clear") : null
      )
    );
  }

  function otherSourceWhen(n) {
    const isContent = n.table === "sn_hr_core_email_content";
    return section(
      "When it sends",
      h(
        "div",
        { class: "callout" },
        isContent
          ? "This is HR email content. It's sent by a Lifecycle Event activity, and when it sends is configured on that activity, not here."
          : "This is a Content Delivery email. It's sent on the schedule set in Content Publishing, not configured here."
      ),
      kv([
        ["Source", labelWithName(sourceLabel(n), n.table)],
        isContent && n.f.collection ? ["Table", labelWithName(C.friendlyTable(n.f.collection), n.f.collection)] : null,
        isContent && n.f.type ? ["Type", labelWithName(C.friendlyField(n.f.type), n.f.type)] : null,
        !isContent ? ["State", cap(n.f.state) || "(none)"] : null,
        !isContent ? ["Active", yesNo(n.f.active)] : null,
        !isContent && n.dv.content_type ? ["Content type", n.dv.content_type] : null,
      ])
    );
  }

  function otherSourceWho(n) {
    const isContent = n.table === "sn_hr_core_email_content";
    return section(
      "Who receives it",
      kv([
        ["Recipients", C.recipientsSummary(n.f, { friendly: true })],
        !isContent ? ["From", n.f.from || "(default)"] : null,
        !isContent ? ["Reply-to", n.f.reply_to || "(default)"] : null,
      ])
    );
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
    els.pvTo.textContent = C.recipientsSummary(n.f, { friendly: true });
    els.pvSubject.textContent = C.fillText(e.subject, S.sample) || "(no subject)";
    // Relative image URLs point at the instance and can't load here; show
    // a [Logo] label instead of a broken-image icon. Full URLs still load.
    const html = C.imagesToPlaceholder(renderedEmail(n, "full", { scriptExamples: scriptExamples() }), C.isRelativeUrl);
    els.pvFrame.srcdoc = PREVIEW_HEAD + (html || '<p style="color:#6b7688"><em>(empty body)</em></p>');
  }

  els.showScriptExamples.addEventListener("change", renderPreview);

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
    if (fields.length) bits.push(fields.map(C.friendlyField).join(", "));
    if (users) bits.push(`${users} user${users > 1 ? "s" : ""}`);
    if (groups) bits.push(`${groups} group${groups > 1 ? "s" : ""}`);
    if (C.isTrue(n.f.event_parm_1)) bits.push("event parm 1");
    if (C.isTrue(n.f.event_parm_2)) bits.push("event parm 2");
    if (C.isTrue(n.f.send_self)) bits.push("event creator");
    return bits.length ? bits.join("; ") : "(none configured)";
  }

  // Docs styling shared by the notification copy and the program copy.
  const DOCS_FONT = "font-family:Arial,Helvetica,sans-serif;color:#1c2430;";
  const DOCS_BODY = DOCS_FONT + "font-size:10.5pt;line-height:1.45;margin:0 0 6pt 0;";
  // A real Docs heading (shows in the outline and in Insert > Table of
  // contents), one per notification.
  const notificationHeading = (title) =>
    `<h2 style="${DOCS_FONT}font-size:15pt;font-weight:bold;margin:0 0 6pt 0;">${D.escapeHtml(title)}</h2>`;
  // Between notifications in a whole-program copy. A divider line works in
  // pageless Docs (which hide page breaks); a Word-style page break, which
  // Google Docs turns into a real page break on paste, suits paged/printed
  // Docs.
  const SEPARATORS = {
    divider: '<p style="margin:0;">&nbsp;</p><hr style="border:0;border-top:2px solid #c7ced9;margin:6pt 0 12pt 0;">',
    pagebreak: '<br clear="all" style="page-break-before:always">',
  };

  // Everything for one notification in a review Doc: its heading, the small
  // config table, the Variables table, From/To/Subject, and the email.
  async function notificationDocs(n, title) {
    const e = effective(n);
    const showNames = els.docsShowNames.checked;
    const subject = showNames ? C.fillText(e.subject, null) : C.fillText(e.subject, S.sample);
    // Kept short on purpose - the full config is in the inventory sheet.
    const rows = [
      ["Notification", n.f.name || ""],
      ["When it sends", C.triggerSummary(n.f, n.conditionDisplay, { friendly: true })],
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
    const email = await D.prepareForDocs(
      C.imagesToPlaceholder(renderedEmail(n, els.docsContent.value, { showNames, scriptExamples: scriptExamples() }))
    );
    // Every ${variable} the email uses, with its meaning and example value.
    const { variables } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    const varRows = variables.map((v) => ["${" + v + "}", S.meanings[v] || "", S.sample[v] != null ? S.sample[v] : C.defaultSampleValue(v)]);
    const varTable = varRows.length ? D.gridTable(["Variable", "Meaning", "Example"], varRows, { codeFirstColumn: true }) : "";
    // Every mail script the email uses, with what it does and an example.
    const { mailScripts } = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
    const scriptRows = mailScripts.map((name) => {
      const info = S.scriptInfo[name] || {};
      return [name, info.description || "", info.example || ""];
    });
    const scriptTable = scriptRows.length ? D.gridTable(["Mail script", "What it does", "Example output"], scriptRows, { codeFirstColumn: true }) : "";
    const html = notificationHeading(title) + D.headerTable(rows) + varTable + scriptTable + D.headerTable(emailHead) + email;
    const kvText = (list) => list.map(([k, v]) => `${k}: ${v}`).join("\n");
    const text =
      title +
      "\n\n" +
      kvText(rows) +
      (varRows.length ? "\n\nVariables:\n" + varRows.map(([v, m, x]) => `${v}${m ? " - " + m : ""} (e.g. ${x})`).join("\n") : "") +
      (scriptRows.length
        ? "\n\nMail scripts:\n" + scriptRows.map(([s, d, x]) => `${s}${d ? " - " + d : ""}${x ? " (e.g. " + x.replace(/\s+/g, " ") + ")" : ""}`).join("\n")
        : "") +
      "\n\n" +
      kvText(emailHead) +
      "\n\n" +
      D.htmlToText(email);
    return { html, text };
  }

  els.copyDocs.addEventListener("click", async () => {
    const n = S.selected ? S.notifications.get(S.selected) : null;
    if (!n) return;
    const { html, text } = await notificationDocs(n, n.f.name || n.sysId);
    flash(els.copyDocs, (await D.copyRich(html, text)) ? "Copied! Paste into Google Docs" : "Copy failed");
  });

  const INVENTORY_HEADER = [
    "Name",
    "Source",
    "Category",
    "Category source",
    "Table",
    "Table name",
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
        sourceLabel(n),
        // Unassigned HR email content / content delivery rows get an empty
        // Category cell, ready to be filled in the sheet and imported back.
        isNotification(n) ? categoryLabel(n) : assignedCategory(n),
        isNotification(n) ? (n.dv.category || n.f.category ? "ServiceNow" : "None") : assignedCategory(n) ? "Assigned in tool" : "Not assigned",
        n.f.collection ? C.friendlyTable(n.f.collection) : "",
        n.f.collection || "",
        C.triggerSummary(n.f, n.conditionDisplay, { friendly: true }),
        C.recipientsSummary(n.f, { friendly: true }),
        isActive(n) ? "true" : "false",
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
          h("option", { value: "notification", selected: S.editTarget === "notification" }, sourceLabel(n) + ": " + (n.f.name || n.sysId)),
          t ? h("option", { value: "template", selected: S.editTarget === "template" }, "Template: " + (t.f.name || t.sysId)) : null
        )
      ),
      target === t && sharedBy > 1 ? h("p", { class: "warn-text" }, `This template is used by ${sharedBy} imported notifications; edits affect all of them.`) : null,
      h("label", { class: "sn-field" }, "subject", h("input", { type: "text", value: val(target, "subject"), oninput: onEdit("subject") })),
      h(
        "label",
        { class: "sn-field" },
        bodyField(target),
        h("textarea", { rows: 12, spellcheck: "false", class: "mono", oninput: onEdit(bodyField(target)) }, val(target, bodyField(target)))
      ),
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
    for (const field of ["subject", bodyField(rec)]) {
      if (Object.prototype.hasOwnProperty.call(edits, field)) raw = C.replaceField(raw, field, edits[field]);
    }
    const file = S.files[rec.fileIdx];
    const xml = C.buildUnloadXml(file.decl, file.unloadOpenTag, [raw]);
    D.download(`${rec.table}_${rec.sysId}.xml`, xml, "application/xml");
  }


  // ------------------------------------------------------------------
  // Program cover page (first tab of each program's Google Doc)
  //
  // Facts come from the imported XML (category, counts, notification list,
  // export date). What ServiceNow doesn't hold - the strategy/description,
  // process owner group, links and review instructions - is typed in here,
  // kept in memory per category, and saved with the settings JSON.
  // ------------------------------------------------------------------

  const DEFAULT_REVIEW_TEXT =
    "Each notification below has its own numbered heading, in the order listed. Use the document " +
    "outline (or the table of contents) to jump between them. Please review the wording and add comments rather than " +
    "editing the text directly. ${variable} chips are filled in by ServiceNow when the email is sent (see each " +
    "notification's Variables table), and [Dynamic content] boxes are generated by scripts. Approved changes are made in " +
    "ServiceNow and moved to production through the normal release process.";
  // Default from the first (one-tab-per-notification) version; programs
  // still holding it untouched get the new default.
  const OLD_DEFAULT_REVIEW_TEXT =
    "Each tab after this one is one notification, in the order listed below. Please review the wording and add comments " +
    "rather than editing the text directly. ${variable} chips are filled in by ServiceNow when the email is sent (see each " +
    "tab's Variables table), and [Dynamic content] boxes are generated by scripts. Approved changes are made in ServiceNow " +
    "and moved to production through the normal release process.";

  const COVER_FIELDS = ["description", "ownerGroup", "strategyUrl", "inventoryUrl", "reviewText"];
  let coverCategory = null;

  function programFor(cat) {
    const p = (S.programs[cat] = S.programs[cat] || { reviewText: DEFAULT_REVIEW_TEXT });
    if (p.reviewText === OLD_DEFAULT_REVIEW_TEXT) p.reviewText = DEFAULT_REVIEW_TEXT;
    return p;
  }

  function coverInputs() {
    return {
      description: els.coverDesc,
      ownerGroup: els.coverOwner,
      strategyUrl: els.coverStrategy,
      inventoryUrl: els.coverInventory,
      reviewText: els.coverReview,
    };
  }

  // Shows the fields for the category picked in the filter.
  function updateCoverPanel(force) {
    const cat = els.fCategory.value;
    if (!force && cat === coverCategory) return;
    coverCategory = cat;
    els.coverHint.hidden = !!cat;
    els.coverFields.hidden = !cat;
    if (!cat) return;
    els.coverTitle.textContent = cat;
    const p = programFor(cat);
    const inputs = coverInputs();
    COVER_FIELDS.forEach((k) => (inputs[k].value = p[k] || ""));
    els.coverLinkStatus.textContent = "";
  }

  Object.entries({
    description: "coverDesc",
    ownerGroup: "coverOwner",
    strategyUrl: "coverStrategy",
    inventoryUrl: "coverInventory",
    reviewText: "coverReview",
  }).forEach(([key, el]) =>
    els[el].addEventListener("input", () => {
      if (!coverCategory) return;
      programFor(coverCategory)[key] = els[el].value;
    })
  );

  function linkCell(raw, label) {
    if (!String(raw || "").trim()) return "(not set)";
    const href = C.safeHttpUrl(raw);
    return href ? { href, text: label } : `(invalid link: ${raw})`;
  }

  function coverData(cat) {
    const items = [...S.notifications.values()]
      .filter((n) => categoryLabel(n) === cat)
      .sort((a, b) => (a.f.name || "").localeCompare(b.f.name || ""));
    const active = items.filter((n) => isActive(n)).length;
    const scripted = items.filter((n) => C.hasAdvancedCondition(n.f)).length;
    const exported = [...new Set(items.map((n) => (S.files[n.fileIdx] || {}).unloadDate).filter(Boolean))].sort();
    const p = programFor(cat);
    const summary = [
      ["Program", cat],
      ["Process owner group", (p.ownerGroup || "").trim() || "(not set)"],
      ["Strategy", linkCell(p.strategyUrl, "Strategy and description")],
      ["Inventory sheet", linkCell(p.inventoryUrl, "Notification inventory")],
      [
        "Notifications",
        `${items.length} total: ${active} active, ${items.length - active} inactive` +
          (scripted ? `; ${scripted} with custom script logic (ask HRIT)` : ""),
      ],
      ["Exported from ServiceNow", exported.length ? exported.join(", ") : "(unknown)"],
    ];
    const list = items.map((n, i) => [
      String(i + 1),
      n.f.name || n.sysId,
      C.triggerSummary(n.f, n.conditionDisplay, { friendly: true }),
      isActive(n) ? "Yes" : "No",
      n.f.sys_updated_on || "",
    ]);
    return { items, summary, list, p };
  }

  function paragraphs(text, style) {
    return String(text || "")
      .split(/\n\s*\n/)
      .map((para) => para.trim())
      .filter(Boolean)
      .map((para) => `<p style="${style}">${D.escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }

  // The cover. Only the program title is a heading; the cover's own
  // sections are bold paragraphs, so the Doc outline reads
  // "Program > 1. Notification > 2. Notification ..." and nothing else.
  function coverDocs(cat) {
    const { items, summary, list, p } = coverData(cat);
    const bad = ["strategyUrl", "inventoryUrl"].filter((k) => String(p[k] || "").trim() && !C.safeHttpUrl(p[k]));
    els.coverLinkStatus.textContent = bad.length ? "One of the links isn't a valid http(s) URL; it's shown as text." : "";
    const h1 = `<h1 style="${DOCS_FONT}font-size:18pt;margin:0 0 4pt 0;">${D.escapeHtml(cat)}: notification review</h1>`;
    const sectionTitle = (t) => `<p style="${DOCS_FONT}font-size:12pt;font-weight:bold;margin:14pt 0 4pt 0;">${D.escapeHtml(t)}</p>`;
    const tocTip =
      `<p style="${DOCS_FONT}font-size:9pt;font-style:italic;color:#6b7688;margin:0 0 6pt 0;">` +
      "Tip: put the cursor on this line and use Insert &gt; Table of contents for clickable links to every notification.</p>";
    const html =
      h1 +
      D.headerTable(summary) +
      tocTip +
      sectionTitle("About this program") +
      (paragraphs(p.description, DOCS_BODY) || `<p style="${DOCS_BODY}color:#6b7688;">(No description yet.)</p>`) +
      sectionTitle("How to review") +
      paragraphs(p.reviewText || DEFAULT_REVIEW_TEXT, DOCS_BODY) +
      sectionTitle("Notifications") +
      D.gridTable(["#", "Notification", "When it sends", "Active", "Last updated"], list);
    const text =
      `${cat}: notification review\n\n` +
      summary.map(([k, v]) => `${k}: ${D.cellText(v)}`).join("\n") +
      `\n\nAbout this program\n${(p.description || "(No description yet.)").trim()}` +
      `\n\nHow to review\n${(p.reviewText || DEFAULT_REVIEW_TEXT).trim()}` +
      "\n\nNotifications\n" +
      list.map(([i, name, when, active, updated]) => `${i}. ${name} - ${when} - active: ${active} - updated ${updated}`).join("\n");
    return { html, text, items };
  }

  els.copyCover.addEventListener("click", async () => {
    if (!coverCategory) return;
    const { html, text } = coverDocs(coverCategory);
    flash(els.copyCover, (await D.copyRich(html, text)) ? "Copied! Paste at the top of the Doc" : "Copy failed");
  });

  // The whole program as one Doc: cover, then every notification of the
  // category under a numbered heading (same numbering and order as the
  // cover's list), separated by a divider line or a page break.
  els.copyProgram.addEventListener("click", async () => {
    const cat = coverCategory;
    if (!cat) return;
    const original = els.copyProgram.textContent;
    els.copyProgram.disabled = true;
    els.copyProgram.textContent = "Building...";
    try {
      const cover = coverDocs(cat);
      const parts = [cover.html];
      const texts = [cover.text];
      for (const [i, n] of cover.items.entries()) {
        const one = await notificationDocs(n, `${i + 1}. ${n.f.name || n.sysId}`);
        parts.push((SEPARATORS[els.programSeparator.value] || SEPARATORS.divider) + one.html);
        texts.push(one.text);
      }
      const ok = await D.copyRich(parts.join("\n"), texts.join("\n\n----------\n\n"));
      els.copyProgram.textContent = original;
      els.copyProgram.disabled = false;
      flash(els.copyProgram, ok ? `Copied cover + ${cover.items.length} notifications` : "Copy failed");
    } catch (err) {
      els.copyProgram.textContent = original;
      els.copyProgram.disabled = false;
      alert("Could not build the program copy: " + err.message);
    }
  });

  els.exportSettings.addEventListener("click", exportSettingsFile);
  els.importSettings.addEventListener("click", () => els.importSettingsInput.click());
  els.importSettingsInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) await importSettingsFile(file);
  });

  // ------------------------------------------------------------------
  // Glossary: mail scripts and ${variables} across every imported
  // notification, for a "Glossary" tab in the inventory Google Sheet.
  // ------------------------------------------------------------------

  function glossaryRows() {
    const vars = new Map();
    const scripts = new Map();
    S.notifications.forEach((n) => {
      const e = effective(n);
      const found = C.findVariables(e.subject + "\n" + e.body + "\n" + e.layoutHtml);
      found.variables.forEach((v) => vars.set(v, (vars.get(v) || 0) + 1));
      found.mailScripts.forEach((s) => scripts.set(s, (scripts.get(s) || 0) + 1));
    });
    const used = (count) => `${count} notification${count === 1 ? "" : "s"}`;
    const byUse = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);
    return [
      C.GLOSSARY_HEADER,
      ...[...scripts].sort(byUse).map(([name, count]) => {
        const info = S.scriptInfo[name] || {};
        return ["Mail script", name, info.description || "", info.example || "", used(count)];
      }),
      ...[...vars].sort(byUse).map(([name, count]) => [
        "Variable",
        "${" + name + "}",
        S.meanings[name] || "",
        S.sample[name] != null ? S.sample[name] : C.defaultSampleValue(name),
        used(count),
      ]),
    ];
  }

  els.copyGlossary.addEventListener("click", async () => {
    const rows = glossaryRows();
    flash(els.copyGlossary, (await D.copyText(C.toTsv(rows))) ? `Copied ${rows.length - 1} rows! Paste into cell A1` : "Copy failed");
  });
  els.exportGlossary.addEventListener("click", () =>
    D.download("notification-glossary.csv", C.toCsv(glossaryRows()), "text/csv;charset=utf-8")
  );
  els.importGlossary.addEventListener("click", () => els.importGlossaryInput.click());
  els.importGlossaryInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) setStatus([await importCsvFile(file)]);
  });

  // A dropped/picked CSV is either the inventory (has sys_id + Category
  // columns: assign categories) or the glossary. Returns a status line.
  async function importCsvFile(file) {
    let rows;
    try {
      rows = C.parseCsv(await file.text());
    } catch (err) {
      return `${file.name}: could not read CSV - ${err.message}`;
    }
    const cats = C.readInventoryCategories(rows);
    return cats ? applyInventoryCategories(file.name, cats) : importGlossaryRows(file.name, rows);
  }

  // Only HR email content / content delivery records take a category from
  // the sheet; notifications keep ServiceNow's.
  function applyInventoryCategories(fileName, cats) {
    let applied = 0;
    let ignored = 0;
    Object.entries(cats).forEach(([id, cat]) => {
      const n = S.notifications.get(id);
      if (!n || isNotification(n) || cat === sourceLabel(n)) {
        ignored++;
        return;
      }
      S.assignedCategories[id] = cat;
      applied++;
    });
    refreshFilterOptions();
    renderList();
    renderSelected();
    updateCoverPanel(true);
    return (
      `${fileName}: inventory - categories assigned to ${applied} HR email content / content delivery record${applied === 1 ? "" : "s"}` +
      (ignored ? ` (${ignored} rows left as they are: notifications keep ServiceNow's category, or the record isn't imported yet)` : "")
    );
  }

  // Applies a glossary CSV: variable meanings + sample values, mail script
  // descriptions + examples. Returns a status line.
  async function importGlossaryRows(fileName, rows) {
    const file = { name: fileName };
    try {
      const g = C.readGlossary(rows);
      Object.entries(g.variables).forEach(([name, v]) => {
        if (v.meaning) S.meanings[name] = v.meaning;
        if (v.example) S.sample[name] = v.example;
      });
      Object.entries(g.mailScripts).forEach(([name, s]) => {
        const target = scriptInfoFor(name);
        if (s.description) target.description = s.description;
        if (s.example) target.example = s.example;
      });
      renderSelected();
      const nv = Object.keys(g.variables).length;
      const ns = Object.keys(g.mailScripts).length;
      return `${file.name}: glossary with ${ns} mail script${ns === 1 ? "" : "s"} and ${nv} variable${nv === 1 ? "" : "s"} applied` +
        (g.skipped ? ` (${g.skipped} rows skipped)` : "");
    } catch (err) {
      return `${file.name}: could not read glossary - ${err.message}`;
    }
  }

  window.addEventListener("beforeunload", (e) => {
    if (Object.keys(S.edits).length) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  renderSelected();
})();
