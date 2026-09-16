# Bropacman Email Studio

*Not affiliated with, endorsed by, or sponsored by ServiceNow, Inc.
"ServiceNow" is a registered trademark of ServiceNow, Inc., referenced here
only to describe what this tool is built to preview.*

A small, no-login web tool that shows a live preview of what a notification
email will actually look like before it's sent — subject, recipients, header
banner, and body — without anyone having to open ServiceNow.

Built for people who aren't comfortable poking around ServiceNow's email
notification config but still need to sanity-check what a notification will
say before it goes out. Static HTML/CSS/JS, no backend, no build step — the
one dependency ([TinyMCE](https://www.tiny.cloud/), for the rich text body
editor) is vendored straight into the repo rather than pulled from a CDN or
bundled, so there's still nothing to install or compile.

## Use it

**https://bropacman.github.io/bropacman-email-studio/**

Fill in the fields on the left — including a rich text editor for the body,
matching ServiceNow's own notification message field — and the right-hand
pane updates live as an email preview. Use **Copy rendered HTML** or
**Download as .html** to grab the result and share it.

## Run it locally

Because the template dropdown loads `config/templates.json` via `fetch`,
opening `index.html` directly from disk (`file://`) will fail to load that
file in most browsers (CORS restrictions on local files). Serve the folder
instead:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

If `fetch` fails for any reason, the app falls back to one built-in sample
template so it still works.

## Adding your own layouts

Edit [`config/templates.json`](config/templates.json) — no code changes
needed. Each entry becomes an option in the "Start from a template" dropdown:

```json
{
  "id": "unique-id",
  "label": "Name shown in the dropdown",
  "from": "ServiceNow <noreply@yourinstance.service-now.com>",
  "to": "jane.doe@example.com",
  "cc": "",
  "subject": "Subject line",
  "headerText": "Text shown in the colored banner",
  "headerColor": "#293e40",
  "body": "<p>Body HTML. This is what the rich text editor loads.</p>"
}
```

`body` is HTML (whatever the rich text editor would produce — `<p>`,
`<ul>`/`<ol>`, `<a href>`, etc.), since the Body field itself is a WYSIWYG
editor, not a plain textarea. Selecting a template loads this HTML straight
into the editor; typing in the editor is how you'd normally write it instead
of hand-writing HTML in the config.

### The body editor (TinyMCE)

The Body field is a self-hosted [TinyMCE](https://www.tiny.cloud/) editor
(see `vendor/tinymce/`), not a plain textarea — bold/italic/underline, a
font family picker (Montserrat/Lora, matching the Beacon layout's fonts,
plus a couple of common fallbacks), bulleted and numbered lists with
indent/outdent, and links, matching what ServiceNow's own notification
message field supports. It's the open source Community edition (GPL),
vendored directly into this repo, so there's no API key, no account, and no
usage cap. Only a minimal set of plugins is included (`lists`, `link`,
`code`, `autolink`) to keep the footprint small; a "Source code" toolbar
button (the `code` plugin) lets you view or hand-edit the raw HTML when
needed.

The font picker's options are defined in `font_family_formats` in
`initTinyMce()` in `app.js` — add an entry there (and to the Google Fonts
`<link>`/`@import` URLs alongside it, and in `index.html`'s `<head>` and the
simple-template branch of `buildStandaloneHtml`, so it renders consistently
in the editor, the preview, and exported HTML) if you need another font.

To update TinyMCE later, download a newer `tinymce` package from npm and
replace the matching files under `vendor/tinymce/` — the exact set to keep
is whatever `initTinyMce()` in `app.js` references (`base_url`, `plugins`).

### Full custom layouts (real ServiceNow "Email Layout" HTML)

If a template needs its own complete wrapper HTML — a real `sys_email_layout`
export with its own header table, fonts, and footer, like ServiceNow's actual
notification layouts — add a `layoutHtml` field instead of `headerText` /
`headerColor`:

```json
{
  "id": "unique-id",
  "label": "Name shown in the dropdown",
  "from": "ServiceNow <noreply@yourinstance.service-now.com>",
  "to": "jane.doe@example.com",
  "cc": "",
  "subject": "Subject line",
  "body": "<p>The actual notification message HTML.</p>",
  "layoutHtml": "<table>...your full layout HTML, containing a ${notification:body} placeholder...</table>"
}
```

- `${notification:body}` inside `layoutHtml` gets replaced with whatever the
  Body editor contains.
- Any other `${...}` merge fields (e.g. `${mail_script:someScript}`) are left
  in place and highlighted in the preview, since those are filled in by
  ServiceNow at send time and can't be resolved here.
- The layout renders in its own sandboxed `<iframe>` so its own CSS/fonts
  don't collide with the app's styling.
- The body is real HTML from the rich text editor (paragraphs, lists,
  links...), and those are block-level tags. If `${notification:body}` sits
  inside something like `<p><span style="font-family:...">`, a block tag
  there forces the browser to auto-close that `<p>`/`<span>`, which would
  normally pop the inserted content out of the font-family scope entirely.
  To avoid that, the nearest `font-family` declared before the placeholder is
  detected and re-applied on an explicit wrapper around the body, so the
  layout's intended font holds regardless of where the browser's parser ends
  up placing the content (see `fillLayoutPlaceholders` in `app.js`).
- A "Preview with fallback fonts" checkbox appears for these templates so you
  can check how the layout degrades if a recipient's mail client blocks the
  web fonts (Google Fonts `<link>` tags get stripped and the CSS font-stack's
  next entry is used).

`config/templates.json` currently ships with one real example (`beacon-onboarding`)
plus two variants (`beacon-hr-case-sample`, `beacon-approval-sample`) that
reuse the same real layout structure with a different banner title — useful
for testing, but not pulled from a live instance. Swap their `layoutHtml` for
real exports as they become available.

## Files

- `index.html` — layout and form fields
- `style.css` — styling
- `app.js` — live preview logic, template loading, copy/download
- `config/templates.json` — editable list of starter templates/layouts
- `vendor/tinymce/` — self-hosted TinyMCE Community edition (GPL) powering
  the Body field's rich text editor
