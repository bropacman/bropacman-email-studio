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
pane updates live as an email preview.

- **Copy rendered HTML** / **Download as .html** — the whole simulated email
  (meta block plus banner or full layout), to share the preview itself.
- **Copy body HTML only** — just the Body field's own HTML, no wrapper, for
  pasting straight into ServiceNow's Message HTML field (the layout, if any,
  is a separate record there, not part of the notification body).
- **Copy for Google Docs** — From/To/Cc/Subject as a small table, then the
  banner (or full layout) and body, with images embedded, formatted to paste
  cleanly into a Google Doc.
- The body editor's **full screen** button (far right of its toolbar)
  expands it over the whole window; press Esc or the button again to exit.

## ServiceNow import (notification review for Google Docs / Sheets)

The **ServiceNow import** tab reads ServiceNow XML exports and turns each
notification into something a process owner can read and comment on.

HR emails come from three places, and all three are listed together:

| Source | Table | Body field | When it sends / who receives it |
| --- | --- | --- | --- |
| Notification | `sysevent_email_action` | `message_html` (or its template's) | on the record: trigger, condition, recipients |
| HR email content | `sn_hr_core_email_content` | `message_html` | set on the **Lifecycle Event activity** that uses it |
| Content delivery | `sn_cd_content_notification` | `rich_text_plain_html` (layout built in) | set in **Content Publishing** (schedule and audience); the record has `state` (Draft badge), `from` and `reply_to` |

HR email content and content delivery records have no category in
ServiceNow. Until you assign one, they group under "HR email content" and
"Content delivery". To put them in a program:

- **One at a time:** type a category in the record's **Category** field.
  It suggests your existing notification categories.
- **In bulk:** export the inventory (CSV or copy for Sheets). Unassigned
  HR email content and content delivery rows have an empty **Category**
  cell. Fill those in the sheet, download the tab as CSV, and drop it on
  the import box. Rows are matched by `sys_id`. Only these two record types
  take a category from the sheet; notifications always keep ServiceNow's.

Assigned categories show as "… (assigned here)". The inventory's
**Category source** column says ServiceNow / Assigned in tool / Not
assigned. Assigned categories are saved in the settings JSON. Assigned
records join that category's filter, Program Doc and cover counts. Their "When it sends" and "Who receives it" sections say
where that's configured instead of guessing. Content delivery bodies
already contain their layout, so the "Simplified layout" Docs option has
no layout to simplify for them; their Docs copy still gets the general
tidy-up (no fixed heights, spacer rows or grey wrapper). The Advanced edit
works on each source's own body field, with the same byte-preserving XML
download. The inventory has a **Source** column.

For each record:

- a list of notifications, searchable and grouped by category, filterable by
  category, table and active
- **When it sends**: table, insert/update/event, and the `condition` encoded
  query in plain English (`^` = AND, `^OR` = OR, `^NQ` = a new OR'd query).
  Tables and fields are shown by **friendly label** (see below). Where the export itself includes a label for
  a reference value (the `<item display_value=...>` rows ServiceNow adds
  inside `<condition>`), it's shown next to the raw sys_id. Advanced
  (scripted) conditions show **"Custom script logic — ask HRIT"** instead of
  a translation.
- **Who receives it**: recipient fields, users, groups (sys_ids as
  exported), event parm 1/2 and "send to event creator"
- a **preview** with editable fake sample data (`${number}` → `HRC0001234`,
  `${opened_for.name}` → `Jane Sample`, …). `${mail_script:name}` shows up as a
  **[Dynamic content: name]** box. Mail scripts are never executed. In the
  **Mail scripts** section you can type what each script does and an
  **example of its output**. With "Use mail script examples" on (the
  default), the example replaces the box in the preview and the Docs copy,
  in a dashed outline so readers can tell it's generated. The script's
  source is in a collapsible panel for developers.
- **Copy for Google Docs**: one notification, under its name as a
  heading. In order:
  1. a small table (notification name, when it sends, last updated)
  2. a **Variables** table: each `${variable}` the email uses, the meaning
     you typed for it in the Sample data panel, and an example value
  3. a **Mail scripts** table: each mail script the email uses, what it
     does, and its example output
  4. the email's From / To / Subject (users and groups are counted, not
     listed by sys_id)
  5. the email itself

  Variables show by name (as `${opened_for.first_name}` chips), so readers
  learn what each one is. Untick "Show ${variable} names" to get sample
  values instead. Meanings are kept in memory and saved with the settings
  JSON (see below), so you can write them once and reload them. By
  default the email uses a **simplified layout**: all of the layout's text is
  kept, but the shape is flattened so the Doc isn't distorted. The rows
  above the body become one plain colored banner. The row holding
  `${notification:body}` keeps its full content (headline, details table,
  disclaimer, body, signature). The rows below become footer text under a
  thin line. The background, spacer rows and fixed sizes are dropped. You
  can switch to the full layout or the notification body only. In every
  mode the copy is tidied for Docs: spacer rows/tables and background
  wrapper tables are removed, along with fixed heights, pixel widths and
  `calc()` font sizes (this also applies to the Composer tab's Docs copy).
  Images become a `[Logo]` label, both in the Doc and wherever a relative
  image URL can't load in the preview.
- **Program Doc** (sidebar, under the exports): one Google Doc per
  program, on a single page. Headings replace tabs, because Docs tab names
  cut off early. Pick a category in the filter, then **Copy whole program
  for Google Docs** and paste into an empty Doc. It contains:
  - the **cover**: the program title (Heading 1) and a summary table
    (program, process owner group, links to the strategy doc and inventory
    sheet, the notification count (total / active / inactive / with custom
    script logic), and the export date). Then "About this program"
    (strategy and description), "How to review" (default text you can
    edit), and a numbered list of the category's notifications.
  - **every notification** in that order, each under a numbered Heading 2
    ("1. HR Case opened…") with its tables and email. They're separated by
    a **divider line** (the default, which works in pageless Docs) or a
    **page break** (for paged or printed Docs).

  The Doc's outline then lists every notification at full length. For
  clickable links, put the cursor on the cover's tip line and use
  **Insert → Table of contents**. Pasted content can't create Docs
  bookmarks or heading links itself. **Copy cover page only** and each
  notification's own **Copy for Google Docs** (which includes its heading)
  are there for re-pasting one updated piece.

  ServiceNow doesn't hold the description, owner group or links, so you
  type them per category. Only http(s) links are used; anything else is
  shown as text.
- **Settings JSON**: **Export / Import settings JSON** saves everything
  you've typed (sample values, variable meanings, mail script descriptions
  and examples, and every program's cover fields) to one file you keep, so
  the next session starts where you left
  off. Nothing is saved automatically. The older sample-data-only JSON
  still imports.
- **Glossary tab** (sidebar): mail script descriptions and variable
  meanings are stored by name, so a shared script or variable is
  described once and applies to every notification that uses it. To keep
  them in the inventory Google Sheet, where the whole team can maintain
  them:
  1. **Copy glossary for Google Sheets** → paste into cell A1 of a
     **Glossary** tab. There's one row per mail script and `${variable}`
     used across all imported notifications (Type, Name, Meaning / what it
     does, Example, Used by), with shared scripts listed first, most-used
     at the top. **Export glossary CSV** gives the same as a file, and
     keeps line breaks in examples.
  2. The team fills in the Meaning and Example columns in the sheet.
  3. Next session: in the sheet, use **File → Download → Comma-separated
     values** for the Glossary tab, then **Import glossary CSV**, or drop
     the CSV on the main import box. Empty cells don't overwrite anything
     already typed. Columns can be reordered.

  The CSV goes from Sheets to your computer to this tab, and nothing
  connects to Google. A settings JSON dropped on the import box is
  applied too.
- **Export inventory CSV** / **Copy inventory for Google Sheets**: one row
  per notification in the current filter (name, category, table label,
  table name, trigger summary, recipients summary, active, has advanced
  condition, uses mail scripts, template name, sys_id, sys_updated_on)

**Friendly labels.** Business readers see labels instead of technical
names. They're worked out from the name itself, with no dictionary export
needed:

- **fields**: drop a leading `u_`, underscores become spaces, sentence
  case, common acronyms upper-cased, and dot-walks joined with "›".
  `opened_for` → "Opened for", `u_start_date` → "Start date",
  `opened_for.first_name` → "Opened for › First name", `hr_service` →
  "HR service". `sys_` fields use their standard labels (`sys_updated_on`
  → "Updated").
- **tables**: the same, in Title Case, with the scope prefix dropped
  (`sn_hr_core_case` → "HR Case"). A few standard tables whose label
  doesn't follow the name are built in (`sn_hr_le_case` → "Lifecycle Event
  Case").

Labels are used in the Google Docs copies, the program cover, the
inventory summaries, the preview's "To" line, the table filter and the list.
The app's detail panel shows the label with the technical name beside it
in grey, for admins. `${variables}` and mail script names keep their names
everywhere (in the email, the Variables table and the Mail scripts table).
Choice values (e.g. `State is one of "10", "18"`) stay as their stored
values, since those labels are instance-specific.
- **Advanced: edit & download XML** (off by default): edit `subject` and
  `message_html` of the notification or its template and download a
  single-record XML **for import into a DEV instance only**

Subject/body precedence follows ServiceNow: the notification's own subject
and `message_html` are used when filled in, and the template supplies
whichever of them is empty. The **Content** section says which record each
came from. The layout comes from the template's `email_layout` (or the
notification's, if it has one).

Click **Load fake demo data** to try it without an export. The demo uses
[`fixtures/sample_hr_notifications.xml`](fixtures/sample_hr_notifications.xml),
which is entirely made up.

### Privacy model

Imported records are HR configuration, so they never leave your machine:

- Everything you import, the sample data, and your edits live **only in
  that browser tab's memory**. Nothing is uploaded, and none of it is saved
  to localStorage, sessionStorage, IndexedDB, cookies or anywhere else.
  Refreshing or closing the tab erases it (the page warns you first if there
  are unsaved edits).
- The XML is parsed in the browser with the built-in `DOMParser`. There's no
  backend.
- Data leaves the page only when you click a copy or download button.
  Downloads are generated locally as Blobs.
- The preview iframe is sandboxed without scripts, so any script inside an
  imported email body can't run.
- Things that *don't* involve imported data: the page loads Montserrat/Lora
  from Google Fonts, and an imported email body's own remote `<img>` URLs
  (if any) load in the preview just as they would in a mail client. TinyMCE
  (Composer tab only) keeps two empty color-picker entries in localStorage.
- `.gitignore` ignores `*.xml` everywhere except `fixtures/`, so a real
  export can't be committed by accident. Keep real exports out of the repo
  folder anyway.

### Exporting XML from ServiceNow

For each table you need, open its list, filter it, then right-click any
column header → **Export → XML**:

| What | Table (list URL) |
| --- | --- |
| Notifications | `sysevent_email_action.list` |
| Email templates | `sysevent_email_template.list` |
| Email (mail) scripts | `sys_script_email.list` |
| Email layouts | `sys_email_layout.list` |
| HR email content | `sn_hr_core_email_content.list` |
| Content delivery emails | `sn_cd_content_notification.list` |

Only notifications are required. Import the others too so previews show the
template body, layout and mail script source; anything missing is labelled
"(not in imported files)". You can drop several files at once. A record
with the same sys_id in a later file replaces the earlier one.

### End-to-end workflow

1. **Export** the program's notifications (plus their templates, mail
   scripts and layouts) as XML from ServiceNow.
2. **Preview**: open this tool, go to **ServiceNow import**, drop the files.
   Check the summaries; adjust sample data if needed.
3. **Paste to Google**: import your settings JSON if you have one. Filter
   to the program's category, then **Copy whole program for Google Docs** →
   paste into the program's Doc (pageless works well), and optionally
   insert a table of contents. **Copy inventory for Google Sheets** →
   paste into the inventory sheet (or import the CSV).
4. **Owners comment** on wording in the Doc.
5. **Apply approved changes**: re-import the XML, turn on **Advanced**, and
   edit `subject` / `message_html` on the notification or template.
6. **Download updated XML**, one file per edited record.
7. **Import to DEV**: in the DEV instance, open the matching list and
   right-click a column header → **Import XML**, with your update set
   selected. Test the notification there.
8. **Update set**: move the change through your normal update set process.
   ServiceNow stays the source of truth.

### Round-trip guarantees

The downloaded XML is built from the **original bytes** of that record, not
a re-serialization:

- every field, attribute and sys_id is copied verbatim; only the `subject`
  and/or `message_html` elements you changed are rewritten (CDATA is kept if
  the original used it)
- `sys_updated_on` and `sys_mod_count` are never touched. ServiceNow sets
  them on import.
- the only normalization is the file wrapper: the XML declaration, the
  original `<unload ...>` start tag, the record and `</unload>` each go on
  their own line (LF), with a trailing newline

`tests/sn-core.test.js` checks that an unedited record comes back
byte-identical under exactly that normalization, including CRLF files.

### Tests

```bash
node --test tests/*.test.js
```

### Releasing (version stamp)

GitHub Pages lets browsers keep files for 10 minutes, so after a release
people could keep running old scripts. `index.html` therefore loads each
app file with a `?v=<build>` query, and the header shows the same
**build** label. The build is a hash of the app's files. After changing any
of `style.css`, `app.js`, `docs-export.js`, `sn-core.js`, `servicenow.js` or
`fixtures/demo-data.js`, run:

```bash
node scripts/stamp-version.js
```

A test fails if you forget. After a release, a normal refresh loads the
new build. A tab opened within about 10 minutes of the release can still show
the previous build, so check the label and refresh if it hasn't changed.

The tests use Node's built-in runner only, with no packages to install. If you edit
the fixture XML, regenerate the demo copy with
`node scripts/build-demo-data.js`. A test fails if the two drift apart.

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

The **ServiceNow import** tab doesn't need a server. It uses no `fetch`, and
the demo data ships as a plain script, so opening `index.html` from a
downloaded copy of the repo works.

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
plus the standard "web-safe" email fonts — Arial, Helvetica, Verdana,
Tahoma, Trebuchet MS, Segoe UI, Times New Roman, Georgia, Cambria,
Garamond, Palatino Linotype, Courier New, Lucida Console — so you can pick
one and see how the body actually renders on a recipient's machine if
Montserrat/Lora's web fonts don't load), a font size picker (px, matching how
every layout/body size is expressed elsewhere in this app), bulleted and
numbered lists with indent/outdent, and links, matching what ServiceNow's
own notification message field supports. It's the open source Community
edition (GPL),
vendored directly into this repo, so there's no API key, no account, and no
usage cap. Only a minimal set of plugins is included (`lists`, `link`,
`code`, `autolink`) to keep the footprint small; a "Source code" toolbar
button (the `code` plugin) lets you view or hand-edit the raw HTML when
needed.

