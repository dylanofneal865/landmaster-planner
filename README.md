# Landmaster Inventory Command

Self-contained inventory & PO planner. No build step, no dependencies — open
`index.html` in a browser and it runs.

## How to run it

**Easiest (Live Server in VS Code):**
1. Install the *Live Server* extension by Ritwick Dey
2. Right-click `index.html` → **Open with Live Server**

**Quick & dirty:** Right-click `index.html` → **Open with → your browser.**
Works fine because all data is loaded via `<script src=...>` tags, not fetch.

## File layout

```
landmaster/
├── index.html                       # Markup only — small, easy to skim
├── css/
│   └── styles.css                   # All styling (~1,200 lines)
├── data/
│   └── bootstrap.js                 # Embedded gzipped snapshot
└── js/
    ├── 01-config.js                 # Constants, DEFAULTS, storage keys
    ├── 02-utils.js                  # Helpers: uid, formatters, DOM, dates
    ├── 03-calc.js                   # Projection, days-of-cover, status, audit log
    ├── 04-data.js                   # loadDB / saveDB / bootstrap loader
    ├── 05-ui-shell.js               # Toasts, modals, drawer, router, top bar
    ├── 06-page-dashboard.js         # Dashboard
    ├── 07-page-orders.js            # Order Queue (the daily work surface)
    ├── 08-page-pos.js               # PO list + PO detail drawer
    ├── 09-page-onhand.js            # On-hand inventory update
    ├── 10-page-parts.js             # Parts catalog + part detail drawer
    ├── 11-page-suppliers.js         # Suppliers (aggregated)
    ├── 12-page-audit.js             # Audit log
    ├── 13-page-settings.js          # Settings
    ├── 14-import.js                 # XLSX/CSV import
    ├── 15-cmd-palette.js            # Cmd/Ctrl+K palette
    ├── 16-keyboard.js               # Keyboard shortcuts
    ├── 18-excel-sync.js             # Live Excel sync (File System Access API)
    ├── 19-page-usage.js             # Usage tracking page
    └── 17-welcome-init.js           # Welcome dialog + initApp (loaded LAST)
```

## How the app boots

1. `index.html` loads `css/styles.css` first
2. Then `data/bootstrap.js` — sets `window.LM_BOOTSTRAP_DATA` (gzipped+base64)
3. Then each `js/*.js` in numeric order — every function becomes a global
4. The last file (`17-welcome-init.js`) registers `DOMContentLoaded` → `initApp()`
5. `initApp()`:
   - Calls `loadDB()` — reads from `localStorage` (key: `landmaster.inv.v3`)
   - If empty, calls `bootstrapSample()` which decodes `LM_BOOTSTRAP_DATA`
   - Runs `ensureIds()` to backfill any missing PO/line IDs
   - Wires top-bar buttons, file input, welcome dialog
   - Routes to the dashboard

## Editing tips

- **Tweaking colors / layout** → `css/styles.css`. The design tokens are at the
  top in `:root { --bg: ... }` — change those and the whole UI re-themes.
- **Changing the dashboard** → `js/06-page-dashboard.js`
- **Changing how reorder timing is computed** → `js/03-calc.js`
  (`projectOnHand`, `partStatus`, `suggestedQty`)
- **Changing the PO detail drawer** → `js/08-page-pos.js`
- **Changing where data is stored** → `js/01-config.js` and `js/04-data.js`

## Refreshing the embedded snapshot

To load a newer XLSX as the default snapshot:
1. Open the planner in your browser
2. Click *Import* (top right) → pick the new file
3. Once it imports successfully, open Settings → Data → Export full backup
4. Replace `data/bootstrap.js` with a new copy that base64-gzips the export

If you want me to do this regen step in code, ping me with the new file.

## Storage

Everything persists in `localStorage` under key `landmaster.inv.v3`. To wipe and
re-bootstrap from the embedded snapshot, use Settings → Data → Reset, or open
DevTools → Application → Local Storage → delete the key.
