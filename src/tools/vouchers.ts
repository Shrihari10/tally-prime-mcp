// MCP tools for Tally VOUCHER data:
//   - tally_create_voucher: post Sales / Purchase / Receipt / Payment / Journal / Contra / Stock Journal / Debit Note / Credit Note
//   - tally_alter_voucher / tally_cancel_voucher
//   - tally_get_voucher: fetch a single voucher
//
// XML structure is drawn from
//   https://help.tallysolutions.com/sample-xml/

import { z } from "zod";
import {
  buildImportEnvelope,
  buildExportCollectionEnvelope,
  escapeXml,
  parseImportResult,
  tallyDate,
} from "../tally/xml.js";
import type { Tool, ToolHandler } from "./types.js";

/* -------------------------------------------------------------------------- */
/*  Shared schemas                                                            */
/* -------------------------------------------------------------------------- */

export const ledgerEntrySchema = z.object({
  ledger: z.string().min(1).describe("Ledger name — must exist in Tally."),
  amount: z.number().describe(
    "Signed amount. Negative = Debit (Dr), Positive = Credit (Cr). Total Dr must equal total Cr."
  ),
  isPartyLedger: z.boolean().optional().describe(
    "Mark this line as the party ledger (used for receivables/payables tracking)."
  ),
  billAllocations: z.array(z.object({
    billName: z.string(),
    billType: z.enum(["Advance", "Agst Ref", "New Ref", "On Account"]).default("New Ref"),
    amount: z.number(),
  })).optional(),
  costCentre: z.array(z.object({
    category: z.string().optional(),
    name: z.string(),
    amount: z.number(),
  })).optional(),
});

export const inventoryEntrySchema = z.object({
  stockItem: z.string().min(1),
  quantity: z.number().describe("Quantity (positive number). Tally infers direction from voucher type."),
  rate: z.number().optional(),
  amount: z.number(),
  unit: z.string().optional().describe("Unit symbol, e.g. 'nos', 'kg'. Defaults to the item's base unit."),
  godown: z.string().optional(),
  batch: z.string().optional(),
  destinationGodown: z.string().optional(),
  accountingLedger: z.string().optional().describe(
    "Sales/Purchase ledger to allocate this line to (Invoice mode)."
  ),
  isDeemedPositive: z.boolean().optional(),
});

export const voucherSchema = z.object({
  voucherType: z.string().min(1).describe(
    "Voucher Type name — Sales, Purchase, Receipt, Payment, Journal, Contra, Stock Journal, " +
    "Debit Note, Credit Note, Sales Order, Purchase Order, or any custom type."
  ),
  date: z.string().describe("Voucher date (YYYY-MM-DD, DD-MM-YYYY, or YYYYMMDD)."),
  voucherNumber: z.string().optional(),
  reference: z.string().optional().describe(
    "Reference / customer PO number. Required for Sales Order and Purchase Order — " +
    "used as the order reference in Tally. Defaults to the voucher date if omitted for order types."
  ),
  narration: z.string().optional(),
  partyLedger: z.string().optional().describe(
    "Party ledger for the voucher header (used by Sales/Purchase/Receipt/Payment/Orders)."
  ),
  isInvoice: z.boolean().optional().describe(
    "True for accounting/item invoice mode; false for voucher mode. " +
    "Sales Order and Purchase Order always use false regardless of this flag."
  ),
  view: z.enum([
    "Accounting Voucher View",
    "Invoice Voucher View",
    "Inventory Voucher View",
    "Order Voucher View",
  ]).optional().describe(
    "Tally persisted view. Auto-detected from voucherType when omitted: " +
    "Sales Order / Purchase Order → Invoice Voucher View; " +
    "isInvoice:true → Invoice Voucher View; otherwise Accounting Voucher View."
  ),
  ledgerEntries: z.array(ledgerEntrySchema).min(1).describe(
    "Debit/Credit lines. Negative amount = Debit, positive amount = Credit. " +
    "For order/invoice vouchers with inventory, only the party ledger line is required here; " +
    "the sales/purchase ledger lives inside inventoryEntries[].accountingLedger."
  ),
  inventoryEntries: z.array(inventoryEntrySchema).optional(),
  targetCompany: z.string().optional(),
});

type VoucherInput = z.infer<typeof voucherSchema>;
type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
type InventoryEntry = z.infer<typeof inventoryEntrySchema>;

/* -------------------------------------------------------------------------- */
/*  Rendering                                                                 */
/* -------------------------------------------------------------------------- */