A "Clean up formatting" toolbar button normalizes the body:
unwraps empty/no-op `<span>` tags, strips Word/Outlook paste artifacts
(`mso-` styles, empty `<o:p>` tags, `Mso*` classes, conditional comments),
collapses runs of non-breaking spaces and `<br>` tags, and collapses/trims
redundant empty paragraphs — useful after pasting content in from Word,
Outlook, or Google Docs. See `cleanUpBodyContent()` in `app.js`.

The font picker's options are defined in `font_family_formats` in
`initTinyMce()` in `app.js` — add an entry there (and to the Google Fonts
`<link>`/`@import` URLs alongside it, and in `index.html`'s `<head>` and the
simple-template branch of `buildStandaloneHtml`, so it renders consistently
in the editor, the preview, and exported HTML) if you need another font.
The size picker's options are `font_size_formats` right below it, in px to
match everything else in this app — add/remove sizes there if the list
needs to change.

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
  next entry is used). This applies to the body too, not just the static
  layout — a font applied via the editor's font picker (e.g. a Montserrat
  section heading) falls back correctly as well.
- Links inside the preview (both this iframe and the simple-template preview)
  always open in a new tab (`<base target="_blank">` for the iframe, a DOM
  pass forcing `target="_blank"` for the simple preview) instead of
  navigating the preview itself away — links stay exactly as authored in the
  exported/copied HTML.

`config/templates.json` currently ships with one real example (`beacon-onboarding`)
plus two variants (`beacon-hr-case-sample`, `beacon-approval-sample`) that
reuse the same real layout structure with a different banner title — useful
for testing, but not pulled from a live instance. Swap their `layoutHtml` for
real exports as they become available.

## Files

- `index.html` — layout and form fields
- `style.css` — styling
- `app.js` — Composer tab: live preview logic, template loading, copy/download
- `servicenow.js` — ServiceNow import tab (UI, in-memory state)
- `sn-core.js` — DOM-free XML scanning, field replacement, condition
  translation, summaries and CSV (shared by the browser and the tests)
- `docs-export.js` — clipboard (rich HTML for Google Docs), image embedding
  and local downloads
- `fixtures/` — fake ServiceNow XML for tests and the demo
  (`demo-data.js` is generated from it)
- `tests/` — `node --test` unit tests
- `config/templates.json` — editable list of starter templates/layouts
- `vendor/tinymce/` — self-hosted TinyMCE Community edition (GPL) powering
  the Body field's rich text editor
