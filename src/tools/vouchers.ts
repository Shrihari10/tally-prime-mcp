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
    "Voucher Type name — Sales, Purchase, Receipt, Payment, Journal, Contra, Stock Journal, Debit Note, Credit Note, or any custom type."
  ),
  date: z.string().describe("Voucher date (YYYY-MM-DD, DD-MM-YYYY, or YYYYMMDD)."),
  voucherNumber: z.string().optional(),
  reference: z.string().optional(),
  narration: z.string().optional(),
  partyLedger: z.string().optional().describe(
    "Party ledger for the voucher header (used by Sales/Purchase/Receipt/Payment)."
  ),
  isInvoice: z.boolean().optional().describe(
    "True for accounting/item invoice mode; false for voucher mode (default false)."
  ),
  view: z.enum([
    "Accounting Voucher View",
    "Invoice Voucher View",
    "Inventory Voucher View",
  ]).optional(),
  ledgerEntries: z.array(ledgerEntrySchema).min(1).describe(
    "Debit/Credit lines. Negative amount = Debit, positive amount = Credit. Total must net to zero."
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

function renderInventoryEntry(i: InventoryEntry): string {
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

function renderVoucher(args: VoucherInput): string {
  // Default view based on isInvoice
  const view = args.view
    ?? (args.isInvoice ? "Invoice Voucher View" : "Accounting Voucher View");
  const isInvoice = args.isInvoice ?? view === "Invoice Voucher View";

  const ledgerXml = args.ledgerEntries.map(renderLedgerEntry).join("");
  const invXml = (args.inventoryEntries ?? []).map(renderInventoryEntry).join("");

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
  const total = args.ledgerEntries.reduce((sum, e) => sum + e.amount, 0);
  if (Math.abs(total) > 0.01) {
    throw new Error(
      `Voucher ledger entries do not balance: net = ${total.toFixed(2)}. ` +
        `Negative amounts are Debits, positive are Credits — they must sum to zero.`
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
    (args.newInventoryEntries ?? []).map(renderInventoryEntry).join(""),
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
      "Post a voucher (Sales, Purchase, Receipt, Payment, Journal, Contra, Stock Journal, Debit Note, Credit Note, or any custom type). Ledger entries use signed amounts: NEGATIVE = Debit, POSITIVE = Credit, and the lines must net to zero. For an invoice-style sales/purchase, set isInvoice:true and include inventoryEntries with accountingLedger.",
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
