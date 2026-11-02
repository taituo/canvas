---
name: lotus-456
description: Work with the user in their live Lotus 456 spreadsheet (A1 grid, formulas, multiple sheets, milestones). Use when the user refers to "the sheet", "taulukko", cell coordinates like C23, or asks you to read what they changed.
---

# Lotus 456 — agent skill

A full-screen spreadsheet the user has open in a browser. You and the user edit the same workbook; every
edit is versioned. Your job is to read **only what changed** and to write precise, minimal edits.

Server: `$CANVAS_URL` (default `http://127.0.0.1:3210`). CLI: `bin/cm.mjs` (alias `cm`). All output is compact text.

## Loop

1. First contact: `cm overview` — docs, sheets, used ranges, the user's current selection.
2. Before every reply: `cm changes` — only edits since your last call (your own are filtered out; cursor kept in `~/.lotus456-cursor`).
   Long gap? `cm changes --net` collapses to net per-cell effect.
3. Read narrowly: `cm read Budjetti!A1:F20`. Never dump whole sheets "just in case".
4. Write: `cm set …`, `cm table …`, `cm move …`. The response echoes what changed and which formulas recalculated.

## Reading the change feed

```
v14 user 14:02:11 [main]
  Budjetti!B2: 4 → 10                                  # direct edit (old → new raw input)
  calc: Budjetti!D2 50→125 · Budjetti!E6 ✓→✗           # formulas whose VALUE changed as a consequence
v15 user 14:02:30 [main]
  MOVE Budjetti!A2:E5 → A8:E11 (20 cells; refs updated in Budjetti!D6)
```
- A MOVE is one line, not 40 cell edits. Data still exists — it is at the new address. Formulas that pointed
  to it were rewritten automatically (Sheets cut/paste semantics). Don't "fix" them.
- `INSERT rows 3` / `DELETE cols C:D` shift addresses below/right of the point. Re-resolve any addresses you remember.
- `∅` = empty. `⇒` in `cm read` = computed value of a formula.

## Writing

```
cm set C1=Tila 'D5==B5*C5' 'Asetukset!B1=300'      # value or =formula; quote anything with ! or spaces
cm table H1 '[["Kategoria","Summa"],["Servot","=SUMIF(A:A,\"Serv*\",D:D)"]]'
cm move C23:D32 F23                                 # cut/paste, refs follow
cm insert-rows 5 2 --sheet=Budjetti
cm fmt A1:E1 '{"b":true,"fill":"#fff2cc"}'          # keys: b i u s fill color align(left|center|right)
cm border B6:E11 outer thick '#1a73e8'             # all|inner|horizontal|vertical|outer|left|top|right|bottom|clear
cm merge B2:E2                                      # merge (keeps top-left value) · cm unmerge B2:E2
cm note B7 "Is this the 2025 price?"                # ask the user something *in the cell*
cm focus B2:B9 "checking quantities"                # purple box in the user's UI while you work
```
Raw batch (atomic, all-or-nothing): `POST /api/ops {"by":"agent","ops":[…],"expect":{"Budjetti!B2":"10"}}`.
Use `expect` when overwriting a cell the user may be touching — you get **409** with the current value instead of clobbering it.

## Voice / coordinates

The user may talk: *"laske C23 ja D32 yhteen"*. Coordinates are A1 style; sheet prefix optional (`Asetukset!B1`,
quote names with spaces: `'My data'!A1`). If they don't say where the result goes, write to their **active cell**
(`cm sel`) — or if it's not empty, the first empty cell below it — and say the address you used out loud.
"Tämä / nämä / valitut" = `cm sel`.

## Named tables (structured data)

A sheet can hold many small named tables anywhere (title cells above, notes beside). First row = column
headers, the rest = records. `cm overview` lists them with their columns. Prefer tables for anything
record-like (tasks, parts, ideas, contacts) — you address data by **table + key + column**, not coordinates.

```
cm read @Tehtävät                     # [7] Tehtävä: Kokoa runko · Tila: valmis · Vastuu: Poika
cm add Tehtävät '{"Tehtävä":"Testaa akku","Tila":"auki"}'     # appends, table grows (rows pushed down if needed)
cm update Tehtävät 'Kytke servot' Tila=valmis                  # key = first-column value
cm update Tehtävät 'Tila=auki' Vastuu=Isi                      # or match by column value (all matches)
cm rm Tehtävät 'Tila=valmis'                                   # removes records inside the table only
cm addcol Tehtävät Agentin_huomio                              # new column at the right edge
cm mktable Ideat B16:C18                                       # name an existing region (header row first)
```
Change feed annotates table cells: `Projekti!C8: auki → valmis   ⟨Tehtävät[Kytke servot].Tila⟩`.
Tables follow moves and row/column inserts. Formulas can use `Tehtävät[Tila]` (column) or `Tehtävät[#All]`:
`=COUNTIF(Tehtävät[Tila],"auki")`. Cells are free text too — long notes are fine (`↵` wrap in the UI).

## SQL (both directions) and JSON

