// MCP tools for Tally REPORTS:
//   - tally_trial_balance
//   - tally_balance_sheet
//   - tally_profit_loss
//   - tally_day_book
//   - tally_stock_summary
//   - tally_ledger_balance, tally_ledger_account, tally_ledger_outstanding
//   - tally_stock_item_balance, tally_stock_item_account
//   - tally_bills_outstanding (receivables / payables)
//   - tally_chart_of_accounts
//   - tally_raw_request (escape hatch — send any Tally XML envelope)

import { z } from "zod";
import {
  buildExportEnvelope,
  buildExportCollectionEnvelope,
  buildExportObjectEnvelope,
  parseTallyXml,
  escapeXml,
} from "../tally/xml.js";
import { amount, asArray, n, s, toCsv } from "../tally/util.js";
import type { Tool, ToolHandler } from "./types.js";

const dateRangeSchema = z.object({
  fromDate: z.string().describe("Period start (YYYY-MM-DD / DD-MM-YYYY / YYYYMMDD)."),
  toDate: z.string().describe("Period end."),
  targetCompany: z.string().optional(),
});
const asOfSchema = z.object({
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/*  Generic "Accounts" collection helper                                      */
/* -------------------------------------------------------------------------- */
//
// All the standard balance reports (Trial Balance, Balance Sheet, P&L, Ledger
// statements, etc.) are easiest to read by querying the "Ledger" collection
// directly with the appropriate FETCH list and date variables, rather than
// scraping Tally's pre-rendered XML report views. That gives us tabular CSV.

interface LedgerCollectionRow {
  name: string;
  parent: string;
  opening: number;
  closing: number;
}

async function fetchLedgerCollection(
  client: any,
  vars: { fromDate?: string; toDate?: string; company?: string },
  filter?: string
): Promise<LedgerCollectionRow[]> {
  const collectionName = "MCP_Ledger_Balances";
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>Ledger</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>Parent</NATIVEMETHOD>
      <COMPUTE>OpeningBalance: $OpeningBalance</COMPUTE>
      <COMPUTE>ClosingBalance: $ClosingBalance</COMPUTE>
      ${filter ? `<FILTERS>MCPFilter</FILTERS>` : ""}
    </COLLECTION>
    ${filter ? `<SYSTEM TYPE="Formulae" NAME="MCPFilter">${filter}</SYSTEM>` : ""}`;
  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: {
      company: vars.company,
      fromDate: vars.fromDate,
      toDate: vars.toDate,
    },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const data = tree?.ENVELOPE?.BODY?.DATA ?? tree?.ENVELOPE ?? {};
  const items = asArray<any>(data?.COLLECTION?.LEDGER);
  return items.map((it) => ({
    name: s(it?.["@_NAME"] ?? it?.NAME ?? ""),
    parent: s(it?.PARENT ?? ""),
    opening: amount(it?.OPENINGBALANCE ?? 0),
    closing: amount(it?.CLOSINGBALANCE ?? 0),
  }));
}

/* -------------------------------------------------------------------------- */
/*  trial_balance                                                             */
/* -------------------------------------------------------------------------- */

const trialBalance: ToolHandler = async (raw, client) => {
  const args = dateRangeSchema.parse(raw);
  const rows = await fetchLedgerCollection(client, {
    fromDate: args.fromDate,
    toDate: args.toDate,
    company: args.targetCompany ?? client.config.defaultCompany,
  });
  const out = rows.map((r) => [
    r.name,
    r.parent,
    r.opening.toFixed(2),
    r.closing.toFixed(2),
  ]);
  return toCsv(["ledger", "group", "opening_balance", "closing_balance"], out);
};

/* -------------------------------------------------------------------------- */
/*  balance_sheet                                                             */
/* -------------------------------------------------------------------------- */

const balanceSheet: ToolHandler = async (raw, client) => {
  const args = asOfSchema.parse(raw);
  const rows = await fetchLedgerCollection(client, {
    toDate: args.toDate,
    company: args.targetCompany ?? client.config.defaultCompany,
  });
  // Only carry closing balances; filter to ledgers whose parent group rolls to BS.
  // We can't know the affects-gross-profit / BS-vs-PL classification without
  // querying group definitions, so we return everything; the LLM can group.
  const out = rows
    .filter((r) => Math.abs(r.closing) > 0.001)
    .map((r) => [r.name, r.parent, r.closing.toFixed(2)]);
  return toCsv(["ledger", "group", "closing_balance"], out);
};

/* -------------------------------------------------------------------------- */
/*  profit_loss                                                               */
/* -------------------------------------------------------------------------- */

const profitLoss: ToolHandler = async (raw, client) => {
  const args = dateRangeSchema.parse(raw);
  const rows = await fetchLedgerCollection(client, {
    fromDate: args.fromDate,
    toDate: args.toDate,
    company: args.targetCompany ?? client.config.defaultCompany,
  });
  // Net activity = closing - opening (only useful for P&L groups, but we surface all).
  const out = rows
    .map((r) => [r.name, r.parent, (r.closing - r.opening).toFixed(2)])
    .filter(([, , amt]) => Math.abs(Number(amt)) > 0.001);
  return toCsv(["ledger", "group", "amount"], out);
};

/* -------------------------------------------------------------------------- */
/*  ledger_balance                                                            */
/* -------------------------------------------------------------------------- */

const ledgerBalanceSchema = z.object({
  ledgerName: z.string().min(1),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const ledgerBalance: ToolHandler = async (raw, client) => {
  const args = ledgerBalanceSchema.parse(raw);
  const xml = buildExportObjectEnvelope({
    subType: "Ledger",
    id: args.ledgerName,
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      toDate: args.toDate,
    },
    fetchList: ["Name", "Parent", "ClosingBalance", "OpeningBalance"],
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const obj =
    tree?.ENVELOPE?.BODY?.DATA?.TALLYMESSAGE?.LEDGER ??
    tree?.ENVELOPE?.BODY?.DATA?.LEDGER ??
    tree?.ENVELOPE?.BODY?.DATA ??
    {};
  return JSON.stringify(
    {
      name: s(obj?.["@_NAME"] ?? obj?.NAME ?? args.ledgerName),
      parent: s(obj?.PARENT ?? ""),
      opening_balance: amount(obj?.OPENINGBALANCE),
      closing_balance: amount(obj?.CLOSINGBALANCE),
      sign_convention: "Negative = Debit, Positive = Credit",
    },
    null,
    2
  );
};

/* -------------------------------------------------------------------------- */
/*  ledger_account (statement)                                                */
/* -------------------------------------------------------------------------- */

const ledgerStatementSchema = z.object({
  ledgerName: z.string().min(1),
  fromDate: z.string(),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const ledgerStatement: ToolHandler = async (raw, client) => {
  const args = ledgerStatementSchema.parse(raw);
  const company = args.targetCompany ?? client.config.defaultCompany;

  // Build a Voucher collection filtered to entries that involve this ledger.
  // $$IsLedgerUsed:<LedgerEntries collection>:<ledger name> is a Tally TDL
  // function that returns TRUE when the named ledger appears in the voucher.
  const ledgerNameEsc = escapeXml(args.ledgerName);

  const collectionName = "MCP_LedgerAccount";
  // WALK into AllLedgerEntries so each row is one ledger-entry line.
  // Tally merges parent Voucher fields (Date/VoucherTypeName/VoucherNumber/Narration)
  // into the row automatically, giving us the full account statement.
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>Voucher</TYPE>
      <WALK>AllLedgerEntries</WALK>
      <NATIVEMETHOD>Date</NATIVEMETHOD>
      <NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
      <NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
      <NATIVEMETHOD>Narration</NATIVEMETHOD>
      <NATIVEMETHOD>LedgerName</NATIVEMETHOD>
      <NATIVEMETHOD>Amount</NATIVEMETHOD>
      <NATIVEMETHOD>IsDeemedPositive</NATIVEMETHOD>
      <NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
      <FILTERS>MCPLedgerFilter</FILTERS>
    </COLLECTION>
    <SYSTEM TYPE="Formulae" NAME="MCPLedgerFilter">$LedgerName = "${ledgerNameEsc}"</SYSTEM>`;

  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: { company, fromDate: args.fromDate, toDate: args.toDate },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const vouchers = asArray<any>(
    tree?.ENVELOPE?.BODY?.DATA?.COLLECTION?.VOUCHER ?? []
  );

  // If no structured COLLECTION/VOUCHER found, return raw XML so the caller
  // can inspect the actual response and we can iterate on the filter formula.
  if (vouchers.length === 0) {
    return body;
  }

  const rows = vouchers
    .filter((v: any) => s(v?.ISCANCELLED ?? "").toLowerCase() !== "yes")
    .map((v: any) => {
      // IsDeemedPositive = "Yes" means Debit for the ledger.
      const isDr = s(v?.ISDEEMEDPOSITIVE ?? "").toLowerCase() === "yes";
      return [
        s(v?.DATE ?? ""),
        s(v?.VOUCHERTYPENAME ?? v?.["@_VCHTYPE"] ?? ""),
        s(v?.VOUCHERNUMBER ?? ""),
        Math.abs(amount(v?.AMOUNT ?? 0)).toFixed(2),
        isDr ? "Dr" : "Cr",
        s(v?.NARRATION ?? ""),
      ];
    });
  return toCsv(
    ["date", "voucher_type", "voucher_number", "amount", "dr_cr", "narration"],
    rows
  );
};

/* -------------------------------------------------------------------------- */
/*  day_book                                                                  */
/* -------------------------------------------------------------------------- */

const dayBookSchema = z.object({
  fromDate: z.string(),
  toDate: z.string(),
  voucherType: z.string().optional().describe("Filter to one voucher type, e.g. 'Sales'."),
  targetCompany: z.string().optional(),
});

const dayBook: ToolHandler = async (raw, client) => {
  const args = dayBookSchema.parse(raw);
  const tdl = args.voucherType
    ? `
      <REPORT NAME="Day Book" ISMODIFY="Yes">
        <LOCAL>Collection : Default : Add :Filter : MCPVchTypeFilter</LOCAL>
        <LOCAL>Collection : Default : Add :Fetch : VoucherTypeName</LOCAL>
      </REPORT>
      <SYSTEM TYPE="Formulae" NAME="MCPVchTypeFilter">$VoucherTypeName="${args.voucherType.replace(/"/g, '\\"')}"</SYSTEM>`
    : undefined;
  const xml = buildExportEnvelope({
    reportId: "Day Book",
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      fromDate: args.fromDate,
      toDate: args.toDate,
    },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  return body; // raw Day Book XML — LLM-readable
};

/* -------------------------------------------------------------------------- */
/*  stock_summary / stock_item_balance / stock_item_account                   */
/* -------------------------------------------------------------------------- */

const stockSummarySchema = z.object({
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const stockSummary: ToolHandler = async (raw, client) => {
  const args = stockSummarySchema.parse(raw);
  const collectionName = "MCP_StockItem_Summary";
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>StockItem</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>Parent</NATIVEMETHOD>
      <NATIVEMETHOD>BaseUnits</NATIVEMETHOD>
      <NATIVEMETHOD>ClosingBalance</NATIVEMETHOD>
      <NATIVEMETHOD>ClosingValue</NATIVEMETHOD>
      <NATIVEMETHOD>ClosingRate</NATIVEMETHOD>
    </COLLECTION>`;
  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      toDate: args.toDate,
    },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const items = asArray<any>(
    tree?.ENVELOPE?.BODY?.DATA?.COLLECTION?.STOCKITEM ?? []
  );
  const rows = items.map((it) => [
    s(it?.["@_NAME"] ?? it?.NAME ?? ""),
    s(it?.PARENT ?? ""),
    s(it?.BASEUNITS ?? ""),
    s(it?.CLOSINGBALANCE ?? ""),
    s(it?.CLOSINGRATE ?? ""),
    amount(it?.CLOSINGVALUE ?? 0).toFixed(2),
  ]);
  return toCsv(
    ["item", "group", "unit", "closing_qty", "closing_rate", "closing_value"],
    rows
  );
};

const stockItemBalanceSchema = z.object({
  itemName: z.string().min(1),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const stockItemBalance: ToolHandler = async (raw, client) => {
  const args = stockItemBalanceSchema.parse(raw);
  const xml = buildExportObjectEnvelope({
    subType: "StockItem",
    id: args.itemName,
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      toDate: args.toDate,
    },
    fetchList: [
      "Name", "Parent", "BaseUnits",
      "OpeningBalance", "OpeningRate", "OpeningValue",
      "ClosingBalance", "ClosingRate", "ClosingValue",
    ],
  });
  return await client.send(xml);
};

const stockItemAccountSchema = z.object({
  itemName: z.string().min(1),
  fromDate: z.string(),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const stockItemAccount: ToolHandler = async (raw, client) => {
  const args = stockItemAccountSchema.parse(raw);
  const xml = buildExportEnvelope({
    reportId: "Stock Vouchers",
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      fromDate: args.fromDate,
      toDate: args.toDate,
      extra: { StockItemName: args.itemName },
    },
  });
  return await client.send(xml);
};

/* -------------------------------------------------------------------------- */
/*  bills_outstanding                                                         */
/* -------------------------------------------------------------------------- */

const billsOutstandingSchema = z.object({
  nature: z.enum(["receivable", "payable"]),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const billsOutstanding: ToolHandler = async (raw, client) => {
  const args = billsOutstandingSchema.parse(raw);
  const reportId = args.nature === "receivable" ? "Bills Receivable" : "Bills Payable";
  const xml = buildExportEnvelope({
    reportId,
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      toDate: args.toDate,
    },
  });
  return await client.send(xml);
};

/* -------------------------------------------------------------------------- */
/*  ledger_outstanding (single party drill-down)                              */
/* -------------------------------------------------------------------------- */

const ledgerOutstandingSchema = z.object({
  ledgerName: z.string().min(1),
  toDate: z.string(),
  targetCompany: z.string().optional(),
});

const ledgerOutstanding: ToolHandler = async (raw, client) => {
  const args = ledgerOutstandingSchema.parse(raw);
  const xml = buildExportEnvelope({
    reportId: "Ledger Outstandings",
    staticVariables: {
      company: args.targetCompany ?? client.config.defaultCompany,
      toDate: args.toDate,
      extra: { LedgerName: args.ledgerName },
    },
  });
  return await client.send(xml);
};

/* -------------------------------------------------------------------------- */
/*  chart_of_accounts                                                         */
/* -------------------------------------------------------------------------- */

const chartOfAccountsSchema = z.object({
  targetCompany: z.string().optional(),
});

const chartOfAccounts: ToolHandler = async (raw, client) => {
  const args = chartOfAccountsSchema.parse(raw);
  const collectionName = "MCP_ChartOfAccounts";
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>Group</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>Parent</NATIVEMETHOD>
      <NATIVEMETHOD>IsRevenue</NATIVEMETHOD>
      <NATIVEMETHOD>IsDeemedPositive</NATIVEMETHOD>
      <NATIVEMETHOD>AffectsGrossProfit</NATIVEMETHOD>
    </COLLECTION>`;
  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const groups = asArray<any>(
    tree?.ENVELOPE?.BODY?.DATA?.COLLECTION?.GROUP ?? []
  );
  const rows = groups.map((g) => {
    // Use s() not String() — Tally returns TYPE="Logical" attributes which fast-xml-parser
    // wraps as {"#text":"Yes","@_TYPE":"Logical"}. s() correctly extracts #text.
    const isRevenue = s(g?.ISREVENUE ?? "").toLowerCase() === "yes";
    const isDeemedPositive = s(g?.ISDEEMEDPOSITIVE ?? "").toLowerCase() === "yes";
    return [
      s(g?.["@_NAME"] ?? g?.NAME ?? ""),
      s(g?.PARENT ?? ""),
      isRevenue ? "PL" : "BS",
      isDeemedPositive ? "D" : "C",
      s(g?.AFFECTSGROSSPROFIT ?? "").toLowerCase() === "yes" ? "Y" : "N",
    ];
  });
  return toCsv(["group", "parent", "bs_pl", "dr_cr", "affects_gross_profit"], rows);
};

/* -------------------------------------------------------------------------- */
/*  raw_request escape hatch                                                  */
/* -------------------------------------------------------------------------- */

const rawRequestSchema = z.object({
  xml: z.string().min(1).describe("A complete <ENVELOPE>...</ENVELOPE> Tally XML request."),
});

const rawRequest: ToolHandler = async (raw, client) => {
  const args = rawRequestSchema.parse(raw);
  return await client.send(args.xml);
};

/* -------------------------------------------------------------------------- */

export const reportTools: Tool[] = [
  {
    name: "tally_trial_balance",
    description:
      "Trial Balance for a period — opening & closing balance of every ledger. Sign convention: negative = Debit, positive = Credit.",
    inputSchema: dateRangeSchema,
    handler: trialBalance,
  },
  {
    name: "tally_balance_sheet",
    description: "Balance Sheet as on a date — closing balance per ledger with its group.",
    inputSchema: asOfSchema,
    handler: balanceSheet,
  },
  {
    name: "tally_profit_loss",
    description:
      "Profit & Loss for a period — net activity per ledger (closing minus opening). Negative = expense, positive = income.",
    inputSchema: dateRangeSchema,
    handler: profitLoss,
  },
  {
    name: "tally_ledger_balance",
    description: "Closing balance of a single ledger as on a given date.",
    inputSchema: ledgerBalanceSchema,
    handler: ledgerBalance,
  },
  {
    name: "tally_ledger_account",
    description: "Ledger account statement (voucher-level activity) for one ledger over a period.",
    inputSchema: ledgerStatementSchema,
    handler: ledgerStatement,
  },
  {
    name: "tally_ledger_outstanding",
    description: "Outstanding bills for a single party ledger as on a date.",
    inputSchema: ledgerOutstandingSchema,
    handler: ledgerOutstanding,
  },
  {
    name: "tally_day_book",
    description:
      "Day Book — all vouchers in a date range, optionally filtered by voucher type. Returns Tally's XML report verbatim.",
    inputSchema: dayBookSchema,
    handler: dayBook,
  },
  {
    name: "tally_stock_summary",
    description: "Stock Summary as on a date — closing qty / rate / value per stock item.",
    inputSchema: stockSummarySchema,
    handler: stockSummary,
  },
  {
    name: "tally_stock_item_balance",
    description: "Opening + closing qty, rate, value for a single stock item.",
    inputSchema: stockItemBalanceSchema,
    handler: stockItemBalance,
  },
  {
    name: "tally_stock_item_account",
    description: "Voucher-level inward/outward movement for a single stock item over a period.",
    inputSchema: stockItemAccountSchema,
    handler: stockItemAccount,
  },
  {
    name: "tally_bills_outstanding",
    description: "Bills Receivable (nature: receivable) or Bills Payable (nature: payable) as on a date.",
    inputSchema: billsOutstandingSchema,
    handler: billsOutstanding,
  },
  {
    name: "tally_chart_of_accounts",
    description: "Group hierarchy — useful for classifying ledgers into Balance Sheet vs P&L, Dr vs Cr, and gross-profit groups.",
    inputSchema: chartOfAccountsSchema,
    handler: chartOfAccounts,
  },
  {
    name: "tally_raw_request",
    description:
      "Escape hatch — POST any well-formed Tally XML envelope (Export/Import/Execute) and return the raw response. Use for reports or actions not covered by the typed tools.",
    inputSchema: rawRequestSchema,
    handler: rawRequest,
  },
];
