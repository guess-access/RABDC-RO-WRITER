# RO Ledger Link

Automatically fetch the RO# for the appointments you booked and write it into
the dealership's **Sources Ledger** in Google Sheets — no more retyping repair
order numbers row by row.

**How it works:** you export open ROs from the DMS, drop the file in, and the
site matches each one to the right ledger row by phone, VIN, or customer name +
date. You review the matches, tick what you agree with, and one button stamps
the RO#s into the sheet.

Matching runs in your browser and shows you every proposed pair first. Nothing
is written until you press the button.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The site. Open it in a browser. |
| `app.js` | Matching + write logic. Runs entirely client-side. |
| `styles.css` | Styling. |
| `apps-script/Code.gs` | The bridge to your Google Sheet. Paste into Apps Script. |
| `sample-sources-ledger.csv` | A test ledger to paste into Google Sheets. |
| `sample-dms-ro-export.csv` | A test export to drop into the site. |
| `serve.ps1` | Optional local web server on Windows. |

---

## 5-minute setup

### 1. Connect the ledger to Apps Script (one time)

1. Open your Sources Ledger in Google Sheets.
2. **Extensions → Apps Script**. Delete whatever is in `Code.gs`, paste in
   `apps-script/Code.gs`, and **Save**.
3. **Deploy → New deployment → Type: Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
4. Authorise when Google asks. (First time only — it will warn that the app
   isn't verified, because it's your own script. Review permissions → Advanced →
   go to the project.)
5. Copy the **Web app URL** — it ends in `/exec`.

> **Already configured for your sheet.** `Code.gs` carries your
> `SPREADSHEET_ID`, has `SECRET` off, and resolves the default tab to the
> current month's name (`October 2026` → `November 2026` on the 1st) — no
> monthly editing. Set the script's timezone (**Project Settings →
> Timezone**) to your dealership's so it rolls over at local midnight rather
> than UTC.

### 2. Open the site

Double-click `index.html`, or run `serve.ps1` for a local server at
http://localhost:8080/. Nothing to install.

### 3. Connect, import, write

1. Paste the Web app URL into **step 1** → **Connect** → **Load ledger**.
   The tab resolves to this month's sheet automatically. The column mapping is
   detected from the headings, and **RO# is pinned to the `RO` column** — there
   is deliberately no dropdown to redirect it.
2. In **step 2**, drop your DMS export (`.csv` or `.xlsx`).
3. **step 3** shows every match with a confidence tag. Untick anything wrong.
4. **step 4** writes the RO#s. Download the report if you want a record.

---

## Your ledger's headings

The monthly tab is expected to start with:

```
REP | VIN | Name | PHONE # | SERVICE TYPE | DATE MADE | APPT DATE | RO
```

| Heading | How it's used |
|---|---|
| `RO` | **The write target.** Resolved by heading name and pinned, so a moved or reordered column can't send an RO# elsewhere. |
| `APPT DATE` | Date matching — when the customer is actually coming in. |
| `DATE MADE` | **Not used.** That's when the booking was keyed, not the visit. |
| `Name` | Name matching, including `LAST, FIRST` reversal from DMS exports. |
| `PHONE #` | Match key after VIN; normalised to 10 digits. |
| `VIN` | Strongest match key. |
| `REP` | Not auto-detected. Map it manually to *Advisor* if you want it echoed in the preview — it is never used to match. |
| `SERVICE TYPE` | Not used to match. |

*Advisor* is a pure passthrough: it only ever echoes what is already on the
ledger, so nothing auto-resolves to it and it has no effect on matching.

Heading detection ranks the **most specific** match first, not the first column
that fits — so `APPT DATE` always beats `DATE MADE` whichever order they appear
in. Anything above that isn't listed is left unmapped, and you can remap any of
it in the UI.

---

## Try it without touching your real data

1. Create a new Google Sheet, paste in `sample-sources-ledger.csv`, and connect
   it as above.
2. Drop `sample-dms-ro-export.csv` into the site.
3. You should see the whole spread of outcomes: clean matches, a surname-only
   ambiguity between the two Santoses, a VIN-only match, a **conflict** where
   the ledger already holds RO# 101998, and one customer with no match at all.

