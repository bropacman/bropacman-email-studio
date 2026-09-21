(function () {
  "use strict";

  const els = {
    from: document.getElementById("from"),
    to: document.getElementById("to"),
    cc: document.getElementById("cc"),
    subject: document.getElementById("subject"),
    headerText: document.getElementById("headerText"),
    headerColor: document.getElementById("headerColor"),
    body: document.getElementById("body"),
    preset: document.getElementById("preset"),
    copyHtml: document.getElementById("copyHtml"),
    downloadHtml: document.getElementById("downloadHtml"),
    copyBodyHtml: document.getElementById("copyBodyHtml"),
    simpleHeaderFields: document.getElementById("simpleHeaderFields"),
    layoutNotice: document.getElementById("layoutNotice"),
    fallbackFonts: document.getElementById("fallbackFonts"),
    pv: {
      from: document.getElementById("pv-from"),
      to: document.getElementById("pv-to"),
      cc: document.getElementById("pv-cc"),
      ccRow: document.querySelector(".cc-row"),
      subject: document.getElementById("pv-subject"),
      banner: document.getElementById("pv-banner"),
      body: document.getElementById("pv-body"),
      layout: document.getElementById("pv-layout"),
    },
  };

  // Set once the TinyMCE editor attached to #body has finished initializing.
  let bodyEditor = null;

  // Populated from config/templates.json at load time. Keyed by template id.
  let TEMPLATES = {};

  // Full HTML wrapper (with a ${notification:body} placeholder) from the
  // currently selected template, if any. Null means "simple banner mode".
  let currentLayoutHtml = null;

  const FALLBACK_TEMPLATES = [
    {
      id: "incident-assigned",
      label: "Incident Assigned to You",
      subject: "INC0010023 has been assigned to you",
      headerText: "Incident Assigned to You",
      headerColor: "#c0392b",
      to: "jane.doe@example.com",
      cc: "",
      body:
        "<p>Hi Jane,</p>" +
        "<p>A new incident has been assigned to you.</p>" +
        "<p>Number: INC0010023<br>Priority: 2 - High<br>" +
        "Short description: VPN connection failing for remote users<br>" +
        "Assignment group: Network Support</p>" +
        "<p>Please review and update the incident within your team's SLA window.</p>" +
        '<p>View Incident: <a href="https://yourinstance.service-now.com/nav_to.do?uri=incident.do?sys_id=abcd1234">https://yourinstance.service-now.com/nav_to.do?uri=incident.do?sys_id=abcd1234</a></p>' +
        "<p>Thanks,<br>ServiceNow</p>",
    },
  ];

  // Normalizes the body HTML: unwraps empty/no-op <span> tags (handled via
  // the DOM, not regex, so nesting doesn't break it), strips Word/Outlook
  // paste artifacts (mso- inline styles, empty <o:p> tags, Mso* classes,
  // conditional comments), collapses runs of non-breaking spaces and <br>
  // tags, and collapses/trims redundant empty paragraphs - the usual mess
  // left behind by pasting from Word, Outlook, or Google Docs.
  function cleanUpBodyContent() {
    if (!bodyEditor) return;
    const dom = bodyEditor.dom;

    dom.select("span", bodyEditor.getBody()).forEach((span) => {
      const style = (span.getAttribute("style") || "").trim();
      const cls = (span.getAttribute("class") || "").trim();
      if (!style && !cls) dom.remove(span, true);
    });

    let html = bodyEditor.getContent();

    html = html.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");
    html = html.replace(/<o:p>\s*<\/o:p>/gi, "");
    html = html.replace(/\s*mso-[a-z-]+\s*:[^;"']+;?/gi, "");
    html = html.replace(/\sclass="Mso[A-Za-z0-9]*"/gi, "");
    html = html.replace(/(?:&nbsp;| ){2,}/gi, " ");
    html = html.replace(/(<br\s*\/?>\s*){3,}/gi, "<br><br>");
    html = html.replace(/(?:<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*){2,}/gi, "<p>&nbsp;</p>");
    html = html.replace(/^(?:\s*<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+/i, "");
    html = html.replace(/(?:\s*<p>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/i, "");
    html = html.replace(/\s(?:style|class)="\s*"/gi, "");

    bodyEditor.setContent(html.trim());
    render();
  }

  // Captures the editor via the setup() callback (guaranteed to fire once
  // TinyMCE attaches to #body) and resolves once it's actually ready, rather
  // than relying on interpreting tinymce.init()'s own return value.
  function initTinyMce() {
    return new Promise((resolve) => {
      tinymce.init({
        selector: "#body",
        base_url: "vendor/tinymce",
        suffix: ".min",
        license_key: "gpl",
        menubar: false,
        statusbar: false,
        branding: false,
        promotion: false,
        height: 320,
        plugins: "lists link code autolink",
        toolbar:
          "undo redo | fontfamily | bold italic underline | bullist numlist outdent indent | link | code | cleanupformatting",
        // "wrap" (rather than the default "floating") shows every toolbar
        // button, wrapping onto additional rows as needed, instead of
        // collapsing overflow into a "..." dropdown.
        toolbar_mode: "wrap",
        // Match the font stacks the Beacon layout itself uses (see
        // layoutHtml in config/templates.json), so picking "Montserrat" or
        // "Lora" here previews the same fallback chain the real layout gets.
        font_family_formats:
          "Default=-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;" +
          "Montserrat=Montserrat,arial,sans-serif;" +
          "Lora=Lora,georgia,serif;" +
          "Arial=arial,helvetica,sans-serif;" +
          "Georgia=georgia,palatino,serif;" +
          "Courier New=courier new,courier,monospace",
        content_style:
          // @import (rather than content_css) so this loads alongside the
          // theme's own default content CSS instead of replacing it, and
          // the editor's canvas actually renders Montserrat/Lora when
          // selected instead of just applying an invisible font-family name.
          "@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400&family=Montserrat:ital,wght@0,400;0,700;1,400&display=swap');\n" +
          'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 14px; }',
        setup(editor) {
          bodyEditor = editor;
          // No built-in sparkle/star icon in this icon pack ("ai" is
          // literally the letters "AI", "ai-assistant" is a magic wand) -
          // register a custom two-star sparkle instead.
          editor.ui.registry.addIcon(
            "sparkles",
            '<svg width="24" height="24"><path d="M12 2L14 9L21 11L14 13L12 20L10 13L3 11L10 9Z"/>' +
              '<path d="M19 1L19.9 3.6L22.5 4.5L19.9 5.4L19 8L18.1 5.4L15.5 4.5L18.1 3.6Z"/></svg>'
          );
          editor.ui.registry.addButton("cleanupformatting", {
            icon: "sparkles",
            tooltip: "Clean up formatting (remove redundant spans, spacing, empty paragraphs)",
            onAction: () => cleanUpBodyContent(),
          });
          // Not "SetContent": applyPreset() calls setContent() itself and
          // explicitly re-renders afterward once currentLayoutHtml/header
          // fields are updated. Also listening for SetContent here fires a
          // render() mid-applyPreset, before those fields are updated to the
          // newly-selected template - showing the new body with the
          // previous template's banner until the explicit render() call
          // (below, now reordered to run last) corrects it.
          editor.on("input undo redo Change", () => render());
          editor.on("init", () => resolve(editor));
        },
      });
    });
  }

  async function loadTemplates() {
    try {
      const res = await fetch("config/templates.json", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.templates) ? data.templates : [];
    } catch (err) {
      console.warn(
        "Could not load config/templates.json (this is expected if you opened this file directly " +
          "in a browser instead of via a local server or GitHub Pages). Using built-in fallback templates.",
        err
      );
      return FALLBACK_TEMPLATES;
    }
  }

  function populatePresetDropdown(templates) {
    templates.forEach((t) => {
      TEMPLATES[t.id] = t;
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.label || t.id;
      els.preset.appendChild(opt);
    });
  }

  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderBodyHtml() {
    return bodyEditor ? bodyEditor.getContent() : "";
  }

  // Looks backward from a marker for the nearest font-family declaration, so
  // we can carry a layout's intended font onto the body we're inserting.
  function detectFontFamilyBefore(html, marker) {
    const idx = html.indexOf(marker);
    if (idx === -1) return null;
    const before = html.slice(0, idx);
    const matches = [...before.matchAll(/font-family:\s*([^;"']+)/gi)];
    return matches.length ? matches[matches.length - 1][1].trim() : null;
  }

  // ServiceNow layouts/notifications use ${...} merge fields (e.g.
  // ${notification:body}, ${mail_script:someScript}). We substitute the one
  // we know how to fill (notification:body) and visually flag any others
  // that are left, so it's clear they're dynamic values ServiceNow would
  // fill in at send time rather than something broken in the preview.
  //
  // The body comes from a rich text editor, so it's real HTML: paragraphs,
  // lists, etc. Those are block-level tags, and ${notification:body} usually
  // sits inside a real layout's <p><span style="font-family:...">. A block
  // tag there forces the browser to auto-close that <p>/<span> per HTML
  // parsing rules, which pops the inserted content out of the font-family
  // scope entirely. Rather than fight that, we detect the font-family that
  // would have applied and re-declare it on an explicit wrapper, so it holds
  // regardless of where the browser's parser ends up placing the content.
  function fillLayoutPlaceholders(layoutHtml, bodyHtml) {
    const fontFamily = detectFontFamilyBefore(layoutHtml, "${notification:body}");
    const wrappedBody = fontFamily ? `<div style="font-family:${fontFamily};">${bodyHtml}</div>` : bodyHtml;
    const withBody = layoutHtml.replace(/\$\{notification:body\}/g, () => wrappedBody);
    return withBody.replace(/\$\{([^}]+)\}/g, (match, token) => {
      return `<span style="background:#fff3b0;padding:0 2px;border-radius:3px;" title="Dynamic ServiceNow value: ${escapeHtml(
        token
      )}">${escapeHtml(match)}</span>`;
    });
  }

  // Simulates a recipient's mail client blocking web fonts. Removing just the
  // Google Fonts <link> isn't enough on its own: Montserrat/Lora are common
  // enough that many systems already have them installed locally, so the
  // browser would still match them by name. To force a real fallback we also
  // strip the primary font name out of any font-family declaration so the
  // browser has to use the next entry in the stack (e.g. Arial/Georgia).
  function stripWebFonts(html) {
    let out = html.replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/gi, "");
    out = out.replace(/font-family:\s*(['"]?)(Montserrat|Lora)\1\s*,\s*/gi, "font-family: ");
    return out;
  }

  // Links in a real layout (or in pasted-in body HTML) are ordinary <a
  // href> tags. Inside the preview iframe, clicking one would otherwise
  // navigate the iframe itself away from the rendered srcdoc to that URL -
  // which is almost always a placeholder/dead link here - replacing the
  // preview with a broken page. <base target="_blank"> makes every link in
  // the iframe open in a new tab instead, leaving the preview itself intact.
  const PREVIEW_LINK_TARGET = '<base target="_blank">';

  // Same idea for the simple-mode preview, which isn't in an iframe: force
  // every link to open in a new tab rather than navigating the app away.
  function openLinksInNewTab(container) {
    container.querySelectorAll("a[href]").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
  }

  function resizeLayoutFrame() {
    try {
      const doc = els.pv.layout.contentDocument;
      if (doc && doc.body) {
        els.pv.layout.style.height = doc.body.scrollHeight + 20 + "px";
      }
    } catch (err) {
      // ignore
    }
  }

  // Reassigning an iframe's srcdoc always forces a full reload - the iframe
  // blanks and repaints even if the new HTML is nearly identical to the old.
  // render() fires on every keystroke in the body editor, so updating a
  // layout template's iframe immediately meant a visible flicker on every
  // character typed. Debouncing just this one operation (everything else in
  // render() still updates instantly - only the iframe reload is delayed)
  // waits for a brief pause in typing instead, cutting reload frequency
  // drastically without making the rest of the preview feel laggy.
  let layoutFrameTimer = null;
  function scheduleLayoutFrameUpdate(srcdoc) {
    clearTimeout(layoutFrameTimer);
    layoutFrameTimer = setTimeout(() => {
      els.pv.layout.srcdoc = srcdoc;
      els.pv.layout.onload = resizeLayoutFrame;
    }, 250);
  }

  function render() {
    els.pv.from.textContent = els.from.value.trim() || "(no sender set)";
    els.pv.to.textContent = els.to.value.trim() || "(no recipients)";

    const cc = els.cc.value.trim();
    els.pv.cc.textContent = cc;
    els.pv.ccRow.classList.toggle("empty", cc.length === 0);

    els.pv.subject.textContent = els.subject.value.trim() || "(no subject)";

    if (currentLayoutHtml) {
      els.pv.banner.hidden = true;
      els.pv.body.hidden = true;
      els.pv.layout.hidden = false;
      // Fallback-font stripping has to apply to the body too, not just the
      // static layout wrapper - a header styled via the editor's own font
      // picker (e.g. a bold Montserrat section heading) lives in the body,
      // and would otherwise keep rendering in Montserrat regardless of this
      // toggle.
      const sourceLayout = els.fallbackFonts.checked
        ? stripWebFonts(currentLayoutHtml)
        : currentLayoutHtml;
      const sourceBody = els.fallbackFonts.checked
        ? stripWebFonts(renderBodyHtml())
        : renderBodyHtml();
      scheduleLayoutFrameUpdate(PREVIEW_LINK_TARGET + fillLayoutPlaceholders(sourceLayout, sourceBody));
    } else {
      // Cancel any pending debounced iframe update from before switching
      // away from a layout template, so it can't fire afterward and
      // overwrite the srcdoc clear below with stale layout content.
      clearTimeout(layoutFrameTimer);
      els.pv.layout.hidden = true;
      els.pv.layout.srcdoc = "";
      els.pv.banner.hidden = false;
      els.pv.body.hidden = false;

      const headerText = els.headerText.value.trim();
      els.pv.banner.textContent = headerText;
      els.pv.banner.style.background = els.headerColor.value;

      els.pv.body.innerHTML = renderBodyHtml() || "<em>(empty body)</em>";
      openLinksInNewTab(els.pv.body);
    }
  }

  function buildStandaloneHtml() {
    const from = escapeHtml(els.from.value.trim());
    const to = escapeHtml(els.to.value.trim());
    const cc = els.cc.value.trim();
    const subject = escapeHtml(els.subject.value.trim());
    const bodyHtml = renderBodyHtml();

    const metaBlock = `
    <div class="meta">
      <div><span class="label">From</span>${from}</div>
      <div><span class="label">To</span>${to}</div>
      ${cc ? `<div><span class="label">Cc</span>${escapeHtml(cc)}</div>` : ""}
      <div><span class="label">Subject</span><strong>${subject}</strong></div>
    </div>`;

    if (currentLayoutHtml) {
      const sourceLayout = els.fallbackFonts.checked
        ? stripWebFonts(currentLayoutHtml)
        : currentLayoutHtml;
      const strippedBodyHtml = els.fallbackFonts.checked ? stripWebFonts(bodyHtml) : bodyHtml;
      const layoutContent = fillLayoutPlaceholders(sourceLayout, strippedBodyHtml);
      return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${subject || "Email Preview"}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 0; color: #1f2a29; }
  .meta { padding: 18px 24px; border-bottom: 1px solid #dde3e2; font-size: 13px; background: #fff; }
  .meta div { margin-bottom: 4px; }
  .label { color: #6b7776; display: inline-block; width: 60px; }
</style>
</head>
<body>
  ${metaBlock}
  ${layoutContent}
</body>
</html>`;
    }

    const headerText = escapeHtml(els.headerText.value.trim());
    const headerColor = els.headerColor.value;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>${subject || "Email Preview"}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,700;1,400&family=Montserrat:ital,wght@0,400;0,700;1,400&display=swap">
<style>
  body { font-family: Arial, Helvetica, sans-serif; background: #f4f6f6; margin: 0; padding: 24px; color: #1f2a29; }
  .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #dde3e2; border-radius: 8px; overflow: hidden; }
  .meta { padding: 18px 24px; border-bottom: 1px solid #dde3e2; font-size: 13px; }
  .meta div { margin-bottom: 4px; }
  .label { color: #6b7776; display: inline-block; width: 60px; }
  .banner { padding: 22px 24px; color: #fff; font-size: 18px; font-weight: bold; }
  .body { padding: 24px; font-size: 14px; line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">
    ${metaBlock}
    ${headerText ? `<div class="banner" style="background:${headerColor}">${headerText}</div>` : ""}
    <div class="body">${bodyHtml}</div>
  </div>
</body>
</html>`;
  }

  function applyPreset(key) {
    els.fallbackFonts.checked = false;

    if (!key) {
      currentLayoutHtml = null;
      els.simpleHeaderFields.hidden = false;
      els.layoutNotice.hidden = true;
      if (bodyEditor) bodyEditor.setContent("");
      render();
      return;
    }
    if (!TEMPLATES[key]) return;
    const p = TEMPLATES[key];

    if (p.from) els.from.value = p.from;
    els.subject.value = p.subject || "";
    els.to.value = p.to || "";
    els.cc.value = p.cc || "";

    // Update layout/header state before touching the body editor, so
    // whatever render() sees - whether triggered by this function's own
    // final call below or by an event the editor fires internally - already
    // reflects the newly-selected template, not the previous one.
    if (p.layoutHtml) {
      currentLayoutHtml = p.layoutHtml;
      els.simpleHeaderFields.hidden = true;
      els.layoutNotice.hidden = false;
    } else {
      currentLayoutHtml = null;
      els.simpleHeaderFields.hidden = false;
      els.layoutNotice.hidden = true;
      els.headerText.value = p.headerText || "";
      els.headerColor.value = p.headerColor || "#293e40";
    }

    if (bodyEditor) bodyEditor.setContent(p.body || "");
    render();
  }

  [els.from, els.to, els.cc, els.subject, els.headerText, els.headerColor].forEach((el) =>
    el.addEventListener("input", render)
  );
  els.preset.addEventListener("change", (e) => applyPreset(e.target.value));
  els.fallbackFonts.addEventListener("change", render);

  async function copyToClipboard(button, text) {
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = "Copied!";
      setTimeout(() => (button.textContent = original), 1500);
    } catch (err) {
      alert("Could not copy automatically. Use the Download button instead.");
    }
  }

  els.copyHtml.addEventListener("click", () => copyToClipboard(els.copyHtml, buildStandaloneHtml()));

  // Just the Body field's own HTML, no meta block/banner/layout wrapper - for
  // pasting directly into ServiceNow's Message HTML field, since the layout
  // (if any) is a separate record there, not part of the notification body.
  els.copyBodyHtml.addEventListener("click", () => copyToClipboard(els.copyBodyHtml, renderBodyHtml()));

  els.downloadHtml.addEventListener("click", () => {
    const html = buildStandaloneHtml();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "email-preview.html";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  (async function init() {
    const [, templates] = await Promise.all([initTinyMce(), loadTemplates()]);
    populatePresetDropdown(templates);
    render();
  })();
})();
