// MCP tools for Tally MASTER data: create / alter / list ledgers, groups,
// stock items, units, godowns, cost centres, voucher types, etc.
//
// XML schemas come from
//   https://help.tallysolutions.com/sample-xml/
//   https://help.tallysolutions.com/understanding-tally-xml-tags/

import { z } from "zod";
import { TallyClient } from "../tally/client.js";
import {
  buildImportEnvelope,
  buildExportCollectionEnvelope,
  buildExportObjectEnvelope,
  escapeXml,
  parseImportResult,
  parseTallyXml,
} from "../tally/xml.js";
import { asArray, n, s, toCsv } from "../tally/util.js";
import type { Tool, ToolHandler } from "./types.js";

/* -------------------------------------------------------------------------- */
/*  Helpers to render the master XML body                                     */
/* -------------------------------------------------------------------------- */

function tag(name: string, value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  return `<${name}>${escapeXml(value as any)}</${name}>`;
}

function wrapMasters(inner: string): string {
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE>`;
}

/* -------------------------------------------------------------------------- */
/*  list_masters                                                              */
/* -------------------------------------------------------------------------- */

const MASTER_COLLECTIONS = [
  "Group",
  "Ledger",
  "VoucherType",
  "Unit",
  "Godown",
  "StockGroup",
  "StockItem",
  "StockCategory",
  "CostCentre",
  "CostCategory",
  "AttendanceType",
  "Company",
  "Currency",
  "Employee",
  "Budget",
] as const;

const listMastersSchema = z.object({
  collection: z.enum(MASTER_COLLECTIONS),
  targetCompany: z.string().optional()
    .describe("Tally company name; defaults to the active company."),
});

const listMasters: ToolHandler = async (raw, client) => {
  const args = listMastersSchema.parse(raw);
  // Use a small inline TDL collection to fetch just the names + parent.
  // This works regardless of which default collection ships with the user's Tally.
  const collectionName = `MCP_${args.collection}_List`;
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>${args.collection}</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>Parent</NATIVEMETHOD>
      <NATIVEMETHOD>Alias</NATIVEMETHOD>
    </COLLECTION>`;
  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const data = tree?.ENVELOPE?.BODY?.DATA ?? tree?.ENVELOPE ?? {};
  const collection = data?.COLLECTION ?? {};
  const items = asArray<any>(collection?.[args.collection.toUpperCase()]);
  const rows = items.map((it) => [
    s(it?.["@_NAME"] ?? it?.NAME ?? ""),
    s(it?.PARENT ?? ""),
  ]);
  return toCsv(["name", "parent"], rows);
};

/* -------------------------------------------------------------------------- */
/*  list_companies                                                            */
/* -------------------------------------------------------------------------- */

const listCompaniesSchema = z.object({});

const listCompanies: ToolHandler = async (_raw, client) => {
  // "List of Companies" report does not exist in Tally Prime 6.0 — use a TDL collection instead.
  const collectionName = "MCP_Company_List";
  const tdl = `
    <COLLECTION NAME="${collectionName}" ISMODIFY="No">
      <TYPE>Company</TYPE>
      <NATIVEMETHOD>Name</NATIVEMETHOD>
      <NATIVEMETHOD>StartingFrom</NATIVEMETHOD>
      <NATIVEMETHOD>EndingAt</NATIVEMETHOD>
    </COLLECTION>`;
  const xml = buildExportCollectionEnvelope({
    collectionName,
    staticVariables: {},
    tdlMessage: tdl,
  });
  const body = await client.send(xml);
  const tree = parseTallyXml(body);
  const data = tree?.ENVELOPE?.BODY?.DATA ?? tree?.ENVELOPE ?? {};
  const companies = asArray<any>(data?.COLLECTION?.COMPANY);
  const rows = companies.map((c) => [
    s(c?.["@_NAME"] ?? c?.NAME ?? ""),
    s(c?.STARTINGFROM ?? ""),
    s(c?.ENDINGAT ?? ""),
  ]);
  return toCsv(["company", "books_from", "books_to"], rows);
};

/* -------------------------------------------------------------------------- */
/*  get_ledger                                                                */
/* -------------------------------------------------------------------------- */

const getLedgerSchema = z.object({
  name: z.string().min(1),
  targetCompany: z.string().optional(),
});

