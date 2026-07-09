import { buildBdlIr } from "@disjukr/bdl/ir/builder";
import type * as bdl from "@disjukr/bdl/ir";
import {
  getResolveModuleFileFn,
  loadBdlConfig,
  type Paths,
} from "@disjukr/bdl/io/config";
import { relative, resolve, SEPARATOR } from "jsr:@std/path@1";

interface Schema {
  declarations: Declaration[];
}

type Declaration =
  | ProcDeclaration
  | StructDeclaration
  | EnumDeclaration
  | UnionDeclaration;

interface ProcDeclaration {
  kind: "proc";
  id: number;
  name: string;
  stream: string;
  requestType: TypeRef;
  responseType: TypeRef;
  errorType: TypeRef;
}

interface StructDeclaration {
  kind: "struct";
  name: string;
  typePath: string;
  fields: FieldDeclaration[];
}

interface EnumDeclaration {
  kind: "enum";
  name: string;
  typePath: string;
  variants: EnumVariantDeclaration[];
}

interface UnionDeclaration {
  kind: "union";
  name: string;
  typePath: string;
  variants: UnionVariantDeclaration[];
}

interface EnumVariantDeclaration {
  id: number;
  name: string;
}

interface UnionVariantDeclaration {
  id: number;
  name: string;
  fields: FieldDeclaration[];
}

interface FieldDeclaration {
  id: number;
  name: string;
  optional: boolean;
  type: TypeRef;
}

type TypeRef =
  | { kind: "primitive"; name: PrimitiveTypeName }
  | { kind: "named"; path: string }
  | { kind: "array"; item: TypeRef }
  | { kind: "void" };

type PrimitiveTypeName = "u53" | "i53" | "f64" | "string" | "bool" | "bytes";

type CodegenStandard = "wire" | "rpc";

interface CliOptions {
  cborImport: string;
  generatedImport: string;
  out?: string;
  rpcClientOut?: string;
  rpcRuntimeImport: string;
  schemaRoots: string[];
  standard?: CodegenStandard;
}

const primitiveTypes = new Set([
  "u53",
  "i53",
  "f64",
  "string",
  "bool",
  "bytes",
]);