Every named table is a SQL table (Node's built-in SQLite, rebuilt per query). Other workbooks: `"doc.Table"`.
```
cm sql "SELECT t.Vastuu, COUNT(*) n FROM Tehtävät t GROUP BY 1"
cm sql "SELECT … FROM Tehtävät t JOIN Osat o ON …"
cm sql --write "UPDATE Tehtävät SET Tila='valmis' WHERE Vastuu='Isi'"     # → updateRows/removeRows/appendRows, undoable
cm sql --into Yhteenveto@Dashboard!B30 "SELECT Tila, COUNT(*) kpl FROM Tehtävät GROUP BY Tila"   # result → new table
cm json Tehtävät                          # flat JSON array
cm put Tehtävät rows.json [Sheet!B2]      # JSON array → table (creates at B2 if missing)
```

## Charts, dashboards, images, documents

Charts float over the grid, anchored to a cell, and read live data (range, named table or one cell for KPI).
```
cm chart column B6:C10 --at K2 --title "Hinnat"       # column | bar | line | area | pie | kpi
cm chart pie @TilaJakauma --title "Tila"               # table source (--x label col, --y value cols)
cm chart kpi Projekti!C12 --title "Avoimia" --at B5
cm chart-show status                                   # chart's current data as text
cm chart-set status type=bar w=500                     # cm chart-rm id
cm fmt B2 '{"fs":32,"b":true}'                         # font size in px; valign: top|middle
cm ops '[{"op":"view","sheet":"Dashboard","grid":false}]'   # hide gridlines (dashboard look)
cm image B2 photo.png                                  # =IMAGE("url") — cells can hold pictures
cm export Dashboard md                                 # sheet → document (headings, tables, charts, KPIs)
```

## Formulas

`+ - * / ^ & % = <> < > <= >=`, refs `A1 $A$1 A1:B9 Sheet!A1`, args separated by `,` or `;`.
SUM AVERAGE MIN MAX COUNT COUNTA COUNTBLANK PRODUCT SUMIF COUNTIF AVERAGEIF IF IFS IFERROR AND OR NOT XOR
ISBLANK ISNUMBER ISTEXT ISERROR ROUND ROUNDUP ROUNDDOWN INT ABS SQRT POWER MOD LEN UPPER LOWER TRIM LEFT RIGHT
MID EXACT CONCAT CONCATENATE TEXTJOIN VLOOKUP MATCH INDEX ROWS COLUMNS PI NA IMAGE HYPERLINK.
Errors: `#REF! #DIV/0! #NAME? #VALUE! #N/A #CYCLE! #ERROR!` (parse). Checks/validation = `IF(…,"ok","✗ …")` columns.

## Milestones

`cm commit "msg"` saves a named snapshot. `cm diff last` (or `m3`) = what changed since, move-aware.
`cm restore m3` reverts (user-facing; only when asked). The user saves milestones too (Ctrl+S).

## Etiquette

- Add, don't overwrite: put your output in new columns/sheets unless asked to change the user's cells.
- Keep batches small and meaningful — the user sees each one flash purple.
- Never rewrite formulas the user wrote unless asked; leave a `note` instead.

## HTTP reference (text by default, `&format=json` for JSON)

| | |
|---|---|
| `GET /api/overview` | docs, sheets, used ranges, selection |
| `GET /api/changes?since=N[&exclude=agent][&mode=net][&doc=]` | change feed; last line `cursor: N` |
| `GET /api/read?range=Sheet!A1:F20[&doc=]` | non-empty cells (`Sheet!` alone = used range, `@Table` = records) |
| `GET /api/find?q=text` | cells containing text |
| `GET /api/selection` | user's current selection |
| `POST /api/ops` | `{doc?, by, ops:[…], expect?}` → version + changes (`?format=text`) |
| `POST /api/commit` `{message}` · `GET /api/commits` · `GET /api/diff?from=m3` · `POST /api/restore {commit}` | milestones |
| `POST /api/focus {range, label}` | highlight where you work |
| `POST /api/docs {type:"sheet"|"text", title}` | new canvas |
| `POST /api/sql {sql, write?, into?:{name,at}}` | SQL over tables |
| `GET /api/table?name=` · `PUT /api/table {name, rows, at?}` | table ⇄ JSON |
| `GET /api/chart?id=` | chart data |
| `GET /api/export?sheet=&format=md\|html\|json` | sheet as a document |
| `POST /api/assets` (raw image body) | → `{url}` for `=IMAGE(url)` |
| `GET /api/events` | SSE stream of every batch |

Ops: `set {cells}|{range,values}` · `move {from,to}` · `insertRows|deleteRows {at,count}` · `insertCols|deleteCols {at:"C",count}` ·
`format {range|ranges,style}` · `note {cell,text}` · `resize {cols:{A:140},rows:{"3":40}}` · `freeze {rows,cols}` ·
`borders {range|ranges, type, style: solid|medium|thick|dashed|dotted|double, color}` ·
`merge {range, type: all|horizontal|vertical}` · `unmerge {range}` · `view {sheet, grid}` ·
`addChart {type, range|table(+x,y)|value, title, at, dx, dy, w, h}` · `updateChart {id, …}` · `deleteChart {id}` · `addSheet {name}` · `renameSheet {sheet,name}` · `deleteSheet {sheet}` ·
tables: `table {name,range}` · `deleteTable {name}` · `renameTable {name,newName}` · `appendRows {table,rows:[{Col:v}|[v,…]]}` ·
`updateRows {table, key|match{Col:v}|rows[1..], set{Col:v}}` · `removeRows {table, key|match|rows}` · `addColumn {table,name,values?}`. Text docs: `setText {text}` · `append {text}`.
Every op takes optional `sheet`; cell keys may carry a sheet prefix.
