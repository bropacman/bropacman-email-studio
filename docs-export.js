/*
 * docs-export.js - shared helpers for getting content out of the tool:
 * rich-text clipboard copies that paste cleanly into Google Docs, plain
 * text copies, and local Blob downloads. Nothing here sends data anywhere;
 * content only leaves the page when the user clicks a copy/download button.
 */
(function (root) {
  "use strict";

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Copies HTML + plain-text fallback. Prefers the async Clipboard API; falls
  // back to a synthetic copy event (works in older browsers and on file://).
  async function copyRich(html, text) {
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        return true;
      }
    } catch (err) {
      // fall through to the copy-event approach
    }
    let ok = false;
    const onCopy = (e) => {
      e.clipboardData.setData("text/html", html);
      e.clipboardData.setData("text/plain", text);
      e.preventDefault();
      ok = true;
    };
    document.addEventListener("copy", onCopy);
    try {
      document.execCommand("copy");
    } finally {
      document.removeEventListener("copy", onCopy);
    }
    return ok;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err) {
      return copyRich(escapeHtml(text).replace(/\n/g, "<br>"), text);
    }
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  // Google Docs can't fetch images from relative paths, file:// or
  // logged-in hosts, so same-origin images are embedded as data: URIs.
  async function toDataUrl(absUrl) {
    try {
      const res = await fetch(absUrl);
      if (res.ok) return await blobToDataUrl(await res.blob());
    } catch (err) {
      // fetch() of file:// URLs fails in most browsers; try a canvas instead
    }
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          resolve(c.toDataURL("image/png"));
        } catch (err) {
          resolve(null); // tainted canvas (file:// in Chrome)
        }
      };
      img.onerror = () => resolve(null);
      img.src = absUrl;
    });
  }

  // Google Docs takes email layout literally: fixed row heights become tall
  // empty bands, spacer rows/tables become gaps, a background wrapper table
  // becomes a grey frame, and calc() font sizes are misread. This flattens
  // all of that while keeping the real structure (banner columns, content,
  // footer, inner tables) and every piece of text.
  const isBlank = (el) => !el.querySelector("img") && el.textContent.replace(/[\s ]/g, "") === "";

  function tidyForDocs(root) {
    // 1. Spacer rows and tables: no text, no images.
    root.querySelectorAll("tr").forEach((tr) => isBlank(tr) && tr.remove());
    root.querySelectorAll("table").forEach((t) => isBlank(t) && t.remove());

    // 2. Background wrapper tables: a single cell whose only content is
    //    another table. Replace the wrapper with what's inside it.
    let changed = true;
    while (changed) {
      changed = false;
      for (const t of root.querySelectorAll("table")) {
        if (t.rows.length !== 1 || t.rows[0].cells.length !== 1) continue;
        const cell = t.rows[0].cells[0];
        const kids = [...cell.childNodes].filter(
          (n) => !(n.nodeType === 3 && !n.nodeValue.trim()) && !(n.nodeType === 1 && n.tagName !== "TABLE" && isBlank(n))
        );
        if (kids.length && kids.every((n) => n.nodeType === 1 && n.tagName === "TABLE")) {
          t.replaceWith(...kids);
          changed = true;
          break;
        }
      }
    }

    // 3. Truly empty paragraphs/divs (deliberate &nbsp; spacer paragraphs
    //    in the body are kept).
    root.querySelectorAll("p, div").forEach((el) => {
      if (!el.querySelector("img, table, br") && el.textContent.replace(/[ \t\r\n]/g, "") === "") el.remove();
    });

    // 4. Sizing: drop fixed heights everywhere, pixel widths and auto
    //    margins on tables/cells (percentage widths are kept), and turn
    //    calc() font sizes into their first plain size.
    root.querySelectorAll("*").forEach((el) => {
      el.removeAttribute("height");
      const tableish = /^(TABLE|TD|TH|TR|TBODY)$/.test(el.tagName);
      if (tableish && /px$|^\d+$/.test(el.getAttribute("width") || "")) el.removeAttribute("width");
      const style = el.getAttribute("style");
      if (!style) return;
      const kept = style
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !/^(height|min-height|max-height)\s*:/i.test(s))
        .filter((s) => !(tableish && /^(width|max-width|min-width)\s*:\s*[\d.]+px/i.test(s)))
        .filter((s) => !/^margin\s*:.*auto/i.test(s))
        .map((s) => {
          const m = /^font-size\s*:\s*calc\(\s*([\d.]+(?:px|pt|em|rem))/i.exec(s);
          return m ? `font-size: ${m[1]}` : s;
        })
        .filter((s) => !/^font-size\s*:\s*calc\(/i.test(s));
      if (kept.length) el.setAttribute("style", kept.join("; "));
      else el.removeAttribute("style");
    });
  }

  // Prepares email HTML for a Google Docs paste: drops tags Docs ignores or
  // that could misbehave (<script>, <style>, <link>, <meta>, <base>), embeds
  // same-origin images, and replaces images Docs could never load with a
  // visible text placeholder. Remote http(s) images are kept as absolute
  // URLs - Docs fetches those itself if they're publicly reachable.
  async function prepareForDocs(html) {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
    const rootEl = doc.getElementById("__root");
    rootEl.querySelectorAll("script, style, link, meta, base, iframe, object, embed").forEach((el) => el.remove());
    tidyForDocs(rootEl);
    const base = document.baseURI;
    await Promise.all(
      [...rootEl.querySelectorAll("img")].map(async (img) => {
        const src = (img.getAttribute("src") || "").trim();
        if (/^data:/i.test(src)) return;
        let abs;
        try {
          abs = new URL(src, base);
        } catch (err) {
          abs = null;
        }
        const local = abs && (abs.protocol === "file:" || abs.origin === location.origin);
        if (local) {
          const data = await toDataUrl(abs.href);
          if (data) {
            img.setAttribute("src", data);
            return;
          }
        } else if (abs && /^https?:$/.test(abs.protocol)) {
          img.setAttribute("src", abs.href);
          return;
        }
        const ph = doc.createElement("span");
        ph.setAttribute("style", "border:1px dashed #999;color:#555;padding:2px 6px;font-family:Arial,sans-serif;font-size:10pt;");
        ph.textContent = `[Image: ${img.getAttribute("alt") || src || "image"}]`;
        img.replaceWith(ph);
      })
    );
    return rootEl.innerHTML;
  }

  // A value cell: plain text, or { href, text } for a link (href must
  // already be a vetted http(s) URL).
  function cellValue(v) {
    if (v && typeof v === "object" && v.href) {
      return `<a href="${escapeHtml(v.href)}" style="color:#1a4fb5;">${escapeHtml(v.text || v.href)}</a>`;
    }
    return escapeHtml(v).replace(/\n/g, "<br>");
  }

  function cellText(v) {
    return v && typeof v === "object" && v.href ? `${v.text || v.href} (${v.href})` : String(v == null ? "" : v);
  }

  // Small two-column table (label | value) - Google Docs keeps simple
  // bordered tables with inline styles intact.
  function headerTable(rows) {
    const cell = "border:1px solid #dde3ea;padding:2pt 5pt;vertical-align:top;font-family:Arial,sans-serif;font-size:8.5pt;color:#3c4656;";
    return (
      '<table style="border-collapse:collapse;width:100%;margin:0 0 12pt 0;">' +
      rows
        .map(
          ([label, value]) =>
            `<tr><td style="${cell}background-color:#f6f7f9;font-weight:bold;width:20%;white-space:nowrap;" bgcolor="#f6f7f9">${escapeHtml(label)}</td>` +
            `<td style="${cell}">${cellValue(value)}</td></tr>`
        )
        .join("") +
      "</table>"
    );
  }

  // Compact table with a header row (Variables list, cover page list).
  // opts.codeFirstColumn styles the first column as code (variable names).
  function gridTable(headers, rows, opts) {
    const codeFirst = !!(opts && opts.codeFirstColumn);
    const cell = "border:1px solid #dde3ea;padding:2pt 5pt;vertical-align:top;font-family:Arial,sans-serif;font-size:8.5pt;color:#3c4656;";
    const head = headers
      .map((x) => `<td style="${cell}background-color:#f6f7f9;font-weight:bold;" bgcolor="#f6f7f9">${escapeHtml(x)}</td>`)
      .join("");
    const body = rows
      .map(
        (r) =>
          "<tr>" +
          r
            .map((v, i) => `<td style="${cell}${codeFirst && i === 0 ? "font-family:Consolas,'Courier New',monospace;color:#1a4fb5;white-space:nowrap;" : ""}">${escapeHtml(v)}</td>`)
            .join("") +
          "</tr>"
      )
      .join("");
    return `<table style="border-collapse:collapse;width:100%;margin:0 0 12pt 0;"><tr>${head}</tr>${body}</table>`;
  }

  // A colored banner as a one-cell table, since Docs drops <div>
  // backgrounds but keeps table cell backgrounds.
  function bannerTable(text, color) {
    const c = escapeHtml(color || "#293e40");
    return (
      '<table style="border-collapse:collapse;width:100%;"><tr>' +
      `<td bgcolor="${c}" style="background-color:${c};color:#ffffff;padding:10pt 12pt;font-family:Arial,sans-serif;font-size:14pt;font-weight:bold;">${escapeHtml(text)}</td>` +
      "</tr></table>"
    );
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.innerText || doc.body.textContent || "").replace(/\n{3,}/g, "\n\n").trim();
  }

  root.DocsExport = { escapeHtml, copyRich, copyText, download, prepareForDocs, headerTable, gridTable, bannerTable, htmlToText, cellText };
})(window);
