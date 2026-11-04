// Stamps index.html with a build version so browsers fetch fresh scripts
// after every release instead of reusing GitHub Pages' cached copies
// (Pages sends Cache-Control: max-age=600).
//
// The version is a short hash of the app's own files, so it changes exactly
// when one of them changes. It's written into:
//   - a ?v=<hash> query on each local <script>/<link> tag in index.html
//   - the small "build <hash>" label in the page header
//
// Run after changing any of the files below:
//   node scripts/stamp-version.js
// Check without writing (used by the tests):
//   node scripts/stamp-version.js --check
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const ROOT = path.join(__dirname, "..");
const INDEX = path.join(ROOT, "index.html");

// Files index.html loads directly. TinyMCE (vendor/) is left out - it only
// changes when deliberately upgraded and loads its own plugins by path.
const ASSETS = ["style.css", "docs-export.js", "app.js", "sn-core.js", "fixtures/demo-data.js", "servicenow.js"];

function computeVersion() {
  const h = crypto.createHash("sha256");
  for (const rel of ASSETS) {
    // Normalize line endings so Windows (CRLF) and CI (LF) checkouts agree.
    const text = fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
    h.update(rel + "\0" + text + "\0");
  }
  return h.digest("hex").slice(0, 8);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stamp(html, version) {
  let out = html;
  for (const rel of ASSETS) {
    const re = new RegExp(`((?:src|href)=")${escapeRe(rel)}(?:\\?v=[^"]*)?(")`, "g");
    out = out.replace(re, `$1${rel}?v=${version}$2`);
  }
  return out.replace(/(<span class="app-version" id="appVersion"[^>]*>)[^<]*(<\/span>)/, `$1build ${version}$2`);
}

function stampedVersions(html) {
  const found = new Set();
  for (const rel of ASSETS) {
    const m = new RegExp(`(?:src|href)="${escapeRe(rel)}\\?v=([^"]*)"`).exec(html);
    found.add(m ? m[1] : "(missing)");
  }
  const label = /<span class="app-version" id="appVersion"[^>]*>build ([^<]*)<\/span>/.exec(html);
  found.add(label ? label[1] : "(missing label)");
  return [...found];
}

module.exports = { ASSETS, computeVersion, stamp, stampedVersions };

if (require.main === module) {
  const html = fs.readFileSync(INDEX, "utf8");
  const version = computeVersion();
  if (process.argv.includes("--check")) {
    const found = stampedVersions(html);
    if (found.length === 1 && found[0] === version) {
      console.log(`index.html is stamped with the current build (${version}).`);
    } else {
      console.error(`index.html is stamped ${found.join(", ")} but the current build is ${version}. Run: node scripts/stamp-version.js`);
      process.exit(1);
    }
  } else {
    fs.writeFileSync(INDEX, stamp(html, version));
    console.log(`Stamped index.html with build ${version}.`);
  }
}
