# Tally Prime MCP Server

A Model Context Protocol (MCP) server that bridges **Tally Prime's XML/HTTP gateway** to MCP clients like **Claude Cowork**, Claude Desktop, Claude in Chrome, ChatGPT Desktop, Perplexity Desktop, Cursor, and any other tool that speaks MCP.

It exposes Tally Prime as a set of typed tools — list/create masters, post vouchers, run reports — built directly on top of the documented Tally XML envelopes:

- [Understanding Tally XML Tags](https://help.tallysolutions.com/understanding-tally-xml-tags/)
- [XML Integration](https://help.tallysolutions.com/xml-integration/)
- [Sample XML](https://help.tallysolutions.com/sample-xml/)

---

## Prerequisites

1. **Tally Prime** (Silver or Gold edition recommended — the Educational edition restricts dates and will return partial data).
2. **Node.js 18 or newer** — **this is non-negotiable**. The MCP SDK uses ES modules; Node 8/10/12/14/16 will fail at startup with `SyntaxError: Unexpected token import`.
   - Check with `node --version`. If it reports anything below `v18`, install the latest LTS from [nodejs.org](https://nodejs.org/) (use the **64-bit MSI** on Windows).
   - On Windows specifically, make sure your `claude_desktop_config.json` points at the new install — usually `C:\\Program Files\\nodejs\\node.exe`, **not** `C:\\Program Files (x86)\\nodejs\\node.exe`.
3. Tally's XML/HTTP gateway enabled.

### Enable the Tally XML gateway

Open Tally Prime, then:

```
F1 (Help) > Settings > Connectivity > Client/Server configuration
```

Set:

```
TallyPrime acts as = Both        (or Server)
Port              = 9000
```

Quick check — with Tally running you should be able to `curl http://localhost:9000` and get an XML response.

---

## Install

```bash
git clone <this folder>
cd "Tally Prime MCP"
npm install
npm run build
```

That produces `dist/index.js`, which is the executable MCP server entry point.

---

## Wire it into Claude Cowork / Claude Desktop

Edit your `claude_desktop_config.json` (open via **Claude Desktop → Settings → Developer → Edit Config**) and add:

**Windows:**

```json
{
  "mcpServers": {
    "tally-prime": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\absolute\\path\\to\\Tally Prime MCP\\bootstrap.cjs"],
      "env": {
        "TALLY_HOST": "localhost",
        "TALLY_PORT": "9000"
      }
    }
  }
}
```

**macOS / Linux:**

```json
{
  "mcpServers": {
    "tally-prime": {
      "command": "node",
      "args": ["/absolute/path/to/Tally Prime MCP/bootstrap.cjs"],
      "env": {
        "TALLY_HOST": "localhost",
        "TALLY_PORT": "9000"
      }
    }
  }
}
```

`bootstrap.cjs` is a CommonJS shim that first verifies Node ≥ 18, then loads the ES-module server from `dist/index.js`. Pointing at the shim instead of `dist/index.js` directly is what surfaces a readable error if the wrong Node version is in use.

Restart Claude. The Tally tools (prefix `tally_`) will appear in the **Tools** menu.

### Optional environment variables

| Variable           | Default        | Notes                                                                 |
| ------------------ | -------------- | --------------------------------------------------------------------- |
| `TALLY_HOST`       | `localhost`    | Tally machine's hostname / IP.                                        |
| `TALLY_PORT`       | `9000`         | Port from the Tally Client/Server settings.                           |
| `TALLY_COMPANY`    | *(unset)*      | Default `SVCURRENTCOMPANY`. Otherwise the active company is used.     |
| `TALLY_TIMEOUT_MS` | `60000`        | HTTP timeout — bump for very large data exports.                      |

---

## Tools

All tools share an optional `targetCompany` argument; if omitted the currently active company in Tally is used.

### Master data

| Tool                       | What it does                                                              |
| -------------------------- | ------------------------------------------------------------------------- |
| `tally_list_companies`     | List all companies known to the running Tally Prime instance.             |
| `tally_list_masters`       | List masters of a collection: Ledger, Group, StockItem, Unit, Godown, etc.|
| `tally_get_ledger`         | Fetch the full master record for one ledger.                              |
| `tally_create_ledger`      | Create or alter a ledger (`alter: true`). Set `parent`, optional address/GSTIN. |
| `tally_create_group`       | Create or alter a group.                                                  |
| `tally_create_stock_item`  | Create or alter a stock item.                                             |
| `tally_create_stock_group` | Create or alter a stock group.                                            |
| `tally_create_unit`        | Create a simple or compound Unit of Measure.                              |
| `tally_create_godown`      | Create a godown / location.                                               |
| `tally_create_cost_centre` | Create a cost centre.                                                     |

### Vouchers

| Tool                    | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `tally_create_voucher`  | Post any voucher type (Sales, Purchase, Receipt, Payment, Journal, Contra, Stock Journal, Debit/Credit Note, custom). Ledger entries use **signed amounts: negative = Debit, positive = Credit**; totals must net to zero. Set `isInvoice: true` and supply `inventoryEntries` with `accountingLedger` for item invoices. |
| `tally_alter_voucher`   | Modify an existing voucher by voucher type + number + date.                 |
| `tally_cancel_voucher`  | Cancel an existing voucher.                                                 |
| `tally_get_voucher`     | Fetch full XML for a voucher by number.                                     |

### Reports

| Tool                       | What it does                                                                   |
| -------------------------- | ------------------------------------------------------------------------------ |
| `tally_trial_balance`      | Trial Balance — opening + closing balance per ledger over a period.            |
| `tally_balance_sheet`      | Balance Sheet — closing balances as on a date.                                 |
| `tally_profit_loss`        | Profit & Loss — net activity per ledger over a period.                         |
| `tally_ledger_balance`     | Single ledger closing balance as on a date.                                    |
| `tally_ledger_account`     | Voucher-level statement for one ledger.                                        |
| `tally_ledger_outstanding` | Outstanding bills for one party ledger.                                        |
| `tally_day_book`           | Day Book for a date range, optionally filtered by voucher type.                |
| `tally_stock_summary`      | Closing qty / rate / value per stock item as on a date.                        |
| `tally_stock_item_balance` | Opening + closing for a single stock item.                                     |
| `tally_stock_item_account` | Voucher-level inward/outward movement for a single stock item.                 |
| `tally_bills_outstanding`  | Bills Receivable or Bills Payable summary.                                     |
| `tally_chart_of_accounts`  | Group hierarchy (BS vs PL, Dr vs Cr, affects gross profit).                    |
| `tally_raw_request`        | Escape hatch — POST any custom Tally XML envelope and return the raw response. |

---

## Conventions

- **Dates** accept `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`, `D-Mon-YYYY`, or `YYYYMMDD`. Internally normalised to Tally's uni-date `YYYYMMDD`.
- **Amounts** in reports follow Tally's sign convention: **negative = Debit, positive = Credit**.
- **Voucher posting** also uses signed amounts in `ledgerEntries`: negative for Debits, positive for Credits. Total **must** net to zero or Tally will reject the voucher with a "Voucher totals do not match" error.
- **Targeted company**: every tool takes an optional `targetCompany`. If unset, the request flows to the active company; set `TALLY_COMPANY` env var to make a global default.

---

## Example prompts you can try in Claude

> *List the companies loaded in Tally.*

> *Give me the trial balance for 1 April 2024 to 31 March 2025.*

> *Create a ledger named "Acme Corp" under Sundry Debtors with GSTIN 29ABCDE1234F1Z5 and address "12 MG Road, Bengaluru, 560001".*

> *Post a sales voucher dated today: 1× "Sony TV 32-inch" at ₹25,000 to "Acme Corp", VAT 14% extra. Allocate to the "Sales" ledger.*

> *Show outstanding receivables as of today, sorted by amount.*

> *Stock summary as on 31 March — flag any item with closing value below cost.*

---

## Architecture

```
src/
├── index.ts                  # MCP stdio server (entry point)
├── jsonschema.ts             # Lightweight Zod → JSON Schema for tool inputs
├── tally/
│   ├── config.ts             # Reads TALLY_HOST / TALLY_PORT / TALLY_COMPANY
│   ├── client.ts             # HTTP POST wrapper around Tally :9000
│   ├── xml.ts                # Envelope builders + response parser (uses fast-xml-parser)
│   └── util.ts               # CSV rendering, amount/date parsing
└── tools/
    ├── types.ts              # Tool descriptor type
    ├── masters.ts            # Ledger, Group, StockItem, Unit, Godown, CostCentre
    ├── vouchers.ts           # Create / alter / cancel / get voucher
    └── reports.ts            # Trial Balance, P&L, Balance Sheet, Day Book, Stock, etc.
```

Every tool builds an XML envelope that mirrors the official Tally Help pages. The `tally_raw_request` tool is the escape hatch — pass any well-formed `<ENVELOPE>` and you get the raw response, useful for custom TDL reports.

---

## Troubleshooting

**`SyntaxError: Unexpected token import` at startup**  
Your Node.js is older than 18. Check with `node --version`. Install the latest LTS from [nodejs.org](https://nodejs.org/) and update the `command` field in `claude_desktop_config.json` to point at the new `node.exe`. On Windows that's almost always `C:\\Program Files\\nodejs\\node.exe` (the 64-bit install) — **not** `C:\\Program Files (x86)\\nodejs\\node.exe` (the legacy 32-bit one your error log showed).

**`Could not connect to Tally at http://localhost:9000`**  
Tally isn't running, or the XML gateway isn't enabled. Re-check **F1 → Settings → Connectivity**.

**`Tally returned failure status: DESC not found`**  
The `<ID>` (report or collection name) doesn't exist in your Tally. Try `tally_list_masters` first to discover what's defined.

**`Voucher totals do not match`**  
The signed `amount` values in `ledgerEntries` don't net to zero. Negative = Debit, positive = Credit.

**Educational version warnings**  
Tally Educational restricts dates to 1st, 2nd, and the last day of each month. Use a Silver/Gold licence for full data.

---

## License

MIT