function renderLedgerEntry(e: LedgerEntry): string {
  const isDr = e.amount < 0;
  const billLines = (e.billAllocations ?? []).map((b) => `
    <BILLALLOCATIONS.LIST>
      <NAME>${escapeXml(b.billName)}</NAME>
      <BILLTYPE>${escapeXml(b.billType)}</BILLTYPE>
      <AMOUNT>${b.amount.toFixed(2)}</AMOUNT>
    </BILLALLOCATIONS.LIST>`).join("");
  const ccLines = (e.costCentre ?? []).length
    ? `<CATEGORYALLOCATIONS.LIST>${(e.costCentre ?? [])
        .map((cc) => `
          <CATEGORY>${escapeXml(cc.category ?? "Primary Cost Category")}</CATEGORY>
          <COSTCENTREALLOCATIONS.LIST>
            <NAME>${escapeXml(cc.name)}</NAME>
            <AMOUNT>${cc.amount.toFixed(2)}</AMOUNT>
          </COSTCENTREALLOCATIONS.LIST>`).join("")}
      </CATEGORYALLOCATIONS.LIST>`
    : "";
  return `
    <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${escapeXml(e.ledger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${isDr ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${e.isPartyLedger ? "<ISPARTYLEDGER>Yes</ISPARTYLEDGER>" : ""}
      <AMOUNT>${e.amount.toFixed(2)}</AMOUNT>
      ${billLines}
      ${ccLines}
    </ALLLEDGERENTRIES.LIST>`;
}

/** Extra context injected by renderVoucher for order-type vouchers. */
interface InvEntryContext {
  /** Customer's order/PO reference — required for Sales Order / Purchase Order. */
  orderNo?: string;
  /** Delivery / due date for the order line (YYYYMMDD). */
  orderDueDate?: string;
}

function renderInventoryEntry(i: InventoryEntry, ctx?: InvEntryContext): string {
  const unit = i.unit ?? "nos";
  const isDeemed = i.isDeemedPositive ?? false;
  const rateBlock = i.rate !== undefined
    ? `<RATE>${i.rate.toFixed(2)}/${escapeXml(unit)}</RATE>`
    : "";
  const batch = `
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(i.godown ?? "Main Location")}</GODOWNNAME>
      <BATCHNAME>${escapeXml(i.batch ?? "Primary Batch")}</BATCHNAME>
      ${i.destinationGodown ? `<DESTINATIONGODOWNNAME>${escapeXml(i.destinationGodown)}</DESTINATIONGODOWNNAME>` : ""}
      ${ctx?.orderNo ? `<ORDERNO>${escapeXml(ctx.orderNo)}</ORDERNO>` : ""}
      ${ctx?.orderDueDate ? `<ORDERDUEDATE>${tallyDate(ctx.orderDueDate)}</ORDERDUEDATE>` : ""}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${i.quantity} ${escapeXml(unit)}</ACTUALQTY>
      <BILLEDQTY>${i.quantity} ${escapeXml(unit)}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>`;
  const accAllocation = i.accountingLedger
    ? `<ACCOUNTINGALLOCATIONS.LIST>
        <LEDGERNAME>${escapeXml(i.accountingLedger)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
        <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      </ACCOUNTINGALLOCATIONS.LIST>`
    : "";
  return `
    <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${escapeXml(i.stockItem)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>${isDeemed ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
      ${rateBlock}
      <AMOUNT>${i.amount.toFixed(2)}</AMOUNT>
      <ACTUALQTY>${i.quantity} ${escapeXml(unit)}</ACTUALQTY>
      <BILLEDQTY>${i.quantity} ${escapeXml(unit)}</BILLEDQTY>
      ${batch}
      ${accAllocation}
    </ALLINVENTORYENTRIES.LIST>`;
}

/** Voucher types that are Order-class in Tally — they use Invoice Voucher View but ISINVOICE=No. */
const ORDER_VOUCHER_TYPES = new Set([
  "Sales Order", "Purchase Order",
  "Job Work In Order", "Job Work Out Order",
]);