---

## How matching ranks

| Confidence | Trigger | Auto-selected? |
|---|---|---|
| **High** (85+) | VIN match, phone match, or full name + same calendar day | Yes |
| **Medium** (65–84) | Full name ±1 day, or surname + same day | Yes |
| **Low** (45–64) | Surname only, or full name on a different day | No — review it |
| **None** (<45) | No name overlap | No |

Details worth knowing:

- **Phone** is normalised, so `(555) 214-8890`, `5552148890` and
  `1-555-214-8890` all compare equal.
- **Names** have titles and suffixes stripped (`Mr.`, `Jr.`, `III`…), and
  `LAST, FIRST` from the DMS is flipped back — so `Okafor, James` matches
  `James Okafor`.
- **Dates** accept `10/12/2026`, `2026-10-12`, Excel serial numbers, and real
  date cells.
- **One ledger row can only be claimed once.** If two appointments fight over
  the same row, the weaker one is downgraded to *Low* and told you why.

Nothing below *High* or *Medium* is ever ticked for you.

---

## Directions

The toggle in step 2 switches which side owns the RO#:

- **File supplies the RO#** *(default)* — your DMS export has the RO#s; the
  site writes them into the ledger's RO# column.
- **Ledger supplies the RO#** — the ledger already holds them; the site pulls
  the RO# out for each imported appointment and gives you a CSV with the
  column filled in. Nothing is written to the sheet.

---

## Safety

- **Nothing is overwritten by default.** If a ledger row already has an RO#
  that differs from the incoming one, it's flagged as a *conflict* and left
  alone. The **Overwrite** checkbox in step 3 is the only way to change that.
- **Empty RO#s are never written.** A blank in the export skips the row rather
  than blanking the sheet.
- **Your export never leaves the machine.** CSV/XLSX parsing happens in the
  browser. The only network call is to your own Apps Script.

## Security — read this

The deployed Web app URL is a **bearer credential**: anyone who has it can read
and write your ledger. Treat it like a password.

- Don't put it in a public repo, a shared doc, or a bookmark bar others use.
- Set a second lock by adding `SECRET: 'something-long'` in `Code.gs` and
  pasting the same value into the site's *Shared secret* field.
- To revoke a leaked URL: **Deploy → Manage deployments → ⋮ → Edit** and pick a
  **new** deployment version. Old URLs stop working immediately.
- The site stores the URL and secret in this browser's `localStorage`. Use
  **Reset** in the top bar to wipe them from a shared machine.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "The Apps Script replied with something that isn't JSON" | Deployment access isn't set to **Anyone**, or you're calling the `/dev` URL. Redeploy as a Web app and use the `/exec` URL. |
| `Script completed no output` | The script has an error. Open Apps Script → **Executions** to see the stack trace. |
| ` unauthorized` | `CONFIG.SECRET` is set in `Code.gs` but the site's secret field is blank or different. |
| `No spreadsheet found` | The script isn't bound to a sheet. Either run it from **Extensions → Apps Script** inside the ledger, or set `SPREADSHEET_ID`. |
| `Tab "X" not found` | Pick the right tab in the dropdown, or check the tab name spelling. |
| Wrong column got the RO# | Fix **RO# column to write into** in step 1. The write is by column *position*, never by heading text, so renaming headings later won't break it. |
| Only the first N rows loaded | `CONFIG.MAX_READ_ROWS` (default 6000). Raise it in `Code.gs` and redeploy. |
| Excel files won't import | The SheetJS CDN didn't load — you're offline. Save the file as CSV instead; everything else still works. |

---

## Customising

- **Column detection** — `FIELDS` in `app.js` holds the heading keywords used
  to auto-map columns. Add a synonym (e.g. `/mob\b/` for phone) if your DMS
  labels things unusually. You can always override any mapping in the UI.
- **Confidence thresholds** — `BANDS` in `app.js`.
- **Header row** — `CONFIG.HEADER_ROW` in `Code.gs` if your ledger has a
  title row above the headings.