const getLedger: ToolHandler = async (raw, client) => {
  const args = getLedgerSchema.parse(raw);
  const xml = buildExportObjectEnvelope({
    subType: "Ledger",
    id: args.name,
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
    fetchList: [
      "Name", "Parent", "OpeningBalance", "ClosingBalance",
      "MailingName", "Address", "PinCode", "CountryName", "LedStateName",
      "Email", "EmailCC", "LedgerPhone", "LedgerMobile",
      "PartyGSTIN", "IsBillWiseOn",
    ],
  });
  return await client.send(xml);
};

/* -------------------------------------------------------------------------- */
/*  create_ledger / alter_ledger                                              */
/* -------------------------------------------------------------------------- */

const ledgerSchema = z.object({
  name: z.string().min(1),
  parent: z.string().min(1).describe(
    "Parent group, e.g. 'Sundry Debtors', 'Sundry Creditors', 'Bank Accounts', 'Sales Accounts'."
  ),
  openingBalance: z.number().optional(),
  isDeemedPositive: z.boolean().optional(),
  mailingName: z.string().optional(),
  address: z.array(z.string()).optional(),
  pincode: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  email: z.string().optional(),
  emailCC: z.string().optional(),
  phone: z.string().optional(),
  mobile: z.string().optional(),
  gstin: z.string().optional(),
  registrationType: z.enum(["Unknown", "Composition", "Consumer", "Regular", "Unregistered"]).optional(),
  panNumber: z.string().optional(),
  billByBill: z.boolean().optional(),
  alter: z.boolean().optional().describe("If true, alter an existing ledger instead of creating one."),
  targetCompany: z.string().optional(),
});

function renderLedger(args: z.infer<typeof ledgerSchema>): string {
  const action = args.alter ? "Alter" : "Create";
  const parts: string[] = [
    tag("NAME", args.name),
    tag("PARENT", args.parent),
    args.openingBalance !== undefined ? tag("OPENINGBALANCE", args.openingBalance) : "",
    args.isDeemedPositive !== undefined ? tag("ISDEEMEDPOSITIVE", args.isDeemedPositive ? "Yes" : "No") : "",
    args.pincode ? tag("PINCODE", args.pincode) : "",
    args.country ? tag("COUNTRYNAME", args.country) : "",
    args.state ? tag("LEDSTATENAME", args.state) : "",
    args.email ? tag("EMAIL", args.email) : "",
    args.emailCC ? tag("EMAILCC", args.emailCC) : "",
    args.phone ? tag("LEDGERPHONE", args.phone) : "",
    args.mobile ? tag("LEDGERMOBILE", args.mobile) : "",
    args.gstin ? tag("PARTYGSTIN", args.gstin) : "",
    args.registrationType ? tag("GSTREGISTRATIONTYPE", args.registrationType) : "",
    args.panNumber ? tag("INCOMETAXNUMBER", args.panNumber) : "",
    args.billByBill !== undefined ? tag("ISBILLWISEON", args.billByBill ? "Yes" : "No") : "",
  ];
  if (args.mailingName) {
    parts.push(
      `<MAILINGNAME.LIST TYPE="String"><MAILINGNAME>${escapeXml(args.mailingName)}</MAILINGNAME></MAILINGNAME.LIST>`
    );
  }
  if (args.address && args.address.length) {
    parts.push(
      `<ADDRESS.LIST TYPE="String">${args.address
        .map((line) => `<ADDRESS>${escapeXml(line)}</ADDRESS>`)
        .join("")}</ADDRESS.LIST>`
    );
  }
  const inner = parts.filter(Boolean).join("");
  const opening = args.alter
    ? `<LEDGER NAME="${escapeXml(args.name)}" Action="Alter">${inner}</LEDGER>`
    : `<LEDGER Action="Create">${inner}</LEDGER>`;
  return wrapMasters(opening);
}

const createOrAlterLedger: ToolHandler = async (raw, client) => {
  const args = ledgerSchema.parse(raw);
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: renderLedger(args),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  const result = parseImportResult(body);
  return JSON.stringify(result, null, 2);
};

/* -------------------------------------------------------------------------- */
/*  create_group                                                              */
/* -------------------------------------------------------------------------- */

const groupSchema = z.object({
  name: z.string().min(1),
  parent: z.string().min(1),
  isRevenue: z.boolean().optional(),
  isDeemedPositive: z.boolean().optional(),
  alter: z.boolean().optional(),
  targetCompany: z.string().optional(),
});