function renderVoucher(args: VoucherInput): string {
  const isOrderType = ORDER_VOUCHER_TYPES.has(args.voucherType);

  // Auto-detect the persisted view:
  //  - Caller override always wins
  //  - Order vouchers (Sales Order / Purchase Order) → Invoice Voucher View
  //  - isInvoice:true → Invoice Voucher View
  //  - Otherwise → Accounting Voucher View
  const view = args.view
    ?? (isOrderType ? "Invoice Voucher View"
      : args.isInvoice ? "Invoice Voucher View"
      : "Accounting Voucher View");

  // ISINVOICE controls whether Tally treats the entry as an invoice.
  // Order vouchers always use "No" even though their view is "Invoice Voucher View".
  const isInvoice = isOrderType ? false : (args.isInvoice ?? view === "Invoice Voucher View");

  const ledgerXml = args.ledgerEntries.map(renderLedgerEntry).join("");
  // For order-type vouchers, pass ORDERNO (= voucher reference) and ORDERDUEDATE (= voucher date)
  // into each batch allocation — Tally requires a non-empty ORDERNO for Sales/Purchase Orders.
  const invCtx: InvEntryContext | undefined = isOrderType
    ? { orderNo: args.reference || tallyDate(args.date), orderDueDate: args.date }
    : undefined;
  const invXml = (args.inventoryEntries ?? []).map((i) => renderInventoryEntry(i, invCtx ?? undefined)).join("");

  return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${escapeXml(args.voucherType)}" ACTION="Create" OBJVIEW="${escapeXml(view)}">
        <DATE>${tallyDate(args.date)}</DATE>
        <VOUCHERTYPENAME>${escapeXml(args.voucherType)}</VOUCHERTYPENAME>
        ${args.voucherNumber ? `<VOUCHERNUMBER>${escapeXml(args.voucherNumber)}</VOUCHERNUMBER>` : ""}
        ${args.reference ? `<REFERENCE>${escapeXml(args.reference)}</REFERENCE>` : ""}
        ${args.partyLedger ? `<PARTYLEDGERNAME>${escapeXml(args.partyLedger)}</PARTYLEDGERNAME>` : ""}
        ${args.partyLedger ? `<PARTYNAME>${escapeXml(args.partyLedger)}</PARTYNAME>` : ""}
        <PERSISTEDVIEW>${escapeXml(view)}</PERSISTEDVIEW>
        <ISINVOICE>${isInvoice ? "Yes" : "No"}</ISINVOICE>
        ${args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : ""}
        ${ledgerXml}
        ${invXml}
      </VOUCHER>
    </TALLYMESSAGE>`;
}

/* -------------------------------------------------------------------------- */
/*  Handlers                                                                  */
/* -------------------------------------------------------------------------- */

const createVoucher: ToolHandler = async (raw, client) => {
  const args = voucherSchema.parse(raw);

  // Sanity-check that debits and credits balance (to within 0.01).
  // For invoice/order vouchers the sales or purchase ledger lives inside
  // inventoryEntries[].accountingLedger rather than in ledgerEntries, so
  // include those accounting-allocation amounts in the net check.
  const ledgerNet = args.ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  const invAccNet = (args.inventoryEntries ?? []).reduce(
    (sum, i) => (i.accountingLedger !== undefined ? sum + i.amount : sum), 0
  );
  const total = ledgerNet + invAccNet;
  if (Math.abs(total) > 0.01) {
    throw new Error(
      `Voucher entries do not balance: net = ${total.toFixed(2)}. ` +
        `Negative amounts are Debits, positive are Credits — combined ledger entries ` +
        `and inventory accounting allocations must sum to zero.`
    );
  }

  const xml = buildImportEnvelope({
    reportName: "Vouchers",
    body: renderVoucher(args),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  const result = parseImportResult(body);
  if (result.errors > 0 || result.lineError) {
    throw new Error(
      `Tally rejected the voucher: ${result.lineError ?? "see raw response"}\n\n${body}`
    );
  }
  // For order-type vouchers (Sales Order / Purchase Order) Tally Prime 6.0
  // places the import count in the EXCEPTIONS field instead of CREATED.
  // Treat exceptions > 0 (and no lineError) as a successful creation.
  if (result.created === 0 && result.altered === 0 && result.exceptions === 0) {
    // Nothing was created, altered, or excepted — surface the raw response.
    return JSON.stringify({ ...result, warning: "Tally reported 0 created/altered/exceptions — check raw response." }, null, 2);
  }
  return JSON.stringify(result, null, 2);
};

/* ----- alter & cancel use the TAGNAME / TAGVALUE pattern ------------------ */

const alterVoucherSchema = z.object({
  voucherType: z.string().min(1),
  date: z.string(),
  voucherNumber: z.string().min(1),
  narration: z.string().optional(),
  newLedgerEntries: z.array(ledgerEntrySchema).optional(),
  newInventoryEntries: z.array(inventoryEntrySchema).optional(),
  targetCompany: z.string().optional(),
});

const alterVoucher: ToolHandler = async (raw, client) => {
  const args = alterVoucherSchema.parse(raw);
  const inner = [
    args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : "",
    (args.newLedgerEntries ?? []).map(renderLedgerEntry).join(""),
    (args.newInventoryEntries ?? []).map((i) => renderInventoryEntry(i)).join(""),
  ].join("");
  const body = `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER DATE="${tallyDate(args.date)}" TAGNAME="VoucherNumber" TAGVALUE="${escapeXml(args.voucherNumber)}" Action="Alter" VCHTYPE="${escapeXml(args.voucherType)}">
        ${inner}
      </VOUCHER>
    </TALLYMESSAGE>`;
  const xml = buildImportEnvelope({
    reportName: "Vouchers",
    body,
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const respBody = await client.send(xml);
  return JSON.stringify(parseImportResult(respBody), null, 2);
};

const cancelVoucherSchema = z.object({
  voucherType: z.string().min(1),
  date: z.string(),
  voucherNumber: z.string().min(1),
  narration: z.string().optional(),
  targetCompany: z.string().optional(),
});

const cancelVoucher: ToolHandler = async (raw, client) => {
  const args = cancelVoucherSchema.parse(raw);
  const body = `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER DATE="${tallyDate(args.date)}" TAGNAME="VoucherNumber" TAGVALUE="${escapeXml(args.voucherNumber)}" Action="Cancel" VCHTYPE="${escapeXml(args.voucherType)}">
        ${args.narration ? `<NARRATION>${escapeXml(args.narration)}</NARRATION>` : ""}
      </VOUCHER>
    </TALLYMESSAGE>`;
  const xml = buildImportEnvelope({
    reportName: "Vouchers",
    body,
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const respBody = await client.send(xml);
  return JSON.stringify(parseImportResult(respBody), null, 2);
};

/* ----- get_voucher -------------------------------------------------------- */

const getVoucherSchema = z.object({
  voucherNumber: z.string().min(1),
  voucherType: z.string().optional(),
  targetCompany: z.string().optional(),
});

const getVoucher: ToolHandler = async (raw, client) => {
  const args = getVoucherSchema.parse(raw);
  const company = args.targetCompany ?? client.config.defaultCompany;

  // Object export for Vouchers by VoucherNumber doesn't work in Tally Prime 6.0
  // (error: "Could not find Voucher:<num>!"). Use a Voucher collection filtered
  // by $VoucherNumber instead — this reliably returns the full voucher XML.
  const vchNumEsc = escapeXml(args.voucherNumber);
  const typeClause = args.voucherType
    ? ` AND $VoucherTypeName = "${escapeXml(args.voucherType)}"`
    : "";
  const collectionName = "MCP_GetVoucher";
  // Specifying at least some NATIVEMETHODs on a Voucher collection causes Tally
  // to include the full ALLLEDGERENTRIES / ALLINVENTORYENTRIES child data.
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>Voucher</TYPE>
      <NATIVEMETHOD>Date</NATIVEMETHOD>
      <NATIVEMETHOD>VoucherTypeName</NATIVEMETHOD>
      <NATIVEMETHOD>VoucherNumber</NATIVEMETHOD>
      <NATIVEMETHOD>Reference</NATIVEMETHOD>
      <NATIVEMETHOD>Narration</NATIVEMETHOD>
      <NATIVEMETHOD>PartyLedgerName</NATIVEMETHOD>
      <NATIVEMETHOD>Amount</NATIVEMETHOD>
      <NATIVEMETHOD>IsCancelled</NATIVEMETHOD>
      <FILTERS>MCPVchFilt</FILTERS>
    </COLLECTION>
    <SYSTEM TYPE="Formulae" NAME="MCPVchFilt">$VoucherNumber = "${vchNumEsc}"${typeClause}</SYSTEM>`;

  const xml = buildExportCollectionEnvelope({
    collectionName,
    // No date range — search across the full company data.
    staticVariables: { company },
    tdlMessage: tdl,
  });
  return await client.send(xml);
};