function parseCli(args: string[]): CliOptions {
  const options: CliOptions = {
    cborImport: "./cbor.ts",
    generatedImport: "./generated.ts",
    rpcRuntimeImport: "./client.ts",
    schemaRoots: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out") {
      options.out = requiredArg(args, ++i, arg);
    } else if (arg === "--rpc-client-out") {
      options.rpcClientOut = requiredArg(args, ++i, arg);
    } else if (arg === "--cbor-import") {
      options.cborImport = requiredArg(args, ++i, arg);
    } else if (arg === "--generated-import") {
      options.generatedImport = requiredArg(args, ++i, arg);
    } else if (arg === "--rpc-runtime-import") {
      options.rpcRuntimeImport = requiredArg(args, ++i, arg);
    } else if (arg === "--schema") {
      options.schemaRoots.push(requiredArg(args, ++i, arg));
    } else if (arg === "--standard") {
      options.standard = parseStandard(requiredArg(args, ++i, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelpAndExit();
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}`);
    } else {
      options.schemaRoots.push(arg);
    }
  }

  if (options.schemaRoots.length === 0) {
    throw new Error("at least one --schema is required");
  }
  return options;
}

function parseStandard(value: string): CodegenStandard {
  if (value === "wire" || value === "rpc") return value;
  throw new Error(`unknown standard ${value}`);
}

function requiredArg(args: string[], index: number, option: string): string {
  const value = args[index];
  if (!value) throw new Error(`${option} requires a value`);
  return value;
}

function printHelpAndExit(): never {
  console.log(`Usage: deno run -A scripts/codegen/typescript/main.ts [options]

Options:
  --standard <wire|rpc> BDL standard to generate for. Inferred from schema when omitted.
  --schema <path>       BDL file or directory.
  --out <path>          Generated TypeScript output file. Defaults to stdout.
  --rpc-client-out <path>
                       Generated RPC client wrapper output file.
  --cbor-import <path>  Import specifier for CborValue/decodeCbor/encodeCbor.
  --generated-import <path>
                       Import specifier for generated codec module from rpc client output.
  --rpc-runtime-import <path>
                       Import specifier for RPC runtime module from rpc client output.
`);
  Deno.exit(0);
}

async function loadSchema(schemaRoots: string[]): Promise<Schema> {
  const { configDirectory, bdlConfig } = await loadBdlConfig();
  const files: string[] = [];
  for (const root of schemaRoots) {
    files.push(
      ...await collectBdlFiles(root, configDirectory, bdlConfig.paths),
    );
  }
  files.sort((a, b) => a.localeCompare(b));

  const { ir } = await buildBdlIr({
    entryModulePaths: files,
    resolveModuleFile: getResolveModuleFileFn(bdlConfig, configDirectory),
  });
  return schemaFromIr(ir);
}

async function collectBdlFiles(
  path: string,
  configDirectory: string,
  paths: Paths,
): Promise<string[]> {
  const resolvedPath = resolve(path);
  const stat = await Deno.stat(resolvedPath);
  if (stat.isFile) {
    return resolvedPath.endsWith(".bdl")
      ? [modulePathFromFile(resolvedPath, configDirectory, paths)]
      : [];
  }
  if (!stat.isDirectory) return [];

  const files: string[] = [];
  for await (const entry of Deno.readDir(resolvedPath)) {
    const child = resolve(resolvedPath, entry.name);
    if (entry.isDirectory) {
      files.push(...await collectBdlFiles(child, configDirectory, paths));
    } else if (entry.isFile && child.endsWith(".bdl")) {
      files.push(modulePathFromFile(child, configDirectory, paths));
    }
  }
  return files;
}

function modulePathFromFile(
  filePath: string,
  configDirectory: string,
  paths: Paths,
): string {
  const resolvedFilePath = resolve(filePath);
  for (const [packageName, directoryPath] of Object.entries(paths)) {
    const resolvedDirectoryPath = resolve(configDirectory, directoryPath);
    const relativePath = relative(resolvedDirectoryPath, resolvedFilePath);
    if (
      relativePath === "" ||
      relativePath.startsWith("..") ||
      relativePath.includes(":")
    ) continue;
    const fragments = relativePath.replace(/\.bdl$/, "").split(SEPARATOR);
    return [packageName, ...fragments].join(".");
  }
  throw new Error(`BDL file is outside configured paths: ${filePath}`);
}

function schemaFromIr(ir: bdl.BdlIr): Schema {
  const declarations: Declaration[] = [];
  const typePaths = new Map<string, string>();

  for (const [typePath, def] of Object.entries(ir.defs)) {
    if (def.type === "Proc") continue;
    if (typePaths.has(def.name)) {
      throw new Error(`duplicate TypeScript declaration name ${def.name}`);
    }
    typePaths.set(def.name, typePath);
  }

  for (const [typePath, def] of Object.entries(ir.defs)) {
    if (def.type === "Proc") {
      declarations.push({
        kind: "proc",
        id: requiredId(def, typePath),
        name: def.name,
        stream: requiredAttribute(def, "stream", typePath),
        requestType: typeRefFromIr(def.inputType),
        responseType: typeRefFromIr(def.outputType),
        errorType: typeRefFromIr(def.errorType ?? plainType("void")),
      });
    } else if (def.type === "Struct") {
      declarations.push({
        kind: "struct",
        name: def.name,
        typePath,
        fields: def.fields.map((field) =>
          fieldFromIr(field, `${typePath}.${field.name}`)
        ),
      });
    } else if (def.type === "Enum") {
      declarations.push({
        kind: "enum",
        name: def.name,
        typePath,
        variants: def.items.map((item) => ({
          id: requiredId(item, `${typePath}.${item.name}`),
          name: item.name,
        })),
      });
    } else if (def.type === "Union") {
      declarations.push({
        kind: "union",
        name: def.name,
        typePath,
        variants: def.items.map((item) => ({
          id: requiredId(item, `${typePath}.${item.name}`),
          name: item.name,
          fields: item.fields.map((field) =>
            fieldFromIr(field, `${typePath}.${item.name}.${field.name}`)
          ),
        })),
      });
    }
  }

  validateSchema({ declarations });
  return { declarations };
}

function fieldFromIr(field: bdl.StructField, label: string): FieldDeclaration {
  return {
    id: requiredId(field, label),
    name: field.name,
    optional: field.optional,
    type: typeRefFromIr(field.fieldType),
  };
}

function typeRefFromIr(type: bdl.Type): TypeRef {
  if (type.type === "Array") {
    return {
      kind: "array",
      item: typeRefFromIr(plainType(type.valueTypePath)),
    };
  }
  if (type.type === "Dictionary") {
    throw new Error(
      "TypeScript codegen does not support dictionary fields yet",
    );
  }
  if (type.valueTypePath === "void") return { kind: "void" };
  if (primitiveTypes.has(type.valueTypePath)) {
    return { kind: "primitive", name: type.valueTypePath as PrimitiveTypeName };
  }
  return { kind: "named", path: type.valueTypePath };
}

function plainType(valueTypePath: string): bdl.Plain {
  return { type: "Plain", valueTypePath };
}

function validateSchema(schema: Schema) {
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const declaration of schema.declarations) {
    if (declaration.kind === "proc") continue;
    if (names.has(declaration.name)) {
      throw new Error(`duplicate declaration ${declaration.name}`);
    }
    names.add(declaration.name);
    paths.add(declaration.typePath);
  }
  for (const declaration of schema.declarations) {
    if (declaration.kind === "proc") {
      validateTypeRef(paths, declaration.requestType);
      validateTypeRef(paths, declaration.responseType);
      validateTypeRef(paths, declaration.errorType);
    } else if (declaration.kind === "struct") {
      validateUniqueIds(`${declaration.name} fields`, declaration.fields);
      for (const field of declaration.fields) {
        validateTypeRef(paths, field.type);
      }
    } else if (declaration.kind === "enum") {
      validateUniqueIds(`${declaration.name} variants`, declaration.variants);
    } else {
      validateUniqueIds(`${declaration.name} variants`, declaration.variants);
      for (const variant of declaration.variants) {
        validateUniqueIds(
          `${declaration.name}.${variant.name} fields`,
          variant.fields,
        );
        for (const field of variant.fields) validateTypeRef(paths, field.type);
      }
    }
  }
}

function validateTypeRef(paths: Set<string>, type: TypeRef) {
  if (type.kind === "array") validateTypeRef(paths, type.item);
  if (type.kind === "named" && !paths.has(type.path)) {
    throw new Error(`unknown type ${type.path}`);
  }
}

function validateUniqueIds(
  label: string,
  items: Array<{ id: number; name: string }>,
) {
  const ids = new Set<number>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new Error(`duplicate id ${item.id} in ${label}`);
    }
    ids.add(item.id);
  }
}

function emitWireTypeScript(schema: Schema, options: CliOptions): string {
  const procs = sortedProcs(schema);
  if (procs.length > 0) {
    throw new Error(
      "wire TypeScript codegen does not accept proc declarations",
    );
  }
  return emitSchemaCodecTypeScript(schema, options, false);
}

function emitRpcTypeScript(schema: Schema, options: CliOptions): string {
  const procs = sortedProcs(schema);
  if (procs.length === 0) {
    throw new Error("rpc TypeScript codegen requires proc declarations");
  }
  return emitSchemaCodecTypeScript(schema, options, true);
}

function emitSchemaCodecTypeScript(
  schema: Schema,
  options: CliOptions,
  emitProcs: boolean,
): string {
  const out = new Writer();
  const named = declarationMap(schema);

  out.line("// Generated by scripts/codegen/typescript/main.ts");
  out.line("// Do not edit by hand.");
  out.line(`import { cborF64, type CborValue } from "${options.cborImport}";`);
  out.line();

  if (emitProcs) {
    emitProcIds(out, schema);
  }
  for (const declaration of schema.declarations) {
    if (declaration.kind === "proc") continue;
    out.line();
    emitTypeDeclaration(out, declaration);
  }

  if (emitProcs) {
    emitProcCodecs(out, schema, named);
  }

  for (const declaration of schema.declarations) {
    if (declaration.kind === "proc") continue;
    out.line();
    emitCodec(out, declaration, named);
  }

  emitDefaultFunctions(out, schema, named);
  emitRuntimeHelpers(out);
  return out.toString();
}

function emitRpcClientTypeScript(schema: Schema, options: CliOptions): string {
  const out = new Writer();
  const named = declarationMap(schema);
  const procs = sortedProcs(schema);

  out.line("// Generated by scripts/codegen/typescript/main.ts");
  out.line("// Do not edit by hand.");
  out.line("import {");
  out.indent(() => {
    out.line("callClientStream,");
    out.line("callServerStream,");
    out.line("callUnary,");
    out.line("type RpcClientStream,");
  });
  out.line(`} from "${options.rpcRuntimeImport}";`);
  out.line("import {");
  out.indent(() => {
    for (const proc of procs) out.line(`${procCodecName(proc)},`);
  });
  out.line(`} from "${options.generatedImport}";`);

  const typeNames = new Set<string>();
  for (const proc of procs) {
    collectTypeImport(typeNames, proc.requestType, named);
    collectTypeImport(typeNames, proc.responseType, named);
  }
  if (typeNames.size > 0) {
    out.line("import type {");
    out.indent(() => {
      for (const name of [...typeNames].sort((a, b) => a.localeCompare(b))) {
        out.line(`${name},`);
      }
    });
    out.line(`} from "${options.generatedImport}";`);
  }

  for (const proc of procs) {
    out.line();
    emitProcClientWrapper(out, proc);
  }
  return out.toString();
}

function collectTypeImport(
  typeNames: Set<string>,
  type: TypeRef,
  named: Map<string, Declaration>,
) {
  if (type.kind === "void" || type.kind === "primitive") return;
  if (type.kind === "array") {
    collectTypeImport(typeNames, type.item, named);
    return;
  }
  typeNames.add(getNamed(type, named).name);
}

function declarationMap(schema: Schema): Map<string, Declaration> {
  const map = new Map<string, Declaration>();
  for (const declaration of schema.declarations) {
    if (declaration.kind !== "proc") map.set(declaration.typePath, declaration);
  }
  return map;
}

function emitProcIds(out: Writer, schema: Schema) {
  out.line("export enum ProcId {");
  out.indent(() => {
    for (const proc of sortedProcs(schema)) {
      out.line(`${proc.name} = ${proc.id},`);
    }
  });
  out.line("}");
}

function emitProcCodecs(
  out: Writer,
  schema: Schema,
  named: Map<string, Declaration>,
) {
  const procs = sortedProcs(schema);
  if (procs.length === 0) return;

  out.line();
  out.line("export interface ProcCodec<Request, Response, ErrorPayload> {");
  out.indent(() => {
    out.line("id: ProcId;");
    out.line("name: string;");
    out.line("stream: string;");
    out.line("requestType: string;");
    out.line("responseType: string;");
    out.line("errorType: string;");
    out.line("encodeRequest(value: Request): CborValue;");
    out.line("decodeResponse(value: CborValue): Response;");
    out.line("decodeError(value: CborValue): ErrorPayload;");
  });
  out.line("}");

  for (const proc of procs) {
    out.line();
    out.line(
      `export const ${procCodecName(proc)}: ProcCodec<${
        tsType(proc.requestType)
      }, ${tsType(proc.responseType)}, ${tsType(proc.errorType)}> = {`,
    );
    out.indent(() => {
      out.line(`id: ProcId.${proc.name},`);
      out.line(`name: "${proc.name}",`);
      out.line(`stream: "${proc.stream}",`);
      out.line(`requestType: "${typeName(proc.requestType, named)}",`);
      out.line(`responseType: "${typeName(proc.responseType, named)}",`);
      out.line(`errorType: "${typeName(proc.errorType, named)}",`);
      out.line(
        `encodeRequest: ${
          procCodecFunction("encode", proc.requestType, named)
        },`,
      );
      out.line(
        `decodeResponse: ${
          procCodecFunction("decode", proc.responseType, named)
        },`,
      );
      out.line(
        `decodeError: ${procCodecFunction("decode", proc.errorType, named)},`,
      );
    });
    out.line("};");
  }

  out.line();
  out.line("export const procs = {");
  out.indent(() => {
    for (const proc of procs) {
      out.line(`[ProcId.${proc.name}]: ${procCodecName(proc)},`);
    }
  });
  out.line("} as const;");
}

function emitProcClientWrapper(out: Writer, proc: ProcDeclaration) {
  const requestType = tsType(proc.requestType);
  const responseType = tsType(proc.responseType);
  const name = lowerCamel(proc.name);
  const codec = procCodecName(proc);
  const requestIsVoid = proc.requestType.kind === "void";

  if (proc.stream === "unary") {
    const params = requestIsVoid
      ? "transport: WebTransport"
      : `transport: WebTransport, request: ${requestType}`;
    const requestExpr = requestIsVoid ? "undefined" : "request";
    out.line(
      `export function ${name}(${params}): Promise<${responseType}> {`,
    );
    out.indent(() =>
      out.line(`return callUnary(transport, ${codec}, ${requestExpr});`)
    );
    out.line("}");
    return;
  }

  if (proc.stream === "server") {
    const params = requestIsVoid
      ? "transport: WebTransport"
      : `transport: WebTransport, request: ${requestType}`;
    const requestExpr = requestIsVoid ? "undefined" : "request";
    out.line(
      `export function ${name}(${params}): AsyncGenerator<${responseType}> {`,
    );
    out.indent(() =>
      out.line(`return callServerStream(transport, ${codec}, ${requestExpr});`)
    );
    out.line("}");
    return;
  }

  if (proc.stream === "client") {
    out.line(
      `export function ${name}(transport: WebTransport, requests: RpcClientStream<${requestType}>): Promise<${responseType}> {`,
    );
    out.indent(() =>
      out.line(`return callClientStream(transport, ${codec}, requests);`)
    );
    out.line("}");
    return;
  }

  throw new Error(`unsupported proc stream mode ${proc.stream}`);
}

function procCodecName(proc: ProcDeclaration): string {
  return `${lowerCamel(proc.name)}Proc`;
}

function procCodecFunction(
  direction: "encode" | "decode",
  type: TypeRef,
  named: Map<string, Declaration>,
): string {
  if (type.kind === "void") {
    return direction === "encode" ? "encodeVoidValue" : "decodeVoidValue";
  }
  if (type.kind === "primitive" || type.kind === "array") {
    return direction === "encode"
      ? `(value) => ${encodeExpr("value", type, named)}`
      : `(value) => ${decodeExpr("value", type, named)}`;
  }
  const declaration = getNamed(type, named);
  return `${direction}${declaration.name}Value`;
}

function sortedProcs(schema: Schema): ProcDeclaration[] {
  return schema.declarations.filter(isProc).sort((a, b) => a.id - b.id);
}

function emitTypeDeclaration(out: Writer, declaration: Declaration) {
  if (declaration.kind === "struct") {
    out.line(`export interface ${declaration.name} {`);
    out.indent(() => {
      for (const field of declaration.fields) {
        out.line(
          `${field.name}${field.optional ? "?" : ""}: ${tsType(field.type)};`,
        );
      }
    });
    out.line("}");
  } else if (declaration.kind === "enum") {
    out.line(`export enum ${declaration.name} {`);
    out.indent(() => {
      for (const variant of declaration.variants) {
        out.line(`${variant.name} = ${variant.id},`);
      }
    });
    out.line("}");
  } else if (declaration.kind === "union") {
    out.line(`export type ${declaration.name} =`);
    out.indent(() => {
      for (const variant of declaration.variants) {
        const fields = [
          `type: "${lowerCamel(variant.name)}"`,
          ...variant.fields.map((field) =>
            `${field.name}${field.optional ? "?" : ""}: ${tsType(field.type)}`
          ),
        ];
        out.line(`| { ${fields.join("; ")} }`);
      }
    });
    out.line(";");
  }
}

function emitCodec(
  out: Writer,
  declaration: Declaration,
  named: Map<string, Declaration>,
) {
  if (declaration.kind === "struct") emitStructCodec(out, declaration, named);
  else if (declaration.kind === "enum") emitEnumCodec(out, declaration);
  else if (declaration.kind === "union") {
    emitUnionCodec(out, declaration, named);
  }
}

function emitStructCodec(
  out: Writer,
  declaration: StructDeclaration,
  named: Map<string, Declaration>,
) {
  out.line(
    `export function encode${declaration.name}Value(value: ${declaration.name}): CborValue {`,
  );
  out.indent(() => {
    out.line("const fields = new Map<number, CborValue>();");
    for (const field of declaration.fields) {
      emitEncodeField(
        out,
        field,
        `value.${field.name}`,
        `${declaration.name}.${field.name}`,
        named,
      );
    }
    out.line("return fields;");
  });
  out.line("}");
  out.line();
  out.line(
    `export function decode${declaration.name}Value(value: CborValue): ${declaration.name} {`,
  );
  out.indent(() => {
    out.line("const fields = expectMap(value);");
    out.line("return {");
    out.indent(() => {
      for (const field of declaration.fields) {
        out.line(`${field.name}: ${decodeFieldExpr(field, named)},`);
      }
    });
    out.line("};");
  });
  out.line("}");
}

function emitEnumCodec(out: Writer, declaration: EnumDeclaration) {
  const allowed = declaration.variants.map((variant) => variant.id).join(", ");
  out.line(
    `export function encode${declaration.name}Value(value: ${declaration.name}): CborValue {`,
  );
  out.indent(() => out.line("return integer(value);"));
  out.line("}");
  out.line();
  out.line(
    `export function decode${declaration.name}Value(value: CborValue): ${declaration.name} {`,
  );
  out.indent(() => {
    out.line("const id = integer(value);");
    out.line(
      `if (![${allowed}].includes(id)) throw new Error(\`unknown ${declaration.name} variant \${id}\`);`,
    );
    out.line(`return id as ${declaration.name};`);
  });
  out.line("}");
}

function emitUnionCodec(
  out: Writer,
  declaration: UnionDeclaration,
  named: Map<string, Declaration>,
) {
  out.line(
    `export function encode${declaration.name}Value(value: ${declaration.name}): CborValue {`,
  );
  out.indent(() => {
    out.line("switch (value.type) {");
    out.indent(() => {
      for (const variant of declaration.variants) {
        out.line(`case "${lowerCamel(variant.name)}": {`);
        out.indent(() => {
          out.line("const fields = new Map<number, CborValue>();");
          for (const field of variant.fields) {
            emitEncodeField(
              out,
              field,
              `value.${field.name}`,
              `${declaration.name}.${variant.name}.${field.name}`,
              named,
            );
          }
          out.line(`return [${variant.id}, fields];`);
        });
        out.line("}");
      }
    });
    out.line("}");
  });
  out.line("}");
  out.line();
  out.line(
    `export function decode${declaration.name}Value(value: CborValue): ${declaration.name} {`,
  );
  out.indent(() => {
    out.line("const [variantId, fields] = expectUnion(value);");
    out.line("switch (variantId) {");
    out.indent(() => {
      for (const variant of declaration.variants) {
        out.line(`case ${variant.id}:`);
        out.indent(() => {
          out.line("return {");
          out.indent(() => {
            out.line(`type: "${lowerCamel(variant.name)}",`);
            for (const field of variant.fields) {
              out.line(`${field.name}: ${decodeFieldExpr(field, named)},`);
            }
          });
          out.line("};");
        });
      }
    });
    out.line("}");
    out.line(
      `throw new Error(\`unknown ${declaration.name} variant \${variantId}\`);`,
    );
  });
  out.line("}");
}

function emitEncodeField(
  out: Writer,
  field: FieldDeclaration,
  valueExpr: string,
  label: string,
  named: Map<string, Declaration>,
) {
  if (field.optional) {
    out.line(
      `if (${valueExpr} !== undefined) fields.set(${field.id}, ${
        encodeExpr(valueExpr, field.type, named)
      });`,
    );
  } else {
    out.line(
      `fields.set(${field.id}, ${
        encodeExpr(`required(${valueExpr}, "${label}")`, field.type, named)
      });`,
    );
  }
}

function decodeFieldExpr(
  field: FieldDeclaration,
  named: Map<string, Declaration>,
): string {
  const access = `fields.get(${field.id})`;
  if (field.optional) {
    return `optionalField(${access}, (value) => ${
      decodeExpr("value", field.type, named)
    })`;
  }
  return `fieldOrDefault(${access}, (value) => ${
    decodeExpr("value", field.type, named)
  }, () => ${defaultExpr(field.type, named)})`;
}

function emitDefaultFunctions(
  out: Writer,
  schema: Schema,
  named: Map<string, Declaration>,
) {
  for (const declaration of schema.declarations) {
    if (declaration.kind === "struct") {
      out.line();
      out.line(`function default${declaration.name}(): ${declaration.name} {`);
      out.indent(() => {
        out.line("return {");
        out.indent(() => {
          for (const field of declaration.fields) {
            if (!field.optional) {
              out.line(`${field.name}: ${defaultExpr(field.type, named)},`);
            }
          }
        });
        out.line("};");
      });
      out.line("}");
    } else if (declaration.kind === "union") {
      const variant = declaration.variants[0];
      out.line();
      out.line(`function default${declaration.name}(): ${declaration.name} {`);
      out.indent(() => {
        out.line("return {");
        out.indent(() => {
          out.line(`type: "${lowerCamel(variant.name)}",`);
          for (const field of variant.fields) {
            if (!field.optional) {
              out.line(`${field.name}: ${defaultExpr(field.type, named)},`);
            }
          }
        });
        out.line("};");
      });
      out.line("}");
    }
  }
}

function encodeExpr(
  valueExpr: string,
  type: TypeRef,
  named: Map<string, Declaration>,
): string {
  if (type.kind === "void") return "null";
  if (type.kind === "array") {
    return `${valueExpr}.map((item) => ${
      encodeExpr("item", type.item, named)
    })`;
  }
  if (type.kind === "primitive") {
    if (type.name === "u53") return `u53(${valueExpr})`;
    if (type.name === "i53") return `i53(${valueExpr})`;
    if (type.name === "f64") return `f64(${valueExpr})`;
    if (type.name === "string") return `text(${valueExpr})`;
    if (type.name === "bool") return `bool(${valueExpr})`;
    if (type.name === "bytes") return `bytes(${valueExpr})`;
  }
  const declaration = getNamed(type, named);
  return `encode${declaration.name}Value(${valueExpr})`;
}

function decodeExpr(
  valueExpr: string,
  type: TypeRef,
  named: Map<string, Declaration>,
): string {
  if (type.kind === "void") return "undefined";
  if (type.kind === "array") {
    return `array(${valueExpr}).map((item) => ${
      decodeExpr("item", type.item, named)
    })`;
  }
  if (type.kind === "primitive") {
    if (type.name === "u53" || type.name === "i53") {
      return `integer(${valueExpr})`;
    }
    if (type.name === "f64") return `f64Value(${valueExpr})`;
    if (type.name === "string") return `textValue(${valueExpr})`;
    if (type.name === "bool") return `boolValue(${valueExpr})`;
    if (type.name === "bytes") return `bytesValue(${valueExpr})`;
  }
  const declaration = getNamed(type, named);
  return `decode${declaration.name}Value(${valueExpr})`;
}

function defaultExpr(type: TypeRef, named: Map<string, Declaration>): string {
  if (type.kind === "void") return "undefined";
  if (type.kind === "array") return "[]";
  if (type.kind === "primitive") {
    if (type.name === "string") return `""`;
    if (type.name === "bool") return "false";
    if (type.name === "bytes") return "new Uint8Array()";
    return "0";
  }
  const declaration = getNamed(type, named);
  if (declaration.kind === "enum") {
    return `${declaration.name}.${declaration.variants[0].name}`;
  }
  return `default${declaration.name}()`;
}

function getNamed(
  type: TypeRef,
  named: Map<string, Declaration>,
): Exclude<Declaration, ProcDeclaration> {
  if (type.kind !== "named") throw new Error("expected named type");
  const declaration = named.get(type.path);
  if (!declaration || declaration.kind === "proc") {
    throw new Error(`unknown type ${type.path}`);
  }
  return declaration;
}

function emitRuntimeHelpers(out: Writer) {
  out.line();
  out.line("function encodeVoidValue(_value: undefined): CborValue {");
  out.indent(() => {
    out.line("return null;");
  });
  out.line("}");
  out.line();
  out.line("function decodeVoidValue(_value: CborValue): undefined {");
  out.indent(() => {
    out.line("return undefined;");
  });
  out.line("}");
  out.line();
  out.line("function expectMap(value: CborValue): Map<number, CborValue> {");
  out.indent(() => {
    out.line(
      'if (!(value instanceof Map)) throw new Error("expected CBOR map");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line(
    "function expectUnion(value: CborValue): [number, Map<number, CborValue>] {",
  );
  out.indent(() => {
    out.line(
      'if (!Array.isArray(value) || value.length !== 2) throw new Error("expected CBOR union tuple");',
    );
    out.line("return [integer(value[0]), expectMap(value[1])];");
  });
  out.line("}");
  out.line();
  out.line("function array(value: CborValue): CborValue[] {");
  out.indent(() => {
    out.line(
      'if (!Array.isArray(value)) throw new Error("expected CBOR array");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function integer(value: CborValue): number {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error("expected CBOR integer");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function f64Value(value: CborValue): number {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "object" || value === null || !("type" in value) || value.type !== "f64") throw new Error("expected CBOR f64");',
    );
    out.line("return value.value;");
  });
  out.line("}");
  out.line();
  out.line("function textValue(value: CborValue): string {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "string") throw new Error("expected CBOR text");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function boolValue(value: CborValue): boolean {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "boolean") throw new Error("expected CBOR bool");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function bytesValue(value: CborValue): Uint8Array {");
  out.indent(() => {
    out.line(
      'if (!(value instanceof Uint8Array)) throw new Error("expected CBOR bytes");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line(
    "function optionalField<T>(value: CborValue | undefined, decode: (value: CborValue) => T): T | undefined {",
  );
  out.indent(() =>
    out.line("return value === undefined ? undefined : decode(value);")
  );
  out.line("}");
  out.line();
  out.line(
    "function fieldOrDefault<T>(value: CborValue | undefined, decode: (value: CborValue) => T, fallback: () => T): T {",
  );
  out.indent(() =>
    out.line("return value === undefined ? fallback() : decode(value);")
  );
  out.line("}");
  out.line();
  out.line("function required<T>(value: T | undefined, label: string): T {");
  out.indent(() => {
    out.line(
      "if (value === undefined) throw new Error(`missing required field ${label}`);",
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function u53(value: number): CborValue {");
  out.indent(() => {
    out.line(
      'if (!Number.isSafeInteger(value) || value < 0) throw new Error("expected u53");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function i53(value: number): CborValue {");
  out.indent(() => {
    out.line(
      'if (!Number.isSafeInteger(value)) throw new Error("expected i53");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function f64(value: number): CborValue {");
  out.indent(() => {
    out.line("return cborF64(value);");
  });
  out.line("}");
  out.line();
  out.line("function text(value: string): CborValue {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "string") throw new Error("expected string");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function bool(value: boolean): CborValue {");
  out.indent(() => {
    out.line(
      'if (typeof value !== "boolean") throw new Error("expected boolean");',
    );
    out.line("return value;");
  });
  out.line("}");
  out.line();
  out.line("function bytes(value: Uint8Array): CborValue {");
  out.indent(() => {
    out.line(
      'if (!(value instanceof Uint8Array)) throw new Error("expected Uint8Array");',
    );
    out.line("return value;");
  });
  out.line("}");
}

function tsType(type: TypeRef): string {
  if (type.kind === "void") return "undefined";
  if (type.kind === "array") return `${tsType(type.item)}[]`;
  if (type.kind === "primitive") {
    if (type.name === "string") return "string";
    if (type.name === "bool") return "boolean";
    if (type.name === "bytes") return "Uint8Array";
    return "number";
  }
  return localTypeName(type.path);
}

function typeName(type: TypeRef, named: Map<string, Declaration>): string {
  if (type.kind === "void") return "void";
  if (type.kind === "array") return `${typeName(type.item, named)}[]`;
  if (type.kind === "named") return getNamed(type, named).name;
  return type.name;
}

function localTypeName(typePath: string): string {
  const index = typePath.lastIndexOf(".");
  return index < 0 ? typePath : typePath.slice(index + 1);
}

function isProc(declaration: Declaration): declaration is ProcDeclaration {
  return declaration.kind === "proc";
}

function lowerCamel(name: string): string {
  return name.slice(0, 1).toLowerCase() + name.slice(1);
}

function inferStandard(schema: Schema): CodegenStandard {
  return sortedProcs(schema).length > 0 ? "rpc" : "wire";
}

function requiredId(
  item: { attributes: Record<string, string>; name: string },
  label: string,
): number {
  const id = Number(requiredAttribute(item, "id", label));
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new Error(`${label} requires integer @ id`);
  }
  return id;
}

function requiredAttribute(
  item: { attributes: Record<string, string>; name: string },
  name: string,
  label: string,
): string {
  const value = item.attributes[name];
  const normalized = value?.trim();
  if (normalized === undefined || normalized === "") {
    throw new Error(`${label} requires @ ${name}`);
  }
  return normalized;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function toFileUrl(path: string): string {
  return new URL(normalizePath(path), `file:///${normalizePath(Deno.cwd())}/`)
    .href;
}

function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "." : normalized.slice(0, index);
}

class Writer {
  #indent = "";
  #lines: string[] = [];

  line(text = "") {
    this.#lines.push(text.length === 0 ? "" : `${this.#indent}${text}`);
  }

  indent(write: () => void) {
    const previous = this.#indent;
    this.#indent += "  ";
    write();
    this.#indent = previous;
  }

  toString(): string {
    return `${this.#lines.join("\n")}\n`;
  }
}

if (import.meta.main) {
  const options = parseCli(Deno.args);
  const schema = await loadSchema(options.schemaRoots);
  const standard = options.standard ?? inferStandard(schema);
  const code = standard === "wire"
    ? emitWireTypeScript(schema, options)
    : emitRpcTypeScript(schema, options);
  if (options.out) {
    await Deno.mkdir(dirname(options.out), { recursive: true });
    await Deno.writeTextFile(options.out, code);
  } else {
    console.log(code);
  }
  if (options.rpcClientOut) {
    if (standard !== "rpc") {
      throw new Error("--rpc-client-out is only valid with --standard rpc");
    }
    const rpcClientCode = emitRpcClientTypeScript(schema, options);
    await Deno.mkdir(dirname(options.rpcClientOut), { recursive: true });
    await Deno.writeTextFile(options.rpcClientOut, rpcClientCode);
  }
}