const createOrAlterGroup: ToolHandler = async (raw, client) => {
  const args = groupSchema.parse(raw);
  const inner = [
    tag("NAME", args.name),
    tag("PARENT", args.parent),
    args.isRevenue !== undefined ? tag("ISREVENUE", args.isRevenue ? "Yes" : "No") : "",
    args.isDeemedPositive !== undefined ? tag("ISDEEMEDPOSITIVE", args.isDeemedPositive ? "Yes" : "No") : "",
  ].filter(Boolean).join("");
  const open = args.alter
    ? `<GROUP NAME="${escapeXml(args.name)}" Action="Alter">${inner}</GROUP>`
    : `<GROUP Action="Create">${inner}</GROUP>`;
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(open),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

/* -------------------------------------------------------------------------- */
/*  create_stock_item / create_stock_group                                    */
/* -------------------------------------------------------------------------- */

const stockItemSchema = z.object({
  name: z.string().min(1),
  parent: z.string().optional().describe("Parent stock group."),
  baseUnits: z.string().min(1).describe("UOM symbol — must already exist."),
  aliases: z.array(z.string()).optional(),
  openingBalance: z.number().optional(),
  openingRate: z.number().optional(),
  openingValue: z.number().optional(),
  godown: z.string().optional(),
  gstHsnCode: z.string().optional(),
  gstApplicable: z.enum(["Applicable", "Not Applicable"]).optional(),
  alter: z.boolean().optional(),
  targetCompany: z.string().optional(),
});

const createOrAlterStockItem: ToolHandler = async (raw, client) => {
  const args = stockItemSchema.parse(raw);
  const aliasList = (args.aliases ?? []).length
    ? `<NAME.LIST TYPE="String">${args
        .aliases!.map((a) => `<NAME>${escapeXml(a)}</NAME>`)
        .join("")}</NAME.LIST>`
    : "";
  const inner = [
    tag("NAME", args.name),
    args.parent ? tag("PARENT", args.parent) : "",
    tag("BASEUNITS", args.baseUnits),
    args.gstHsnCode ? tag("GSTHSNCODE", args.gstHsnCode) : "",
    args.gstApplicable ? tag("GSTAPPLICABLE", args.gstApplicable) : "",
    args.openingBalance !== undefined ? tag("OPENINGBALANCE", args.openingBalance) : "",
    args.openingRate !== undefined ? tag("OPENINGRATE", args.openingRate) : "",
    args.openingValue !== undefined ? tag("OPENINGVALUE", args.openingValue) : "",
    args.godown ? tag("GODOWN", args.godown) : "",
    aliasList,
  ].filter(Boolean).join("");
  const open = args.alter
    ? `<STOCKITEM NAME="${escapeXml(args.name)}" Action="Alter">${inner}</STOCKITEM>`
    : `<STOCKITEM Action="Create">${inner}</STOCKITEM>`;
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(open),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

const stockGroupSchema = z.object({
  name: z.string().min(1),
  parent: z.string().optional(),
  alter: z.boolean().optional(),
  targetCompany: z.string().optional(),
});

const createStockGroup: ToolHandler = async (raw, client) => {
  const args = stockGroupSchema.parse(raw);
  const inner = [tag("NAME", args.name), args.parent ? tag("PARENT", args.parent) : ""]
    .filter(Boolean)
    .join("");
  const open = args.alter
    ? `<STOCKGROUP NAME="${escapeXml(args.name)}" Action="Alter">${inner}</STOCKGROUP>`
    : `<STOCKGROUP Action="Create">${inner}</STOCKGROUP>`;
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(open),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

/* -------------------------------------------------------------------------- */
/*  create_unit                                                               */
/* -------------------------------------------------------------------------- */

const unitSchema = z.object({
  name: z.string().min(1),
  formalName: z.string().optional(),
  decimalPlaces: z.number().int().min(0).max(4).optional(),
  isSimpleUnit: z.boolean().optional().default(true),
  baseUnits: z.string().optional().describe("For compound unit: the base unit symbol."),
  additionalUnits: z.string().optional().describe("For compound unit: secondary unit symbol."),
  conversion: z.number().optional().describe("Conversion factor for compound unit."),
  targetCompany: z.string().optional(),
});

const createUnit: ToolHandler = async (raw, client) => {
  const args = unitSchema.parse(raw);
  const isSimple = args.isSimpleUnit ?? !args.baseUnits;
  const inner = [
    tag("NAME", args.name),
    tag("ISSIMPLEUNIT", isSimple ? "Yes" : "No"),
    args.formalName ? tag("ORIGINALNAME", args.formalName) : "",
    args.decimalPlaces !== undefined ? tag("DECIMALPLACES", args.decimalPlaces) : "",
    args.baseUnits ? tag("BASEUNITS", args.baseUnits) : "",
    args.additionalUnits ? tag("ADDITIONALUNITS", args.additionalUnits) : "",
    args.conversion !== undefined ? tag("CONVERSION", args.conversion) : "",
  ].filter(Boolean).join("");
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(`<UNIT Action="Create">${inner}</UNIT>`),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

/* -------------------------------------------------------------------------- */
/*  create_godown / create_cost_centre                                        */
/* -------------------------------------------------------------------------- */

const godownSchema = z.object({
  name: z.string().min(1),
  parent: z.string().optional(),
  targetCompany: z.string().optional(),
});

const createGodown: ToolHandler = async (raw, client) => {
  const args = godownSchema.parse(raw);
  const inner = [tag("NAME", args.name), args.parent ? tag("PARENT", args.parent) : ""]
    .filter(Boolean).join("");
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(`<GODOWN Action="Create">${inner}</GODOWN>`),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

const costCentreSchema = z.object({
  name: z.string().min(1),
  category: z.string().optional(),
  parent: z.string().optional(),
  targetCompany: z.string().optional(),
});

const createCostCentre: ToolHandler = async (raw, client) => {
  const args = costCentreSchema.parse(raw);
  const inner = [
    tag("NAME", args.name),
    args.category ? tag("CATEGORY", args.category) : "",
    args.parent ? tag("PARENT", args.parent) : "",
  ].filter(Boolean).join("");
  const xml = buildImportEnvelope({
    reportName: "All Masters",
    body: wrapMasters(`<COSTCENTRE Action="Create">${inner}</COSTCENTRE>`),
    staticVariables: { company: args.targetCompany ?? client.config.defaultCompany },
  });
  const body = await client.send(xml);
  return JSON.stringify(parseImportResult(body), null, 2);
};

/* -------------------------------------------------------------------------- */
/*  Tool descriptors                                                          */
/* -------------------------------------------------------------------------- */

export const masterTools: Tool[] = [
  {
    name: "tally_list_companies",
    description: "List all companies currently loaded/known to Tally Prime.",
    inputSchema: listCompaniesSchema,
    handler: listCompanies,
  },
  {
    name: "tally_list_masters",
    description:
      "List Tally master records of a given collection (Ledger, Group, StockItem, Unit, Godown, etc.). Returns CSV with name + parent.",
    inputSchema: listMastersSchema,
    handler: listMasters,
  },
  {
    name: "tally_get_ledger",
    description: "Fetch full master details for a single ledger by name (returns raw Tally XML).",
    inputSchema: getLedgerSchema,
    handler: getLedger,
  },
  {
    name: "tally_create_ledger",
    description:
      "Create or alter (set alter:true) a Ledger master. Parent group is required — common values: Sundry Debtors, Sundry Creditors, Bank Accounts, Cash-in-Hand, Sales Accounts, Purchase Accounts, Direct Expenses, Indirect Expenses, Duties & Taxes.",
    inputSchema: ledgerSchema,
    handler: createOrAlterLedger,
  },
  {
    name: "tally_create_group",
    description: "Create or alter (set alter:true) a Group master.",
    inputSchema: groupSchema,
    handler: createOrAlterGroup,
  },
  {
    name: "tally_create_stock_item",
    description: "Create or alter (set alter:true) a Stock Item master.",
    inputSchema: stockItemSchema,
    handler: createOrAlterStockItem,
  },
  {
    name: "tally_create_stock_group",
    description: "Create or alter a Stock Group master.",
    inputSchema: stockGroupSchema,
    handler: createStockGroup,
  },
  {
    name: "tally_create_unit",
    description:
      "Create a Unit of Measure (UOM). Set isSimpleUnit:false plus baseUnits/additionalUnits/conversion to create a compound unit.",
    inputSchema: unitSchema,
    handler: createUnit,
  },
  {
    name: "tally_create_godown",
    description: "Create a Godown (Location / Warehouse).",
    inputSchema: godownSchema,
    handler: createGodown,
  },
  {
    name: "tally_create_cost_centre",
    description: "Create a Cost Centre under an optional Cost Category.",
    inputSchema: costCentreSchema,
    handler: createCostCentre,
  },
];