/* -------------------------------------------------------------------------- */

export const voucherTools: Tool[] = [
  {
    name: "tally_create_voucher",
    description:
      "Post a voucher (Sales, Purchase, Receipt, Payment, Journal, Contra, Stock Journal, Debit Note, Credit Note, Sales Order, Purchase Order, or any custom type). " +
      "Ledger entries use signed amounts: NEGATIVE = Debit, POSITIVE = Credit. " +
      "For Sales Order / Purchase Order: set voucherType to 'Sales Order'/'Purchase Order', provide the party ledger in ledgerEntries (negative = Dr for customer), " +
      "and add inventoryEntries with stockItem/quantity/rate/amount (POSITIVE amounts) and accountingLedger pointing to the sales/purchase ledger. " +
      "The balance check includes both ledgerEntries and inventoryEntries[].accountingLedger amounts — they must sum to zero together.",
    inputSchema: voucherSchema,
    handler: createVoucher,
  },
  {
    name: "tally_alter_voucher",
    description: "Alter (modify) an existing voucher identified by voucher type + number + date.",
    inputSchema: alterVoucherSchema,
    handler: alterVoucher,
  },
  {
    name: "tally_cancel_voucher",
    description: "Cancel an existing voucher.",
    inputSchema: cancelVoucherSchema,
    handler: cancelVoucher,
  },
  {
    name: "tally_get_voucher",
    description: "Fetch full details for a single voucher by voucher number.",
    inputSchema: getVoucherSchema,
    handler: getVoucher,
  },
];
