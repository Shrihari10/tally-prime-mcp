// Minimal Zod → JSON Schema converter, just enough for what we need for MCP.
//
// We avoid the extra dependency on `zod-to-json-schema` (which pulls in a fair
// chunk of code) by handling the subset of Zod constructs the tools actually
// use: objects, strings, numbers, booleans, arrays, enums, optionals, defaults,
// descriptions, and unions of literals (used by enum-like fields).

import { z, ZodTypeAny } from "zod";

type JsonSchema = Record<string, any>;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: ZodTypeAny): JsonSchema {
  const def: any = (schema as any)._def;
  const description: string | undefined = (schema as any).description ?? def?.description;

  let result: JsonSchema;

  switch (def.typeName) {
    case "ZodString":
      result = { type: "string" };
      for (const check of def.checks ?? []) {
        if (check.kind === "min") result.minLength = check.value;
        if (check.kind === "max") result.maxLength = check.value;
        if (check.kind === "regex") result.pattern = check.regex.source;
      }
      break;

    case "ZodNumber":
      result = { type: "number" };
      for (const check of def.checks ?? []) {
        if (check.kind === "int") result.type = "integer";
        if (check.kind === "min") result.minimum = check.value;
        if (check.kind === "max") result.maximum = check.value;
      }
      break;

    case "ZodBoolean":
      result = { type: "boolean" };
      break;

    case "ZodEnum":
      result = { type: "string", enum: def.values };
      break;

    case "ZodNativeEnum":
      result = { type: "string", enum: Object.values(def.values).filter((v) => typeof v === "string") };
      break;

    case "ZodLiteral":
      result = {
        type: typeof def.value === "number" ? "number" : typeof def.value === "boolean" ? "boolean" : "string",
        enum: [def.value],
      };
      break;

    case "ZodArray":
      result = { type: "array", items: convert(def.type) };
      break;

    case "ZodObject": {
      const shape = (schema as z.ZodObject<any>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const inner = value as ZodTypeAny;
        properties[key] = convert(inner);
        const innerDef: any = (inner as any)._def;
        const isOptional =
          innerDef.typeName === "ZodOptional" ||
          innerDef.typeName === "ZodDefault" ||
          innerDef.typeName === "ZodNullable";
        if (!isOptional) required.push(key);
      }
      result = {
        type: "object",
        properties,
        ...(required.length ? { required } : {}),
        additionalProperties: false,
      };
      break;
    }

    case "ZodOptional":
    case "ZodNullable":
      result = convert(def.innerType);
      break;

    case "ZodDefault": {
      result = convert(def.innerType);
      result.default = typeof def.defaultValue === "function" ? def.defaultValue() : def.defaultValue;
      break;
    }

    case "ZodUnion": {
      const options = def.options.map(convert);
      // If all options are literal strings, fold into a single enum.
      if (options.every((o: any) => o.enum && o.enum.length === 1 && o.type === "string")) {
        result = { type: "string", enum: options.flatMap((o: any) => o.enum) };
      } else {
        result = { anyOf: options };
      }
      break;
    }

    case "ZodRecord":
      result = { type: "object", additionalProperties: convert(def.valueType) };
      break;

    case "ZodAny":
    case "ZodUnknown":
      result = {};
      break;

    default:
      result = {};
  }

  if (description) result.description = description;
  return result;
}
