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

  // Prepares email HTML for a Google Docs paste: drops tags Docs ignores or
  // that could misbehave (<script>, <style>, <link>, <meta>, <base>), embeds
  // same-origin images, and replaces images Docs could never load with a
  // visible text placeholder. Remote http(s) images are kept as absolute
  // URLs - Docs fetches those itself if they're publicly reachable.
  async function prepareForDocs(html) {
    const doc = new DOMParser().parseFromString(`<div id="__root">${html}</div>`, "text/html");
    const rootEl = doc.getElementById("__root");
    rootEl.querySelectorAll("script, style, link, meta, base, iframe, object, embed").forEach((el) => el.remove());
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

  // Small two-column table (label | value) - Google Docs keeps simple
  // bordered tables with inline styles intact.
  function headerTable(rows) {
    const cell = "border:1px solid #c7ced9;padding:4pt 6pt;vertical-align:top;font-family:Arial,sans-serif;font-size:10pt;";
    return (
      '<table style="border-collapse:collapse;width:100%;margin:0 0 12pt 0;">' +
      rows
        .map(
          ([label, value]) =>
            `<tr><td style="${cell}background-color:#f1f3f6;font-weight:bold;width:28%;" bgcolor="#f1f3f6">${escapeHtml(label)}</td>` +
            `<td style="${cell}">${escapeHtml(value).replace(/\n/g, "<br>")}</td></tr>`
        )
        .join("") +
      "</table>"
    );
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

  root.DocsExport = { escapeHtml, copyRich, copyText, download, prepareForDocs, headerTable, bannerTable, htmlToText };
})(window);
