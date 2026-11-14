import * as path from 'path';
import * as fs from 'fs';
import {
    workspace,
    ExtensionContext,
    window,
    languages,
    DocumentSymbolProvider,
    HoverProvider,
    CompletionItemProvider,
    DefinitionProvider,
    TextDocument,
    Position,
    DocumentSymbol,
    SymbolKind,
    Range,
    Hover,
    MarkdownString,
    CompletionItem,
    CompletionItemKind,
    Location,
    Uri,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticCollection,
    DocumentLink,
    DocumentLinkProvider,
    DocumentSemanticTokensProvider,
    SemanticTokens,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    debug,
    DebugConfiguration,
    DebugConfigurationProvider,
    WorkspaceFolder,
    CancellationToken,
    ProviderResult,
    Terminal,
    commands,
    QuickPickItem
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
    CloseAction,
    ErrorAction
} from 'vscode-languageclient/node';
import { provideDocumentFormattingEdits, provideDocumentRangeFormattingEdits } from './formatter';

let client: LanguageClient | undefined;
let extensionContext: ExtensionContext | undefined;
let fallbackProvidersRegistered = false;

function findServerBinary(context: ExtensionContext): string | undefined {
    const config = workspace.getConfiguration('stride');
    const configuredPath = config.get<string>('server.path');

    if (configuredPath && fs.existsSync(configuredPath)) {
        return configuredPath;
    }

    const candidatePaths = [
        context.asAbsolutePath(path.join('server', 'bin', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'bin', 'Debug', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'bin', 'Release', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'build', 'Debug', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'build', 'Release', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'build', 'stride-lsp.exe')),
        context.asAbsolutePath(path.join('server', 'bin', 'stride-lsp')),
        'stride-lsp.exe',
        'stride-lsp'
    ];

    for (const candidate of candidatePaths) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

// ============================================================================
// Stride Type & Schema Definitions
// ============================================================================

interface PropertyInfo {
    name: string;
    types?: string[];
    required?: boolean;
    public?: boolean;
    writeable?: boolean;
    defaultValue?: string;
    meta?: string;
    filePath?: string;
    line?: number;
}

interface TypeInfo {
    name: string;
    typeName?: string;
    filePath?: string;
    line?: number;
    inherits: string[];
    properties: PropertyInfo[];
    meta?: string;
    isBuiltin?: boolean;
}

interface PortInfo {
    portType: string;
    portName: string;
    boundBlock?: string;
    nameField?: string;
    meta?: string;
    types?: string;
    defaultVal?: string;
    line?: number;
}

interface LibrarySymbol {
    name: string;
    kind: string;
    filePath: string;
    line: number;
    signature: string;
    ports?: PortInfo[];
    meta?: string;
    inherits?: string[];
    inputs?: string[];
    outputs?: string[];
    processing?: string;
    targetBlock?: string;
    arraySpec?: string;
    generatorVar?: string;
    generatorRange?: string;
}

const TYPE_ALIASES: Record<string, string> = {
    '_domainDeclaration': '_DomainDefinition',
    'domainDeclaration': '_DomainDefinition',
    '_domainDefinition': '_DomainDefinition',
    'domainDefinition': '_DomainDefinition',
    '_DomainDeclaration': '_DomainDefinition',
    '_DomainDefinition': '_DomainDefinition',
    'domain': '_DomainDefinition',
    '_domain': '_DomainDefinition',
    'module': '_Module',
    '_Module': '_Module',
    'reaction': '_Reaction',
    '_Reaction': '_Reaction',
    'loop': '_Loop',
    '_Loop': '_Loop',
    'constant': '_Constant',
    '_Constant': '_Constant',
    'state': '_StateType',
    '_StateType': '_StateType',
    'transition': '_TransitionType',
    '_TransitionType': '_TransitionType',
    'signal': '_Signal',
    '_Signal': '_Signal',
    'switch': '_Switch',
    '_Switch': '_Switch',
    'trigger': '_Trigger',
    '_Trigger': '_Trigger',
    'mainInputPort': '_MainInputPort',
    '_MainInputPort': '_MainInputPort',
    'mainOutputPort': '_MainOutputPort',
    '_MainOutputPort': '_MainOutputPort',
    'propertyInputPort': '_PropertyInputPort',
    '_PropertyInputPort': '_PropertyInputPort',
    'propertyOutputPort': '_PropertyOutputPort',
    '_PropertyOutputPort': '_PropertyOutputPort',
    'port': '_Port',
    '_Port': '_Port',
    'alias': '_Alias',
    '_Alias': '_Alias',
    'codeGenerator': '_CodeGenerator',
    '_CodeGenerator': '_CodeGenerator',
    'callable': '_Callable',
    '_Callable': '_Callable',
    'base': '_Base',
    '_Base': '_Base',
    'platformModule': '_PlatformModuleType',
    '_PlatformModuleType': '_PlatformModuleType',
    'platformFunction': '_PlatformFunctionType',
    '_PlatformFunctionType': '_PlatformFunctionType',
    'gameDefinition': '_GameDefinitionType',
    '_GameDefinitionType': '_GameDefinitionType',
    'action': '_ActionType',
    '_ActionType': '_ActionType',
    'frameworkDataType': '_FrameworkDataType',
    '_frameworkDataType': '_FrameworkDataType',
    'typeClass': '_TypeClass',
    '_typeClass': '_TypeClass',
    'frameworkTypeClass': '_FrameworkTypeClass',
    '_frameworkTypeClass': '_FrameworkTypeClass'
};

const BUILTIN_SCALARS: Record<string, string> = {
    // Framework-sized data types and aliases
    'Int': '**Data Type Alias**: `Int` — *Signed integer of the size preferred by the framework (default `Int32`).*',
    'UInt': '**Data Type Alias**: `UInt` — *Unsigned integer of the size preferred by the framework (default `UInt32`).*',
    'Real': '**Data Type Alias**: `Real` — *Floating point number of the size preferred by the framework (default `Float64`).*',
    'Size': '**Data Type Alias**: `Size` — *Unsigned integer for sizes and counts (default `UInt64`).*',
    'Int8': '**Fixed-Size Data Type**: `Int8` — *8-bit signed integer (-128 to 127).*',
    'Int16': '**Fixed-Size Data Type**: `Int16` — *16-bit signed integer (-32,768 to 32,767).*',
    'Int32': '**Fixed-Size Data Type**: `Int32` — *32-bit signed integer.*',
    'Int64': '**Fixed-Size Data Type**: `Int64` — *64-bit signed integer.*',
    'UInt8': '**Fixed-Size Data Type**: `UInt8` — *8-bit unsigned integer (0 to 255).*',
    'UInt16': '**Fixed-Size Data Type**: `UInt16` — *16-bit unsigned integer (0 to 65,535).*',
    'UInt32': '**Fixed-Size Data Type**: `UInt32` — *32-bit unsigned integer.*',
    'UInt64': '**Fixed-Size Data Type**: `UInt64` — *64-bit unsigned integer.*',
    'Float32': '**Fixed-Size Data Type**: `Float32` — *32-bit single precision IEEE 754 floating point number.*',
    'Float64': '**Fixed-Size Data Type**: `Float64` — *64-bit double precision IEEE 754 floating point number.*',
    'Switch': '**Data Type**: `Switch` — *Boolean switch / conditional control signal (`on` / `off`).*',
    'String': '**Data Type**: `String` — *Text string.*',
    '_NumericTypes': '**Type Class**: `_NumericTypes` — *Accepts any integer or float data type.*',
    '_IntegerTypes': '**Type Class**: `_IntegerTypes` — *Accepts any signed or unsigned integer data type.*',
    '_FloatTypes': '**Type Class**: `_FloatTypes` — *Accepts any floating point data type (`Real`, `Float32`, `Float64`).*',
    '_DataTypes': '**Type Class**: `_DataTypes` — *Accepts all data types including `Switch` and `String`.*',
    // Legacy schema / scalar names preserved for backwards compatibility
    '_IntType': '**Built-in Type**: `_IntType` — *Standard 32-bit signed integer data type (legacy alias for `Int`).*',
    '_RealType': '**Built-in Type**: `_RealType` — *64-bit IEEE 754 double precision floating point data type (legacy alias for `Real`).*',
    '_SwitchType': '**Built-in Type**: `_SwitchType` — *Boolean switch / conditional control signal (`on` / `off`) (legacy alias for `Switch`).*',
    '_StringType': '**Built-in Type**: `_StringType` — *Text string data type (legacy alias for `String`).*',
    '_StateType': '**Built-in Type**: `_StateType` — *State machine state representation.*',
    '_Signal': '**Built-in Type**: `_Signal` — *Base abstract signal representation in Stride.*'
};

interface DataTypeInfo {
    kind: 'integer' | 'float' | 'switch' | 'string';
    bits?: number;
    signed?: boolean;
}

const DATA_TYPE_MAP: Record<string, DataTypeInfo> = {
    'Int8': { kind: 'integer', bits: 8, signed: true },
    'Int16': { kind: 'integer', bits: 16, signed: true },
    'Int32': { kind: 'integer', bits: 32, signed: true },
    'Int64': { kind: 'integer', bits: 64, signed: true },
    'UInt8': { kind: 'integer', bits: 8, signed: false },
    'UInt16': { kind: 'integer', bits: 16, signed: false },
    'UInt32': { kind: 'integer', bits: 32, signed: false },
    'UInt64': { kind: 'integer', bits: 64, signed: false },
    'Float32': { kind: 'float', bits: 32 },
    'Float64': { kind: 'float', bits: 64 },
    'Int': { kind: 'integer', bits: 32, signed: true },
    'UInt': { kind: 'integer', bits: 32, signed: false },
    'Real': { kind: 'float', bits: 64 },
    'Size': { kind: 'integer', bits: 64, signed: false },
    'Switch': { kind: 'switch', bits: 1 },
    'String': { kind: 'string' },
    '_IntType': { kind: 'integer', bits: 32, signed: true },
    '_RealType': { kind: 'float', bits: 64 },
    '_SwitchType': { kind: 'switch', bits: 1 },
    '_StringType': { kind: 'string' }
};

function getConversionRisk(fromType: string, toType: string): string | null {
    if (fromType === toType) return null;
    const from = DATA_TYPE_MAP[fromType];
    const to = DATA_TYPE_MAP[toType];
    if (!from || !to) return null;

    if (from.kind === 'float' && to.kind === 'integer') {
        return 'the fractional part is truncated, and large values overflow';
    }
    if (from.kind === 'float' && to.kind === 'float') {
        if ((from.bits || 64) > (to.bits || 64)) {
            return 'precision and range are lost';
        }
    }
    if (from.kind === 'integer' && to.kind === 'float') {
        const fromBits = from.bits || 32;
        const toBits = to.bits || 64;
        if (fromBits >= 32 && toBits === 32) {
            return 'integers above 2^24 (Float32) are rounded';
        }
        if (fromBits === 64 && toBits === 64) {
            return 'integers above 2^53 (Float64) are rounded';
        }
    }
    if (from.kind === 'integer' && to.kind === 'integer') {
        const fromBits = from.bits || 32;
        const toBits = to.bits || 32;
        const fromSigned = from.signed ?? true;
        const toSigned = to.signed ?? true;

        if (fromSigned && !toSigned) {
            if (fromBits <= toBits) {
                return 'negative values wrap';
            } else {
                return `wraps negative values and values above the maximum of ${toType}`;
            }
        }
        if (!fromSigned && toSigned && fromBits >= toBits) {
            return 'large values become negative';
        }
        if (fromBits > toBits) {
            return `wraps values outside the range of ${toType}`;
        }
    }
    return null;
}

function getLiteralConversionRisk(literalVal: string, toType: string): string | null {
    const to = DATA_TYPE_MAP[toType];
    if (!to) return null;

    const num = Number(literalVal);
    if (isNaN(num)) return null;

    if (to.kind === 'integer') {
        if (literalVal.includes('.')) {
            return `fractional part is truncated for integer type '${toType}'`;
        }
        const bits = to.bits || 32;
        const signed = to.signed ?? true;
        if (signed) {
            const min = -Math.pow(2, bits - 1);
            const max = Math.pow(2, bits - 1) - 1;
            if (num < min || num > max) {
                return `wraps values outside the range of ${toType}`;
            }
        } else {
            const max = Math.pow(2, bits) - 1;
            if (num < 0) {
                return 'wraps negative values';
            }
            if (num > max) {
                return `wraps values above the maximum of ${toType}`;
            }
        }
    } else if (to.kind === 'float') {
        if (to.bits === 32 && Math.abs(num) > Math.pow(2, 24)) {
            return 'integers above 2^24 (Float32) are rounded';
        }
    }
    return null;
}

export const SUFFIX_TO_TYPE: Record<string, string> = {
    'i8': 'Int8',
    'i16': 'Int16',
    'i32': 'Int32',
    'i64': 'Int64',
    'u8': 'UInt8',
    'u16': 'UInt16',
    'u32': 'UInt32',
    'u64': 'UInt64',
    'u': 'UInt',
    'usize': 'Size',
    'f32': 'Float32',
    'f64': 'Float64'
};

export interface ParsedNumericLiteral {
    isValid: boolean;
    type: string;
    value?: number | bigint;
    suffix?: string;
    isFloat: boolean;
    error?: string;
}

export function checkIntegerRange(val: bigint, suffix: string | undefined, typeName: string): string | null {
    if (!suffix) return null;
    if (suffix === 'u8') {
        if (val < 0n || val > 255n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'i8') {
        if (val < -128n || val > 127n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'u16') {
        if (val < 0n || val > 65535n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'i16') {
        if (val < -32768n || val > 32767n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'u32') {
        if (val < 0n || val > 4294967295n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'i32') {
        if (val < -2147483648n || val > 2147483647n) return `The value does not fit in ${typeName}.`;
    } else if (suffix === 'u64') {
        if (val < 0n || val > 18446744073709551615n) return "The value does not fit in 64 bits.";
    } else if (suffix === 'i64') {
        if (val < -9223372036854775808n || val > 9223372036854775807n) {
            if (val > 18446744073709551615n || val < -18446744073709551615n) {
                return "The value does not fit in 64 bits.";
            }
            return `The value does not fit in ${typeName}.`;
        }
    }
    return null;
}

export function parseNumericLiteral(text: string): ParsedNumericLiteral | undefined {
    const trimmed = text.trim();
    if (!trimmed) return undefined;

    const signMatch = /^[+-]/.exec(trimmed);
    const sign = signMatch ? signMatch[0] : '';
    const body = sign ? trimmed.slice(1) : trimmed;

    // Check hex literal: 0[xX][0-9a-fA-F](_?[0-9a-fA-F])*([iu](8|16|32|64)|u|usize)?
    const hexMatch = /^0[xX]([0-9a-fA-F](?:_?[0-9a-fA-F])*)([iu](?:8|16|32|64)|u|usize)?$/.exec(body);
    if (hexMatch) {
        const rawDigits = hexMatch[1].replace(/_/g, '');
        const suffix = hexMatch[2];
        const type = suffix ? (SUFFIX_TO_TYPE[suffix] || 'Int') : 'Int';
        if (suffix && (suffix[0] === 'u' || suffix === 'usize') && sign === '-') {
            return { isValid: false, type, suffix, isFloat: false, error: "Unsigned literals can't be negative." };
        }
        try {
            const val = BigInt('0x' + rawDigits);
            const numVal = sign === '-' ? -val : val;
            const rangeErr = checkIntegerRange(numVal, suffix, type);
            if (rangeErr) {
                return { isValid: false, type, value: numVal, suffix, isFloat: false, error: rangeErr };
            }
            return { isValid: true, type, value: numVal, suffix, isFloat: false };
        } catch {
            return { isValid: false, type, suffix, isFloat: false, error: "The value does not fit in 64 bits." };
        }
    }

    // Check binary literal: 0[bB][01](_?[01])*([iu](8|16|32|64)|u|usize)?
    const binMatch = /^0[bB]([01](?:_?[01])*)([iu](?:8|16|32|64)|u|usize)?$/.exec(body);
    if (binMatch) {
        const rawDigits = binMatch[1].replace(/_/g, '');
        const suffix = binMatch[2];
        const type = suffix ? (SUFFIX_TO_TYPE[suffix] || 'Int') : 'Int';
        if (suffix && (suffix[0] === 'u' || suffix === 'usize') && sign === '-') {
            return { isValid: false, type, suffix, isFloat: false, error: "Unsigned literals can't be negative." };
        }
        try {
            const val = BigInt('0b' + rawDigits);
            const numVal = sign === '-' ? -val : val;
            const rangeErr = checkIntegerRange(numVal, suffix, type);
            if (rangeErr) {
                return { isValid: false, type, value: numVal, suffix, isFloat: false, error: rangeErr };
            }
            return { isValid: true, type, value: numVal, suffix, isFloat: false };
        } catch {
            return { isValid: false, type, suffix, isFloat: false, error: "The value does not fit in 64 bits." };
        }
    }

    // Check real with integer suffix error: e.g. 1.5i32, 0.5u8
    if (/^[0-9](?:_?[0-9])*\.[0-9]*(?:_?[0-9])*(?:[iu](?:8|16|32|64)|u|usize)$/.test(body) ||
        /^\.[0-9](?:_?[0-9])*(?:[iu](?:8|16|32|64)|u|usize)$/.test(body)) {
        return { isValid: false, type: 'Real', isFloat: true, error: "Integer suffixes do not apply to reals." };
    }

    // Check float literal with suffix: e.g. 0.5f32, .5f32, 1e-3f32, 2f64, 1_000f32
    const floatSuffixedMatch = /^(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*|[0-9](?:_?[0-9])*)(f(?:32|64))$/.exec(body);
    if (floatSuffixedMatch) {
        const suffix = floatSuffixedMatch[1];
        const type = SUFFIX_TO_TYPE[suffix] || 'Float32';
        const numStr = (sign + body.slice(0, -suffix.length)).replace(/_/g, '');
        const val = parseFloat(numStr);
        return { isValid: true, type, value: val, suffix, isFloat: true };
    }

    // Check float literal without suffix: e.g. 0.5, 1_000.5, .5, 1e-3, 2.5e6
    if (/^(?:[0-9](?:_?[0-9])*\.(?:[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9](?:_?[0-9])*)?|\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*)$/.test(body)) {
        const val = parseFloat((sign + body).replace(/_/g, ''));
        return { isValid: true, type: 'Real', value: val, isFloat: true };
    }

    // Check decimal integer with optional int suffix: e.g. 255u8, -128i8, 42u, 7usize, 1_000, 44100
    const intMatch = /^[0-9](?:_?[0-9])*([iu](?:8|16|32|64)|u|usize)?$/.exec(body);
    if (intMatch) {
        const suffix = intMatch[1];
        const type = suffix ? (SUFFIX_TO_TYPE[suffix] || 'Int') : 'Int';
        if (suffix && (suffix[0] === 'u' || suffix === 'usize') && sign === '-') {
            return { isValid: false, type, suffix, isFloat: false, error: "Unsigned literals can't be negative." };
        }
        const rawDigits = body.slice(0, suffix ? -suffix.length : undefined).replace(/_/g, '');
        try {
            const val = BigInt(rawDigits);
            const numVal = sign === '-' ? -val : val;
            const rangeErr = checkIntegerRange(numVal, suffix, type);
            if (rangeErr) {
                return { isValid: false, type, value: numVal, suffix, isFloat: false, error: rangeErr };
            }
            return { isValid: true, type, value: numVal, suffix, isFloat: false };
        } catch {
            return { isValid: false, type, suffix, isFloat: false, error: "The value does not fit in 64 bits." };
        }
    }

    // Check unknown type suffix like 1u12
    const unknownSuffixMatch = /^[0-9](?:_?[0-9])*([a-zA-Z0-9]+)$/.exec(body);
    if (unknownSuffixMatch) {
        const badSuffix = unknownSuffixMatch[1];
        return { isValid: false, type: 'Int', suffix: badSuffix, isFloat: false, error: `Unknown type suffix '${badSuffix}'.` };
    }

    return undefined;
}

function maskCommentsAndStrings(text: string): string {
    const chars = text.split('');
    let inString: false | '"' | "'" = false;
    let inComment = false;
    let escape = false;

    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];

        if (inComment) {
            if (c === '\n' || c === '\r') {
                inComment = false;
            } else {
                chars[i] = ' ';
            }
            continue;
        }

        if (inString !== false) {
            if (escape) {
                escape = false;
                chars[i] = (c === '\n' || c === '\r') ? c : ' ';
            } else if (c === '\\') {
                escape = true;
                chars[i] = ' ';
            } else if (c === inString) {
                inString = false;
                chars[i] = ' ';
            } else {
                chars[i] = (c === '\n' || c === '\r') ? c : ' ';
            }
            continue;
        }

        if (c === '#') {
            inComment = true;
            chars[i] = ' ';
        } else if (c === '"' || c === "'") {
            inString = c;
            chars[i] = ' ';
        }
    }

    return chars.join('');
}

function isOffsetInCommentOrString(text: string, offset: number): boolean {
    let inString: false | '"' | "'" = false;
    let inComment = false;
    let escape = false;

    const limit = Math.min(offset, text.length);
    for (let i = 0; i < limit; i++) {
        const c = text[i];

        if (inComment) {
            if (c === '\n' || c === '\r') {
                inComment = false;
            }
            continue;
        }

        if (inString !== false) {
            if (escape) {
                escape = false;
            } else if (c === '\\') {
                escape = true;
            } else if (c === inString) {
                inString = false;
            }
            continue;
        }

        if (c === '#') {
            inComment = true;
        } else if (c === '"' || c === "'") {
            inString = c;
        }
    }

    if (inComment || inString !== false) {
        return true;
    }

    if (offset < text.length && (text[offset] === '"' || text[offset] === "'" || text[offset] === '#')) {
        return true;
    }

    return false;
}

function extractBraceBlock(text: string, startIndex: number, maskedText?: string): { body: string; maskedBody: string; endIndex: number } | null {
    const scanText = maskedText || maskCommentsAndStrings(text);
    let braceCount = 0;
    let inBrace = false;
    let bodyStart = -1;

    for (let i = startIndex; i < scanText.length; i++) {
        const char = scanText[i];
        if (char === '{') {
            if (!inBrace) {
                inBrace = true;
                bodyStart = i + 1;
            }
            braceCount++;
        } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && inBrace) {
                return {
                    body: text.substring(bodyStart, i),
                    maskedBody: scanText.substring(bodyStart, i),
                    endIndex: i + 1
                };
            }
        }
    }
    return null;
}

function extractSquareBracketBlock(text: string, startIndex: number, maskedText?: string): { body: string; maskedBody: string; endIndex: number } | null {
    const scanText = maskedText || maskCommentsAndStrings(text);
    let bracketCount = 0;
    let inBracket = false;
    let bodyStart = -1;

    for (let i = startIndex; i < scanText.length; i++) {
        const char = scanText[i];
        if (char === '[') {
            if (!inBracket) {
                inBracket = true;
                bodyStart = i + 1;
            }
            bracketCount++;
        } else if (char === ']') {
            bracketCount--;
            if (bracketCount === 0 && inBracket) {
                return {
                    body: text.substring(bodyStart, i),
                    maskedBody: scanText.substring(bodyStart, i),
                    endIndex: i + 1
                };
            }
        }
    }
    return null;
}

function extractTopLevelField(body: string, maskedBody: string, fieldName: string): string | undefined {
    let depth = 0;
    const headerRegex = new RegExp(`\\b${fieldName}\\s*:`, 'g');
    for (let i = 0; i < maskedBody.length; i++) {
        const ch = maskedBody[i];
        if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            if (depth > 0) depth--;
        } else if (depth === 0) {
            headerRegex.lastIndex = i;
            const match = headerRegex.exec(maskedBody);
            if (match && match.index === i) {
                const afterColon = body.substring(i + match[0].length).trimStart();
                if (afterColon.startsWith('"')) {
                    let strVal = '';
                    let escape = false;
                    for (let c = 1; c < afterColon.length; c++) {
                        const ch2 = afterColon[c];
                        if (escape) {
                            strVal += ch2;
                            escape = false;
                        } else if (ch2 === '\\') {
                            escape = true;
                        } else if (ch2 === '"') {
                            return strVal;
                        } else {
                            strVal += ch2;
                        }
                    }
                    return strVal;
                } else if (afterColon.startsWith("'")) {
                    let strVal = '';
                    let escape = false;
                    for (let c = 1; c < afterColon.length; c++) {
                        const ch2 = afterColon[c];
                        if (escape) {
                            strVal += ch2;
                            escape = false;
                        } else if (ch2 === '\\') {
                            escape = true;
                        } else if (ch2 === "'") {
                            return strVal;
                        } else {
                            strVal += ch2;
                        }
                    }
                    return strVal;
                } else {
                    const idMatch = /^([_a-zA-Z0-9.]+)/.exec(afterColon);
                    if (idMatch) {
                        return idMatch[1];
                    }
                }
            }
        }
    }
    return undefined;
}

function extractTopLevelList(body: string, maskedBody: string, fieldName: string): string[] {
    let depth = 0;
    const headerRegex = new RegExp(`\\b${fieldName}\\s*:\\s*\\[`, 'g');
    for (let i = 0; i < maskedBody.length; i++) {
        const ch = maskedBody[i];
        if (ch === '{' || ch === '[') {
            depth++;
        } else if (ch === '}' || ch === ']') {
            if (depth > 0) depth--;
        } else if (depth === 0) {
            headerRegex.lastIndex = i;
            const match = headerRegex.exec(maskedBody);
            if (match && match.index === i) {
                const listStart = i + match[0].length;
                let bracketDepth = 1;
                for (let j = listStart; j < maskedBody.length; j++) {
                    if (maskedBody[j] === '[') bracketDepth++;
                    else if (maskedBody[j] === ']') {
                        bracketDepth--;
                        if (bracketDepth === 0) {
                            const rawList = body.substring(listStart, j);
                            return rawList.split(',')
                                .map(item => item.trim().replace(/[\[\]{}]/g, '').trim())
                                .filter(item => item.length > 0);
                        }
                    }
                }
            }
        }
    }
    return [];
}

function getLineNumber(text: string, charIndex: number, baseLine: number = 1): number {
    let line = baseLine;
    const limit = Math.min(charIndex, text.length);
    for (let i = 0; i < limit; i++) {
        if (text[i] === '\n') line++;
    }
    return line;
}

// ============================================================================
// Scopes & Lexical Scope Stack
// ============================================================================

interface ScopeDeclaration {
    name: string;
    kind: string;
    line: number;
    signature: string;
    body?: string;
    meta?: string;
    type?: string;
    domain?: string;
    defaultVal?: string;
    boundBlock?: string;
    associatedPort?: PortInfo;
    arraySpec?: string;
    generatorVar?: string;
    generatorRange?: string;
    isAnonymous?: boolean;
    fromDomain?: string;
    withCondition?: string;
    variants?: string[];
}

interface ScopeContext {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
    declarations: Map<string, ScopeDeclaration>;
    ports: Map<string, PortInfo>;
    boundPorts: Map<string, PortInfo>;
    children: ScopeContext[];
    parent?: ScopeContext;
    arraySpec?: string;
    generatorVar?: string;
    generatorRange?: string;
    declMeta?: string;
    declType?: string;
    declDomain?: string;
    declDefaultVal?: string;
    declBoundBlock?: string;
    enclosingDecls?: EnclosingDecl[];
    isAnonymous?: boolean;
    withCondition?: string;
    variants?: string[];
}

function extractBalancedParens(text: string, openParenIdx: number): { content: string; endIndex: number } | undefined {
    if (openParenIdx < 0 || openParenIdx >= text.length || text[openParenIdx] !== '(') return undefined;
    let depth = 0;
    for (let i = openParenIdx; i < text.length; i++) {
        if (text[i] === '(') depth++;
        else if (text[i] === ')') {
            depth--;
            if (depth === 0) {
                return {
                    content: text.substring(openParenIdx + 1, i),
                    endIndex: i + 1
                };
            }
        }
    }
    return undefined;
}

function stripComments(text: string): string {
    return maskCommentsAndStrings(text);
}

interface CallablePortSpec {
    propName?: string;
    entityName: string;
    entityType: string;
    arraySpec?: string;
    propertiesText?: string;
    defaultValue?: string;
    properties?: Map<string, string>;
}

interface ParsedCallableHeader {
    kind: string;
    callableName: string;
    mainInputs: CallablePortSpec[];
    propertyPorts: CallablePortSpec[];
    mainOutputs: CallablePortSpec[];
    hasHeaderPorts: boolean;
    hasMainInputs: boolean;
}

function synthesizePortName(entityName: string): string {
    if (entityName.endsWith('Port')) return entityName;
    return entityName + 'Port';
}

function splitTopLevel(str: string, sep: string): string[] {
    const parts: string[] = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let lastIdx = 0;
    const len = sep.length;
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') { if (parenDepth > 0) parenDepth--; }
        else if (ch === '[') bracketDepth++;
        else if (ch === ']') { if (bracketDepth > 0) bracketDepth--; }
        else if (ch === '{') braceDepth++;
        else if (ch === '}') { if (braceDepth > 0) braceDepth--; }
        else if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            if (str.substr(i, len) === sep) {
                parts.push(str.substring(lastIdx, i).trim());
                lastIdx = i + len;
                i += len - 1;
            }
        }
    }
    parts.push(str.substring(lastIdx).trim());
    return parts.filter(p => p.length > 0);
}

function parsePortItem(itemStr: string): CallablePortSpec | null {
    let propName: string | undefined = undefined;
    let rest = itemStr.trim();
    const propMatch = /^\s*([_a-zA-Z0-9]+)\s*:\s*(.*)$/.exec(rest);
    if (propMatch) {
        propName = propMatch[1];
        rest = propMatch[2].trim();
    }
    const explicitMatch = /^\s*(signal|switch)\s+([_a-zA-Z0-9]+)(?:\s*\[([^\]]*)\])?(?:\s*\{([\s\S]*)\})?$/.exec(rest);
    if (explicitMatch) {
        const propsMap = new Map<string, string>();
        if (explicitMatch[4]) {
            const pReg = /\b([_a-zA-Z0-9]+)\s*:\s*([^;\n\r,}]+)/g;
            let pm;
            while ((pm = pReg.exec(explicitMatch[4])) !== null) {
                propsMap.set(pm[1], pm[2].trim());
            }
        }
        return {
            propName,
            entityName: explicitMatch[2],
            entityType: explicitMatch[1],
            arraySpec: explicitMatch[3],
            propertiesText: explicitMatch[4],
            properties: propsMap
        };
    }
    const pureMatch = /^\s*([_a-zA-Z0-9]+)(?:\s*\[([^\]]*)\])?$/.exec(rest);
    if (pureMatch) {
        return {
            propName,
            entityName: pureMatch[1],
            entityType: 'signal',
            arraySpec: pureMatch[2]
        };
    }
    if (propName) {
        return {
            propName,
            entityName: propName,
            entityType: 'signal',
            defaultValue: rest
        };
    }
    return null;
}

function parsePortGroup(groupStr: string): CallablePortSpec[] {
    let s = groupStr.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
        s = s.substring(1, s.length - 1).trim();
    }
    const items = splitTopLevel(s, ',');
    return items.map(parsePortItem).filter((p): p is CallablePortSpec => p !== null);
}

function findCallableBodyStart(maskedText: string, startIndex: number): { headerStr: string; bodyStart: number } | null {
    let parenDepth = 0;
    let bracketDepth = 0;
    let i = startIndex;
    while (i < maskedText.length) {
        const ch = maskedText[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') { if (parenDepth > 0) parenDepth--; }
        else if (ch === '[') bracketDepth++;
        else if (ch === ']') { if (bracketDepth > 0) bracketDepth--; }
        else if (ch === '{') {
            if (parenDepth === 0 && bracketDepth === 0) {
                const block = extractBraceBlock(maskedText, i);
                if (block) {
                    const after = maskedText.slice(block.endIndex).trimStart();
                    if (after.startsWith('>>') || after.startsWith('{')) {
                        i = block.endIndex;
                        continue;
                    }
                }
                return {
                    headerStr: maskedText.substring(startIndex, i),
                    bodyStart: i
                };
            }
        }
        i++;
    }
    return null;
}

function parseCallableHeader(kind: string, headerStr: string): ParsedCallableHeader {
    const stages = splitTopLevel(headerStr, '>>');
    let mainInputsStr: string | undefined = undefined;
    let callablePart: string | undefined = undefined;
    let mainOutputsStr: string | undefined = undefined;

    if (stages.length >= 3) {
        mainInputsStr = stages[0];
        callablePart = stages[1];
        mainOutputsStr = stages.slice(2).join(' >> ');
    } else if (stages.length === 2) {
        if (kind === 'reaction') {
            callablePart = stages[0];
            mainOutputsStr = stages[1];
        } else {
            if (stages[0].includes('(') || !stages[1].includes('(')) {
                callablePart = stages[0];
                mainOutputsStr = stages[1];
            } else {
                mainInputsStr = stages[0];
                callablePart = stages[1];
            }
        }
    } else if (stages.length === 1) {
        callablePart = stages[0];
    }

    let callableName = '';
    let propPortsStr: string | undefined = undefined;
    if (callablePart) {
        const parenIdx = callablePart.indexOf('(');
        if (parenIdx >= 0 && callablePart.endsWith(')')) {
            callableName = callablePart.substring(0, parenIdx).trim();
            propPortsStr = callablePart.substring(parenIdx + 1, callablePart.length - 1).trim();
        } else {
            callableName = callablePart.trim();
        }
    }

    const mainInputs = mainInputsStr ? parsePortGroup(mainInputsStr) : [];
    const propertyPorts = propPortsStr ? parsePortGroup(propPortsStr) : [];
    const mainOutputs = mainOutputsStr ? parsePortGroup(mainOutputsStr) : [];

    return {
        kind,
        callableName,
        mainInputs,
        propertyPorts,
        mainOutputs,
        hasHeaderPorts: (mainInputs.length > 0 || propertyPorts.length > 0 || mainOutputs.length > 0),
        hasMainInputs: (mainInputs.length > 0 || (kind === 'reaction' && stages.length >= 2 && !stages[0].includes('(') && stages[1].includes('(')))
    };
}

function parseDeclarationsFromBlock(blockBody: string, baseLine: number, filePath: string): ScopeDeclaration[] {
    const maskedBody = maskCommentsAndStrings(blockBody);
    const decls: ScopeDeclaration[] = [];
    const wordRegex = /\b([_a-zA-Z0-9]+)\b/g;
    let wMatch;
    let pendingWithCondition: { condition: string; line: number } | undefined;

    while ((wMatch = wordRegex.exec(maskedBody)) !== null) {
        const word = wMatch[1];
        const idx = wMatch.index;
        const afterWord = maskedBody.substring(idx + word.length).trimStart();
        if (afterWord.startsWith(':') && !afterWord.startsWith('::')) continue;

        let dLine = baseLine;
        for (let i = 0; i < idx; i++) {
            if (blockBody[i] === '\n') dLine++;
        }

        const hasAtPrefix = idx > 0 && maskedBody[idx - 1] === '@';
        if (word === 'with' && (hasAtPrefix || idx === 0 || /\s/.test(maskedBody[idx - 1]))) {
            const afterWith = maskedBody.substring(idx + word.length);
            const parenMatch = /^\s*\(/.exec(afterWith);
            if (parenMatch) {
                const openParenIdx = idx + word.length + parenMatch[0].length - 1;
                const parenResult = extractBalancedParens(maskedBody, openParenIdx);
                if (parenResult) {
                    const condition = parenResult.content.trim();
                    const afterParens = maskedBody.substring(parenResult.endIndex).trimStart();
                    if (afterParens.startsWith('{')) {
                        const block = extractBraceBlock(blockBody, parenResult.endIndex, maskedBody);
                        if (block) {
                            const innerDecls = parseDeclarationsFromBlock(block.body, dLine, filePath);
                            for (const d of innerDecls) {
                                if (!d.withCondition) d.withCondition = condition;
                                decls.push(d);
                            }
                            wordRegex.lastIndex = block.endIndex;
                            continue;
                        }
                    } else {
                        pendingWithCondition = { condition, line: dLine };
                        wordRegex.lastIndex = parenResult.endIndex;
                        continue;
                    }
                }
            }
        }

        if (word === 'feature') {
            const afterFeature = maskedBody.substring(idx + 7);
            const braceMatch = /^\s+([_a-zA-Z0-9]+)\s*(?=\{)/.exec(afterFeature);
            const noBraceMatch = /^\s+([_a-zA-Z0-9]+)\s*(?:;|\r?\n|$)/.exec(afterFeature);
            if (!braceMatch && noBraceMatch) {
                const featName = noBraceMatch[1];
                decls.push({
                    name: featName,
                    kind: 'feature',
                    line: dLine,
                    signature: `feature ${featName}`,
                    type: 'feature',
                    meta: `Feature toggle \`${featName}\``,
                    withCondition: pendingWithCondition && Math.abs(dLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined
                });
                pendingWithCondition = undefined;
                wordRegex.lastIndex = idx + 7 + noBraceMatch[0].length;
                continue;
            }
        }

        if (word === 'module' || word === 'reaction' || word === 'loop') {
            const callableInfo = findCallableBodyStart(maskedBody, idx + word.length);
            if (callableInfo) {
                const parsedHeader = parseCallableHeader(word, callableInfo.headerStr);
                const block = extractBraceBlock(blockBody, callableInfo.bodyStart, maskedBody);
                if (block) {
                    const name = parsedHeader.callableName || `${word}_line${dLine}`;
                    const declMeta = extractTopLevelField(block.body, block.maskedBody, 'meta') ||
                                     extractTopLevelField(block.body, block.maskedBody, 'details');
                    const declType = extractTopLevelField(block.body, block.maskedBody, 'type');
                    const declDomain = extractTopLevelField(block.body, block.maskedBody, 'domain');
                    const declDefaultVal = extractTopLevelField(block.body, block.maskedBody, 'default');

                    const withCond = pendingWithCondition && Math.abs(dLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined;
                    pendingWithCondition = undefined;

                    decls.push({
                        name,
                        kind: word,
                        line: dLine,
                        signature: withCond ? `@with(${withCond}) ${word} ${callableInfo.headerStr.trim().replace(/\s+/g, ' ')}` : `${word} ${callableInfo.headerStr.trim().replace(/\s+/g, ' ')}`,
                        body: block.body,
                        meta: declMeta,
                        type: declType,
                        domain: declDomain,
                        defaultVal: declDefaultVal,
                        isAnonymous: !parsedHeader.callableName,
                        withCondition: withCond
                    });
                    wordRegex.lastIndex = callableInfo.bodyStart;
                    continue;
                }
            }
        }

        const stdRegex = /^([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/;
        const sub = maskedBody.substring(idx);
        const stdMatch = stdRegex.exec(sub);
        if (stdMatch && stdMatch[1] === word) {
            const kind = stdMatch[1];
            let name = stdMatch[2];
            const bracketContent = stdMatch[3] ? stdMatch[3].trim() : undefined;
            const annotation = stdMatch[4];
            const headerEnd = idx + stdMatch[0].length;
            const block = extractBraceBlock(blockBody, headerEnd, maskedBody);
            if (block) {
                const pBody = block.body;

                let generatorVar: string | undefined;
                let generatorRange: string | undefined;
                let arraySpec: string | undefined;

                if (bracketContent !== undefined) {
                    const genMatch = /^\s*([_a-zA-Z0-9]+)\s+in\s+(.+)$/.exec(bracketContent);
                    if (genMatch) {
                        generatorVar = genMatch[1];
                        generatorRange = genMatch[2].trim();
                    } else {
                        arraySpec = bracketContent;
                    }
                }

                const isAnonymous = !name;
                const nameVal = extractTopLevelField(pBody, block.maskedBody, 'name');
                const labelVal = extractTopLevelField(pBody, block.maskedBody, 'label');
                const typeNameVal = extractTopLevelField(pBody, block.maskedBody, 'typeName');
                const blockVal = (kind === 'alias') ? extractTopLevelField(pBody, block.maskedBody, 'entity') : undefined;

                if (isAnonymous) {
                    const innerName = nameVal || labelVal;
                    let anonName = `<${kind}>`;
                    if (innerName) {
                        anonName += ` "${innerName}"`;
                    } else if (bracketContent) {
                        anonName += ` [${bracketContent}]`;
                    }
                    name = anonName;
                } else if (!name) {
                    name = nameVal ||
                           typeNameVal ||
                           blockVal ||
                           (bracketContent ? `[${bracketContent}]` : `${kind}_line${dLine}`);
                }

                const declMeta = extractTopLevelField(pBody, block.maskedBody, 'meta') ||
                                 extractTopLevelField(pBody, block.maskedBody, 'details');
                const declType = extractTopLevelField(pBody, block.maskedBody, 'type');
                const declDomain = extractTopLevelField(pBody, block.maskedBody, 'domain');
                const declDefaultVal = extractTopLevelField(pBody, block.maskedBody, 'default');
                const declBoundBlock = (kind === 'alias') ? extractTopLevelField(pBody, block.maskedBody, 'entity') : undefined;

                const withCond = pendingWithCondition && Math.abs(dLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined;
                pendingWithCondition = undefined;

                let sig = `${kind} ${name}`;
                if (bracketContent !== undefined) {
                    sig += `[${bracketContent}]`;
                }
                if (annotation) {
                    sig += ` @${annotation}`;
                }
                if (withCond) {
                    sig = `@with(${withCond}) ${sig}`;
                }

                let featureVariants: string[] | undefined;
                if (kind === 'feature') {
                    const varList = extractTopLevelList(pBody, block.maskedBody, 'variants');
                    if (varList.length > 0) {
                        featureVariants = varList;
                        for (const vName of varList) {
                            decls.push({
                                name: vName,
                                kind: 'variant',
                                line: dLine,
                                signature: `${name}::${vName}`,
                                type: 'variant',
                                meta: `Variant \`${vName}\` of feature \`${name}\``
                            });
                        }
                    }
                }

                decls.push({
                    name,
                    kind,
                    line: dLine,
                    signature: sig,
                    body: pBody,
                    meta: declMeta,
                    type: declType,
                    domain: declDomain,
                    defaultVal: declDefaultVal,
                    boundBlock: declBoundBlock,
                    arraySpec,
                    generatorVar,
                    generatorRange,
                    isAnonymous,
                    withCondition: withCond,
                    variants: featureVariants
                });
                wordRegex.lastIndex = headerEnd;
                continue;
            }
        }
    }

    return decls;
}

function parseScopeTree(text: string, filePath: string, preMaskedText?: string): ScopeContext {
    const maskedText = preMaskedText || maskCommentsAndStrings(text);
    const lines = text.split(/\r?\n/);
    const rootScope: ScopeContext = {
        name: '<root>',
        kind: 'root',
        startLine: 1,
        endLine: lines.length,
        startOffset: 0,
        endOffset: text.length,
        declarations: new Map(),
        ports: new Map(),
        boundPorts: new Map(),
        children: []
    };

    const discoveredScopes: ScopeContext[] = [];
    const enclosingDecls: EnclosingDecl[] = [];
    let pendingWithCondition: { condition: string; line: number } | undefined;

    const wordRegex = /\b([_a-zA-Z0-9]+)\b/g;
    let wMatch;
    while ((wMatch = wordRegex.exec(maskedText)) !== null) {
        const word = wMatch[1];
        const idx = wMatch.index;
        const afterWord = maskedText.substring(idx + word.length).trimStart();
        if (afterWord.startsWith(':') && !afterWord.startsWith('::')) continue;

        // Check for @with directive or @with(...) { ... } block group
        const hasAtPrefix = idx > 0 && maskedText[idx - 1] === '@';
        if (word === 'with' && (hasAtPrefix || idx === 0 || /\s/.test(maskedText[idx - 1]))) {
            const withStart = hasAtPrefix ? idx - 1 : idx;
            const afterWith = maskedText.substring(idx + word.length);
            const parenMatch = /^\s*\(/.exec(afterWith);
            if (parenMatch) {
                const openParenIdx = idx + word.length + parenMatch[0].length - 1;
                const parenResult = extractBalancedParens(maskedText, openParenIdx);
                if (parenResult) {
                    const condition = parenResult.content.trim();
                    const afterParens = maskedText.substring(parenResult.endIndex).trimStart();
                    if (afterParens.startsWith('{')) {
                        const braceIdx = maskedText.indexOf('{', parenResult.endIndex);
                        const block = extractBraceBlock(text, parenResult.endIndex, maskedText);
                        if (block) {
                            const startOffset = withStart;
                            const endOffset = block.endIndex;
                            const startLine = getLineNumber(text, startOffset);
                            const endLine = getLineNumber(text, endOffset);
                            const scope: ScopeContext = {
                                name: `@with(${condition})`,
                                kind: 'group',
                                startLine,
                                endLine,
                                startOffset,
                                endOffset,
                                declarations: new Map(),
                                ports: new Map(),
                                boundPorts: new Map(),
                                children: [],
                                withCondition: condition,
                                declMeta: `Conditional block group guarded by \`@with(${condition})\``
                            };
                            discoveredScopes.push(scope);
                            enclosingDecls.push({
                                kind: 'group',
                                name: `@with(${condition})`,
                                start: startOffset,
                                end: endOffset,
                                line: startLine
                            });
                            wordRegex.lastIndex = braceIdx + 1;
                            continue;
                        }
                    } else {
                        pendingWithCondition = {
                            condition,
                            line: getLineNumber(text, withStart)
                        };
                        wordRegex.lastIndex = parenResult.endIndex;
                        continue;
                    }
                }
            }
        }

        // Check for property-less feature declaration, e.g.: feature HardwareSPI
        if (word === 'feature') {
            const afterFeature = maskedText.substring(idx + 7);
            const braceMatch = /^\s+([_a-zA-Z0-9]+)\s*(?=\{)/.exec(afterFeature);
            const noBraceMatch = /^\s+([_a-zA-Z0-9]+)\s*(?:;|\r?\n|$)/.exec(afterFeature);
            if (!braceMatch && noBraceMatch) {
                const featName = noBraceMatch[1];
                const startOffset = idx;
                const endOffset = idx + 7 + noBraceMatch[0].length;
                const startLine = getLineNumber(text, startOffset);
                const endLine = startLine;

                const withCond = pendingWithCondition && Math.abs(startLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined;
                pendingWithCondition = undefined;

                const scope: ScopeContext = {
                    name: featName,
                    kind: 'feature',
                    startLine,
                    endLine,
                    startOffset,
                    endOffset,
                    declarations: new Map(),
                    ports: new Map(),
                    boundPorts: new Map(),
                    children: [],
                    declMeta: `Feature toggle \`${featName}\``,
                    declType: 'feature',
                    withCondition: withCond
                };
                discoveredScopes.push(scope);
                enclosingDecls.push({
                    kind: 'feature',
                    name: featName,
                    start: startOffset,
                    end: endOffset,
                    line: startLine
                });
                wordRegex.lastIndex = endOffset;
                continue;
            }
        }

        if (word === 'module' || word === 'reaction' || word === 'loop') {
            const callableInfo = findCallableBodyStart(maskedText, idx + word.length);
            if (callableInfo) {
                const parsedHeader = parseCallableHeader(word, callableInfo.headerStr);
                const block = extractBraceBlock(text, callableInfo.bodyStart, maskedText);
                if (block) {
                    const startOffset = idx;
                    const endOffset = block.endIndex;
                    const startLine = getLineNumber(text, startOffset);
                    const endLine = getLineNumber(text, endOffset);
                    const name = parsedHeader.callableName || `${word}_line${startLine}`;

                    const declMeta = extractTopLevelField(block.body, block.maskedBody, 'meta') ||
                                     extractTopLevelField(block.body, block.maskedBody, 'details');
                    const declType = extractTopLevelField(block.body, block.maskedBody, 'type');
                    const declDomain = extractTopLevelField(block.body, block.maskedBody, 'domain');
                    const declDefaultVal = extractTopLevelField(block.body, block.maskedBody, 'default');

                    const withCond = pendingWithCondition && Math.abs(startLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined;
                    pendingWithCondition = undefined;

                    const scope: ScopeContext = {
                        name,
                        kind: word,
                        startLine,
                        endLine,
                        startOffset,
                        endOffset,
                        declarations: new Map(),
                        ports: new Map(),
                        boundPorts: new Map(),
                        children: [],
                        declMeta,
                        declType,
                        declDomain,
                        declDefaultVal,
                        isAnonymous: !parsedHeader.callableName,
                        withCondition: withCond
                    };

                    const addHeaderPortItem = (p: CallablePortSpec, portType: 'mainInputPort' | 'propertyInputPort' | 'mainOutputPort') => {
                        const portName = synthesizePortName(p.entityName);
                        const portInfo: PortInfo = {
                            portType,
                            portName,
                            boundBlock: p.entityName,
                            nameField: p.propName,
                            defaultVal: p.defaultValue || p.properties?.get('default'),
                            types: p.properties?.get('type'),
                            line: startLine
                        };
                        scope.ports.set(portName, portInfo);
                        if (p.propName) {
                            scope.ports.set(p.propName, portInfo);
                        }
                        scope.boundPorts.set(p.entityName, portInfo);

                        scope.declarations.set(p.entityName, {
                            name: p.entityName,
                            kind: p.entityType,
                            line: startLine,
                            signature: `${p.entityType} ${p.entityName}${p.arraySpec !== undefined ? (p.arraySpec ? `[${p.arraySpec}]` : '[]') : ''}`,
                            type: p.properties?.get('type') || (p.entityType === 'switch' ? '_SwitchType' : '_RealType'),
                            meta: p.properties?.get('meta') || `Callable ${portType} entity \`${p.entityName}\``,
                            defaultVal: p.defaultValue || p.properties?.get('default'),
                            arraySpec: p.arraySpec
                        });
                    };

                    for (const inp of parsedHeader.mainInputs) {
                        addHeaderPortItem(inp, 'mainInputPort');
                    }
                    for (const prop of parsedHeader.propertyPorts) {
                        addHeaderPortItem(prop, 'propertyInputPort');
                    }
                    for (const out of parsedHeader.mainOutputs) {
                        addHeaderPortItem(out, 'mainOutputPort');
                    }

                    const ports = parsePortsFromBlock(block.body, startLine, block.maskedBody);
                    for (const p of ports) {
                        scope.ports.set(p.portName, p);
                        if (p.nameField) scope.ports.set(p.nameField, p);
                        if (p.boundBlock) scope.boundPorts.set(p.boundBlock, p);
                    }

                    discoveredScopes.push(scope);
                    enclosingDecls.push({
                        kind: word,
                        name,
                        start: startOffset,
                        end: endOffset,
                        line: startLine
                    });
                    wordRegex.lastIndex = callableInfo.bodyStart;
                    continue;
                }
            }
        }

        const stdRegex = /^([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/;
        const sub = maskedText.substring(idx);
        const stdMatch = stdRegex.exec(sub);
        if (stdMatch && stdMatch[1] === word) {
            const kind = stdMatch[1];
            let name = stdMatch[2];
            const bracketContent = stdMatch[3] ? stdMatch[3].trim() : undefined;
            const annotation = stdMatch[4];
            const headerEnd = idx + stdMatch[0].length;
            const block = extractBraceBlock(text, headerEnd, maskedText);
            if (block) {
                const startOffset = idx;
                const endOffset = headerEnd + block.body.length + 1;
                const startLine = getLineNumber(text, startOffset);
                const endLine = getLineNumber(text, endOffset);

                let generatorVar: string | undefined;
                let generatorRange: string | undefined;
                let arraySpec: string | undefined;

                if (bracketContent !== undefined) {
                    const genMatch = /^\s*([_a-zA-Z0-9]+)\s+in\s+(.+)$/.exec(bracketContent);
                    if (genMatch) {
                        generatorVar = genMatch[1];
                        generatorRange = genMatch[2].trim();
                    } else {
                        arraySpec = bracketContent;
                    }
                }

                const isAnonymous = !name;
                const nameVal = extractTopLevelField(block.body, block.maskedBody, 'name');
                const labelVal = extractTopLevelField(block.body, block.maskedBody, 'label');
                const typeNameVal = extractTopLevelField(block.body, block.maskedBody, 'typeName');
                const blockVal = (kind === 'alias') ? extractTopLevelField(block.body, block.maskedBody, 'entity') : undefined;

                if (isAnonymous) {
                    const innerName = nameVal || labelVal;
                    let anonName = `<${kind}>`;
                    if (innerName) {
                        anonName += ` "${innerName}"`;
                    } else if (bracketContent) {
                        anonName += ` [${bracketContent}]`;
                    }
                    name = anonName;
                } else if (!name) {
                    name = nameVal ||
                           typeNameVal ||
                           blockVal ||
                           (bracketContent ? `[${bracketContent}]` : `${kind}_line${startLine}`);
                }

                const declMeta = extractTopLevelField(block.body, block.maskedBody, 'meta') ||
                                 extractTopLevelField(block.body, block.maskedBody, 'details');
                const declType = extractTopLevelField(block.body, block.maskedBody, 'type');
                const declDomain = extractTopLevelField(block.body, block.maskedBody, 'domain');
                const declDefaultVal = extractTopLevelField(block.body, block.maskedBody, 'default');
                const declBoundBlock = (kind === 'alias') ? extractTopLevelField(block.body, block.maskedBody, 'entity') : undefined;

                const withCond = pendingWithCondition && Math.abs(startLine - pendingWithCondition.line) <= 3 ? pendingWithCondition.condition : undefined;
                pendingWithCondition = undefined;

                let featureVariants: string[] | undefined;
                if (kind === 'feature') {
                    const varList = extractTopLevelList(block.body, block.maskedBody, 'variants');
                    if (varList.length > 0) {
                        featureVariants = varList;
                    }
                }

                const scope: ScopeContext = {
                    name,
                    kind,
                    startLine,
                    endLine,
                    startOffset,
                    endOffset,
                    declarations: new Map(),
                    ports: new Map(),
                    boundPorts: new Map(),
                    children: [],
                    arraySpec,
                    generatorVar,
                    generatorRange,
                    declMeta,
                    declType,
                    declDomain,
                    declDefaultVal,
                    declBoundBlock,
                    isAnonymous,
                    withCondition: withCond,
                    variants: featureVariants
                };

                if (generatorVar) {
                    scope.declarations.set(generatorVar, {
                        name: generatorVar,
                        kind: 'generator',
                        line: startLine,
                        signature: `${generatorVar} in ${generatorRange}`,
                        type: '_IntType',
                        meta: `Generator iteration variable \`${generatorVar}\` in range \`${generatorRange}\``,
                        generatorVar,
                        generatorRange
                    });
                }

                const ports = parsePortsFromBlock(block.body, startLine, block.maskedBody);
                for (const p of ports) {
                    scope.ports.set(p.portName, p);
                    if (p.nameField) scope.ports.set(p.nameField, p);
                    if (p.boundBlock) scope.boundPorts.set(p.boundBlock, p);
                }

                discoveredScopes.push(scope);
                enclosingDecls.push({
                    kind,
                    name,
                    start: startOffset,
                    end: endOffset,
                    line: startLine,
                    arraySpec,
                    generatorVar,
                    generatorRange
                });
                wordRegex.lastIndex = headerEnd;
                continue;
            }
        }
    }

    // Sort scopes by span size ascending so innermost scopes attach to the tightest enclosing parent
    discoveredScopes.sort((a, b) => (a.endOffset - a.startOffset) - (b.endOffset - b.startOffset));

    for (const scope of discoveredScopes) {
        let parentScope: ScopeContext = rootScope;
        for (const candidate of discoveredScopes) {
            if (candidate !== scope &&
                candidate.startOffset <= scope.startOffset &&
                candidate.endOffset >= scope.endOffset) {
                if (parentScope === rootScope ||
                    (candidate.endOffset - candidate.startOffset < parentScope.endOffset - parentScope.startOffset)) {
                    parentScope = candidate;
                }
            }
        }
        scope.parent = parentScope;
        parentScope.children.push(scope);
        if (scope.name && !scope.name.startsWith('[') && !scope.name.includes('_line')) {
            const declKey = scope.withCondition ? `${scope.name}#with_${scope.startLine}` : scope.name;
            const decl: ScopeDeclaration = {
                name: scope.name,
                kind: scope.kind,
                line: scope.startLine,
                signature: scope.withCondition ? `@with(${scope.withCondition}) ${scope.kind} ${scope.name}${scope.arraySpec ? `[${scope.arraySpec}]` : ''}` : `${scope.kind} ${scope.name}${scope.arraySpec ? `[${scope.arraySpec}]` : ''}`,
                type: scope.declType || scope.kind,
                domain: scope.declDomain,
                meta: scope.declMeta || `${scope.kind} declaration`,
                defaultVal: scope.declDefaultVal,
                boundBlock: scope.declBoundBlock,
                arraySpec: scope.arraySpec,
                generatorVar: scope.generatorVar,
                generatorRange: scope.generatorRange,
                withCondition: scope.withCondition,
                variants: scope.variants
            };
            if (parentScope.boundPorts.has(scope.name)) {
                decl.associatedPort = parentScope.boundPorts.get(scope.name);
            }
            if (!parentScope.declarations.has(scope.name)) {
                parentScope.declarations.set(scope.name, decl);
            }
            if (scope.withCondition) {
                parentScope.declarations.set(declKey, decl);
            }
        }
        if (scope.kind === 'feature' && scope.variants) {
            for (const v of scope.variants) {
                const varDecl: ScopeDeclaration = {
                    name: v,
                    kind: 'variant',
                    line: scope.startLine,
                    signature: `${scope.name}::${v}`,
                    type: 'variant',
                    meta: `Variant \`${v}\` of feature \`${scope.name}\``
                };
                scope.declarations.set(v, varDecl);
                parentScope.declarations.set(`${scope.name}::${v}`, varDecl);
            }
        }
    }

    // Add inputs and outputs from domain definitions to the enclosing parent scope (e.g. rootScope)
    const isDomainDef = (k: string) =>
        k === '_domainDefinition' || k === 'domainDefinition' ||
        k === '_domainDeclaration' || k === 'domainDeclaration' ||
        k === 'gameDefinition';

    for (const scope of discoveredScopes) {
        if (isDomainDef(scope.kind) && scope.parent) {
            for (const [dName, decl] of scope.declarations.entries()) {
                if (!scope.parent.declarations.has(dName)) {
                    scope.parent.declarations.set(dName, {
                        ...decl,
                        fromDomain: scope.name
                    });
                }
            }
            for (const [pName, port] of scope.ports.entries()) {
                if (!scope.parent.ports.has(pName)) {
                    scope.parent.ports.set(pName, port);
                }
            }
            for (const [bName, port] of scope.boundPorts.entries()) {
                if (!scope.parent.boundPorts.has(bName)) {
                    scope.parent.boundPorts.set(bName, port);
                }
            }
        }
    }

    rootScope.enclosingDecls = enclosingDecls;
    return rootScope;
}

function findScopeByName(root: ScopeContext, name: string): ScopeContext | undefined {
    if (root.name === name) return root;
    for (const child of root.children) {
        const found = findScopeByName(child, name);
        if (found) return found;
    }
    return undefined;
}

function buildScopeStack(rootScope: ScopeContext, targetLine: number): ScopeContext[] {
    const stack: ScopeContext[] = [rootScope];
    let current = rootScope;

    while (true) {
        let childFound = false;
        for (const child of current.children) {
            if (targetLine >= child.startLine && targetLine <= child.endLine) {
                stack.push(child);
                current = child;
                childFound = true;
                break;
            }
        }
        if (!childFound) break;
    }

    return stack;
}

function findDeclarationInScopeStack(name: string, scopeStack: ScopeContext[]): ScopeDeclaration | undefined {
    for (let i = scopeStack.length - 1; i >= 0; i--) {
        const scope = scopeStack[i];
        const decl = scope.declarations.get(name);
        if (decl) {
            return decl;
        }
        const port = scope.ports.get(name);
        if (port) {
            return {
                name: port.portName,
                kind: port.portType,
                line: port.line || scope.startLine,
                signature: `${port.portType} ${port.portName}`,
                meta: port.meta,
                boundBlock: port.boundBlock
            };
        }
    }
    return undefined;
}

let cachedLibraryFiles: string[] | undefined = undefined;
let cachedLibraryTypes: Map<string, TypeInfo> | undefined = undefined;
let cachedLibrarySymbols: Map<string, LibrarySymbol> | undefined = undefined;

function invalidateLibraryCache() {
    cachedLibraryFiles = undefined;
    cachedLibraryTypes = undefined;
    cachedLibrarySymbols = undefined;
    docCache.clear();
}

function getLibraryFiles(): string[] {
    if (cachedLibraryFiles) {
        return cachedLibraryFiles;
    }
    cachedLibraryFiles = findKnownLibraryFiles();
    return cachedLibraryFiles;
}

function getEffectiveStrideRoot(): string | undefined {
    const config = workspace.getConfiguration('stride');
    const configuredStrideroot = config.get<string>('strideroot');
    if (configuredStrideroot && fs.existsSync(configuredStrideroot)) {
        return configuredStrideroot;
    }

    if (process.env.STRIDEROOT && fs.existsSync(process.env.STRIDEROOT)) {
        return process.env.STRIDEROOT;
    }

    if (extensionContext) {
        const bundledRoot = extensionContext.asAbsolutePath('strideroot');
        if (fs.existsSync(bundledRoot)) {
            return bundledRoot;
        }
    }

    return undefined;
}

function getStrideRootDirs(): string[] {
    const rootDirs: string[] = [];
    const eff = getEffectiveStrideRoot();
    if (eff) {
        const lib = path.join(eff, 'library');
        if (fs.existsSync(lib)) {
            rootDirs.push(lib);
        }
        rootDirs.push(eff);
    }
    return rootDirs;
}

function findKnownLibraryFiles(): string[] {
    const files: string[] = [];
    const fileSet = new Set<string>();
    const rootDirs = getStrideRootDirs();

    const visitedDirs = new Set<string>();

    function scanDir(dir: string, depth = 0) {
        const normDir = path.normalize(dir).toLowerCase();
        if (depth > 6 || visitedDirs.has(normDir) || !fs.existsSync(dir)) return;
        visitedDirs.add(normDir);
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'build' && entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== 'out') {
                        scanDir(fullPath, depth + 1);
                    }
                } else if (entry.isFile() && entry.name.endsWith('.stride')) {
                    if (!fileSet.has(fullPath)) {
                        fileSet.add(fullPath);
                        files.push(fullPath);
                    }
                }
            }
        } catch (e) {}
    }

    for (const d of rootDirs) {
        scanDir(d);
    }

    return files;
}

function formatClickableLink(filePath: string, line: number = 1): string {
    const normPath = filePath.replace(/\\/g, '/');
    const fileName = path.basename(filePath);
    return `[${fileName}:${line}](file:///${normPath}#L${line})`;
}

function parsePortsFromBlock(blockBody: string, baseLine: number = 1, preMaskedBody?: string): PortInfo[] {
    const maskedBody = preMaskedBody || maskCommentsAndStrings(blockBody);
    const ports: PortInfo[] = [];
    const portHeaderRegex = /\b(mainInputPort|mainOutputPort|propertyInputPort|propertyOutputPort|port)\s+([_a-zA-Z0-9]+)(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?\s*(?=\{)/g;
    let match;

    while ((match = portHeaderRegex.exec(maskedBody)) !== null) {
        const portType = match[1];
        const portName = match[2];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(blockBody, headerEnd, maskedBody);
        if (!block) continue;
        const pBody = block.body;

        let pLine = baseLine;
        for (let i = 0; i < match.index; i++) {
            if (blockBody[i] === '\n') pLine++;
        }

        const blockMatch = /(?:block|entity)\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);
        const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const typeMatch = /type\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);
        const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);

        let portTypeSpec = typeMatch ? typeMatch[1] : undefined;
        if (!portTypeSpec) {
            const typesMatch = /types\s*:\s*\[([^\]]*)\]/.exec(pBody);
            if (typesMatch) {
                portTypeSpec = typesMatch[1].trim();
            }
        }
        let portMeta = metaMatch ? metaMatch[1] : undefined;

        if (blockMatch) {
            const boundName = blockMatch[1];
            const blockDeclRegex = new RegExp(`\\b([_a-zA-Z0-9]+)\\s+${boundName}\\b[^{]*\\{([^{}]*)\\}`, 'g');
            const bDeclMatch = blockDeclRegex.exec(blockBody);
            if (bDeclMatch) {
                const bKind = bDeclMatch[1];
                const bInner = bDeclMatch[2];
                if (!portTypeSpec) {
                    const bTypeMatch = /type\s*:\s*([_a-zA-Z0-9]+)/.exec(bInner);
                    if (bTypeMatch) {
                        portTypeSpec = bTypeMatch[1];
                    } else if (bKind === 'switch') {
                        portTypeSpec = '_SwitchType';
                    }
                }
                if (!portMeta) {
                    const bMetaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(bInner);
                    if (bMetaMatch) {
                        portMeta = bMetaMatch[1];
                    }
                }
            }
        }

        ports.push({
            portType,
            portName,
            boundBlock: blockMatch ? blockMatch[1] : undefined,
            nameField: nameMatch ? nameMatch[1] : undefined,
            meta: portMeta,
            types: portTypeSpec,
            defaultVal: defMatch ? defMatch[1].trim() : undefined,
            line: pLine
        });
    }
    return ports;
}

function parseLibrarySymbols(text: string, filePath: string, preMaskedText?: string): LibrarySymbol[] {
    const maskedText = preMaskedText || maskCommentsAndStrings(text);
    const symbols: LibrarySymbol[] = [];
    const ignoredKinds = new Set(['import', 'use', 'version', 'streamRate', 'type', 'typeProperty', 'constrainedList']);
    const wordRegex = /\b([_a-zA-Z0-9]+)\b/g;
    let wMatch;

    while ((wMatch = wordRegex.exec(maskedText)) !== null) {
        const word = wMatch[1];
        const idx = wMatch.index;
        if (ignoredKinds.has(word)) continue;
        const afterWord = maskedText.substring(idx + word.length).trimStart();
        if (afterWord.startsWith(':') && !afterWord.startsWith('::')) continue;

        let line = 1;
        for (let i = 0; i < idx; i++) {
            if (text[i] === '\n') line++;
        }

        if (word === 'module' || word === 'reaction' || word === 'loop') {
            const callableInfo = findCallableBodyStart(maskedText, idx + word.length);
            if (callableInfo) {
                const parsedHeader = parseCallableHeader(word, callableInfo.headerStr);
                const block = extractBraceBlock(text, callableInfo.bodyStart, maskedText);
                if (block && parsedHeader.callableName) {
                    const name = parsedHeader.callableName;
                    const meta = extractTopLevelField(block.body, block.maskedBody, 'meta') ||
                                 extractTopLevelField(block.body, block.maskedBody, 'details');
                    const ports = parsePortsFromBlock(block.body, line, block.maskedBody);

                    // Add synthesized header ports
                    const addLibPort = (p: CallablePortSpec, portType: 'mainInputPort' | 'propertyInputPort' | 'mainOutputPort') => {
                        ports.push({
                            portType,
                            portName: synthesizePortName(p.entityName),
                            boundBlock: p.entityName,
                            nameField: p.propName,
                            defaultVal: p.defaultValue || p.properties?.get('default'),
                            types: p.properties?.get('type'),
                            line
                        });
                    };
                    for (const inp of parsedHeader.mainInputs) addLibPort(inp, 'mainInputPort');
                    for (const prop of parsedHeader.propertyPorts) addLibPort(prop, 'propertyInputPort');
                    for (const out of parsedHeader.mainOutputs) addLibPort(out, 'mainOutputPort');

                    symbols.push({
                        name,
                        kind: word,
                        filePath,
                        line,
                        signature: `${word} ${callableInfo.headerStr.trim().replace(/\s+/g, ' ')}`,
                        ports: ports.length ? ports : undefined,
                        meta
                    });
                    wordRegex.lastIndex = callableInfo.bodyStart;
                    continue;
                }
            }
        }

        const stdRegex = /^([_a-zA-Z0-9]+)\s+([_a-zA-Z0-9]+)(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:@\s*[_a-zA-Z0-9]+)?\s*(?=\{)/;
        const sub = maskedText.substring(idx);
        const stdMatch = stdRegex.exec(sub);
        if (stdMatch && stdMatch[1] === word) {
            const kind = stdMatch[1];
            const name = stdMatch[2];
            const bracketContent = stdMatch[3] ? stdMatch[3].trim() : undefined;
            const headerEnd = idx + stdMatch[0].length;
            const block = extractBraceBlock(text, headerEnd, maskedText);
            if (block) {
                const body = block.body;

                let generatorVar: string | undefined;
                let generatorRange: string | undefined;
                let arraySpec: string | undefined;

                if (bracketContent !== undefined) {
                    const genMatch = /^\s*([_a-zA-Z0-9]+)\s+in\s+(.+)$/.exec(bracketContent);
                    if (genMatch) {
                        generatorVar = genMatch[1];
                        generatorRange = genMatch[2].trim();
                    } else {
                        arraySpec = bracketContent;
                    }
                }

                const meta = extractTopLevelField(body, block.maskedBody, 'meta') ||
                             extractTopLevelField(body, block.maskedBody, 'details');

                const ports = parsePortsFromBlock(body, line, block.maskedBody);
                const processing = extractTopLevelField(body, block.maskedBody, 'processing');
                const inherits = extractTopLevelList(body, block.maskedBody, 'inherits');
                const inputs = extractTopLevelList(body, block.maskedBody, 'inputs');
                const outputs = extractTopLevelList(body, block.maskedBody, 'outputs');
                const targetBlock = (kind === 'alias') ? extractTopLevelField(body, block.maskedBody, 'entity') : undefined;

                let sig = `${kind} ${name}`;
                if (bracketContent !== undefined) {
                    sig += `[${bracketContent}]`;
                }

                symbols.push({
                    name,
                    kind,
                    filePath,
                    line,
                    signature: sig,
                    ports: ports.length ? ports : undefined,
                    meta,
                    inherits: inherits.length ? inherits : undefined,
                    inputs: inputs.length ? inputs : undefined,
                    outputs: outputs.length ? outputs : undefined,
                    processing,
                    targetBlock,
                    arraySpec,
                    generatorVar,
                    generatorRange
                });

                const isDomain = kind === '_domainDefinition' || kind === 'domainDefinition' ||
                                 kind === '_domainDeclaration' || kind === 'domainDeclaration' ||
                                 kind === 'gameDefinition';
                if (isDomain) {
                    const domainDecls = parseDeclarationsFromBlock(body, line, filePath);
                    for (const d of domainDecls) {
                        if (!symbols.some(s => s.name === d.name)) {
                            symbols.push({
                                name: d.name,
                                kind: d.kind,
                                filePath,
                                line: d.line,
                                signature: d.signature,
                                meta: d.meta,
                                arraySpec: d.arraySpec
                            });
                        }
                    }
                }

                wordRegex.lastIndex = headerEnd;
                continue;
            }
        }
    }

    return symbols;
}

function parseTypesFromText(text: string, filePath?: string, preMaskedText?: string): TypeInfo[] {
    const maskedText = preMaskedText || maskCommentsAndStrings(text);
    const types: TypeInfo[] = [];
    const typeHeaderRegex = /\btype\s+(_*[a-zA-Z0-9_]+)\s*(?=\{)/g;
    let match;

    while ((match = typeHeaderRegex.exec(maskedText)) !== null) {
        const typeDeclName = match[1];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(text, headerEnd, maskedText);
        if (!block) continue;

        const body = block.body;
        const maskedBody = block.maskedBody;

        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (text[i] === '\n') line++;
        }

        const typeName = extractTopLevelField(body, maskedBody, 'typeName');
        const inherits = extractTopLevelList(body, maskedBody, 'inherits');
        const meta = extractTopLevelField(body, maskedBody, 'meta') ||
                     extractTopLevelField(body, maskedBody, 'details');

        const properties: PropertyInfo[] = [];
        const propHeaderRegex = /typeProperty\s*(?:([_a-zA-Z0-9]+)\s*)?(?=\{)/g;
        let pMatch;
        while ((pMatch = propHeaderRegex.exec(maskedBody)) !== null) {
            const explicitName = pMatch[1];
            const pHeaderEnd = pMatch.index + pMatch[0].length;
            const pBlock = extractBraceBlock(body, pHeaderEnd, maskedBody);
            if (!pBlock) continue;
            const pBody = pBlock.body;

            let pLine = line;
            for (let i = 0; i < pMatch.index; i++) {
                if (body[i] === '\n') pLine++;
            }

            const nameMatch = /name\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(pBody);
            const propName = (nameMatch ? (nameMatch[1] || nameMatch[2]) : undefined) || explicitName || 'property';

            const typesMatch = /(?:allowedTypes|types|type)\s*:\s*(?:constrained(?:List|Entity)\s*\{\s*allowed\s*:\s*\[([^\]]*)\]\s*\}|\[([^\]]*)\]|([_a-zA-Z0-9]+))/.exec(pBody);
            const propTypes: string[] = [];
            if (typesMatch) {
                const rawList = typesMatch[1] || typesMatch[2];
                if (rawList) {
                    const rawT = rawList.split(',');
                    for (let rt of rawT) {
                        rt = rt.trim().replace(/\{[^}]*\}/g, '').trim();
                        if (rt) propTypes.push(rt);
                    }
                } else if (typesMatch[3]) {
                    propTypes.push(typesMatch[3].trim());
                }
            }

            const reqMatch = /required\s*:\s*(on|off|true|false)/.exec(pBody);
            const isReq = reqMatch ? (reqMatch[1] === 'on' || reqMatch[1] === 'true') : false;

            const pubMatch = /public\s*:\s*(on|off|true|false)/.exec(pBody);
            const isPublic = pubMatch ? (pubMatch[1] === 'on' || pubMatch[1] === 'true') : true;

            const writeMatch = /writeable\s*:\s*(on|off|true|false)/.exec(pBody);
            const isWriteable = writeMatch ? (writeMatch[1] === 'on' || writeMatch[1] === 'true') : true;

            const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);
            const defVal = defMatch ? defMatch[1].trim() : undefined;

            const pMetaMatch = /meta\s*:\s*["']([^"']+)["']/.exec(pBody);
            const pMeta = pMetaMatch ? pMetaMatch[1] : undefined;

            properties.push({
                name: propName,
                types: propTypes.length ? propTypes : undefined,
                required: isReq,
                public: isPublic,
                writeable: isWriteable,
                defaultValue: defVal,
                meta: pMeta,
                filePath,
                line: pLine
            });
        }

        types.push({
            name: typeDeclName,
            typeName,
            filePath,
            line,
            inherits,
            properties,
            meta
        });
    }

    return types;
}

function syncGrammarWithLibrary(standardLibTypes: Set<string>): void {
    if (!extensionContext) return;
    try {
        const grammarPath = extensionContext.asAbsolutePath(path.join('syntaxes', 'stride.tmLanguage.json'));
        if (!fs.existsSync(grammarPath)) return;
        const content = fs.readFileSync(grammarPath, 'utf8');
        const grammar = JSON.parse(content);
        if (grammar.repository && grammar.repository['builtin-types'] && grammar.repository['builtin-types'].patterns && grammar.repository['builtin-types'].patterns[0]) {
            const sortedTypes = Array.from(standardLibTypes).filter(t => /^(_[A-Z]|[A-Z])[a-zA-Z0-9_]*$/.test(t)).sort();
            if (sortedTypes.length === 0) return;
            const newRegex = `\\b(${sortedTypes.join('|')})\\b`;
            if (grammar.repository['builtin-types'].patterns[0].match !== newRegex) {
                grammar.repository['builtin-types'].patterns[0].match = newRegex;
                fs.writeFileSync(grammarPath, JSON.stringify(grammar, null, '\t') + '\n', 'utf8');
            }
        }
    } catch (e) {}
}

function getLibraryTypes(): Map<string, TypeInfo> {
    if (cachedLibraryTypes) {
        return cachedLibraryTypes;
    }
    const typeMap = new Map<string, TypeInfo>();
    const standardLibTypes = new Set<string>(Object.keys(BUILTIN_SCALARS));

    for (const schemaPath of getLibraryFiles()) {
        try {
            const content = fs.readFileSync(schemaPath, 'utf8');
            const parsed = parseTypesFromText(content, schemaPath);
            const isStandardLib = schemaPath.includes('strideroot') || schemaPath.includes('library');
            const isBundledLib = extensionContext && schemaPath.startsWith(extensionContext.extensionPath);
            for (const t of parsed) {
                if (isStandardLib) {
                    standardLibTypes.add(t.name);
                    if (t.typeName) standardLibTypes.add(t.typeName);
                }
                const existing = typeMap.get(t.name) || (t.typeName ? typeMap.get(t.typeName) : undefined);
                // Bundled fallback definitions must never override any existing definitions
                if (existing && isBundledLib) {
                    continue;
                }
                // Never overwrite a richer standard library definition with a less complete stub
                if (existing && !isStandardLib && existing.properties.length > t.properties.length) {
                    continue;
                }
                if (existing && (!t.properties || t.properties.length === 0)) {
                    t.properties = existing.properties;
                }
                if (existing && !t.meta && existing.meta) {
                    t.meta = existing.meta;
                }
                typeMap.set(t.name, t);
                if (t.typeName) {
                    typeMap.set(t.typeName, t);
                }
            }
        } catch (e) {}
    }

    for (const [alias, target] of Object.entries(TYPE_ALIASES)) {
        if (typeMap.has(target)) {
            typeMap.set(alias, typeMap.get(target)!);
        }
    }

    syncGrammarWithLibrary(standardLibTypes);
    cachedLibraryTypes = typeMap;
    return typeMap;
}

function getStrideFileContent(filePath: string): string | null {
    try {
        const norm = path.normalize(filePath);
        const openDoc = workspace.textDocuments.find(d => path.normalize(d.uri.fsPath) === norm);
        if (openDoc) {
            return openDoc.getText();
        }
        if (fs.existsSync(norm)) {
            return fs.readFileSync(norm, 'utf8');
        }
    } catch (e) {}
    return null;
}

function resolveImportFile(importTarget: string, documentOrPath: TextDocument | string): string | undefined {
    const cleanTarget = importTarget.replace(/['"]/g, '').trim();
    if (!cleanTarget) return undefined;

    // Check if cleanTarget is an absolute path that exists
    if (path.isAbsolute(cleanTarget)) {
        if (fs.existsSync(cleanTarget) && fs.statSync(cleanTarget).isFile()) return cleanTarget;
        if (fs.existsSync(cleanTarget + '.stride') && fs.statSync(cleanTarget + '.stride').isFile()) return cleanTarget + '.stride';
    }

    const currentPath = typeof documentOrPath === 'string'
        ? path.normalize(documentOrPath)
        : (documentOrPath.uri && documentOrPath.uri.scheme === 'file' && documentOrPath.uri.fsPath)
            ? path.normalize(documentOrPath.uri.fsPath)
            : undefined;
    const docDir = currentPath ? path.dirname(currentPath) : undefined;
    const subPath = cleanTarget.replace(/\./g, path.sep);

    if (docDir) {
        // 1. Direct match in current directory
        const candidates = [
            path.normalize(path.join(docDir, `${cleanTarget}.stride`)),
            path.normalize(path.join(docDir, cleanTarget)),
            path.normalize(path.join(docDir, cleanTarget, `${cleanTarget}.stride`)),
            path.normalize(path.join(docDir, `${subPath}.stride`)),
            path.normalize(path.join(docDir, subPath, `${path.basename(subPath)}.stride`))
        ];

        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch (e) {}
        }

        // 2. Immediate subdirectories of current directory
        try {
            const entries = fs.readdirSync(docDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== 'build' && entry.name !== 'out') {
                    const subDir = path.join(docDir, entry.name);
                    const subCandidates = [
                        path.normalize(path.join(subDir, `${cleanTarget}.stride`)),
                        path.normalize(path.join(subDir, cleanTarget)),
                        path.normalize(path.join(subDir, cleanTarget, `${cleanTarget}.stride`)),
                        path.normalize(path.join(subDir, `${subPath}.stride`))
                    ];
                    for (const candidate of subCandidates) {
                        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                            return candidate;
                        }
                    }
                }
            }
        } catch (e) {}
    }

    // 3. Workspace folders
    if (workspace.workspaceFolders) {
        for (const wf of workspace.workspaceFolders) {
            const wfDir = wf.uri.fsPath;
            const wfCandidates = [
                path.normalize(path.join(wfDir, `${cleanTarget}.stride`)),
                path.normalize(path.join(wfDir, cleanTarget)),
                path.normalize(path.join(wfDir, cleanTarget, `${cleanTarget}.stride`)),
                path.normalize(path.join(wfDir, `${subPath}.stride`))
            ];
            for (const candidate of wfCandidates) {
                try {
                    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                        return candidate;
                    }
                } catch (e) {}
            }
        }
    }

    // 4. Check indexed library files from getLibraryFiles()
    const libFiles = getLibraryFiles();
    const targetBase = path.basename(cleanTarget, '.stride').toLowerCase();
    for (const libPath of libFiles) {
        const fileBase = path.basename(libPath, '.stride').toLowerCase();
        if (fileBase === targetBase) {
            return libPath;
        }
    }

    const normalizedSubPath = subPath.toLowerCase() + '.stride';
    for (const libPath of libFiles) {
        if (path.normalize(libPath).toLowerCase().endsWith(normalizedSubPath)) {
            return libPath;
        }
    }

    // 5. Check all Stride root directories
    for (const rootDir of getStrideRootDirs()) {
        const rootCandidates = [
            path.normalize(path.join(rootDir, `${cleanTarget}.stride`)),
            path.normalize(path.join(rootDir, cleanTarget)),
            path.normalize(path.join(rootDir, cleanTarget, `${cleanTarget}.stride`)),
            path.normalize(path.join(rootDir, `${subPath}.stride`)),
            path.normalize(path.join(rootDir, 'library', `${cleanTarget}.stride`)),
            path.normalize(path.join(rootDir, 'library', '1.0', `${cleanTarget}.stride`)),
            path.normalize(path.join(rootDir, 'library', `${subPath}.stride`)),
            path.normalize(path.join(rootDir, 'library', '1.0', `${subPath}.stride`))
        ];
        for (const candidate of rootCandidates) {
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            } catch (e) {}
        }
    }

    return undefined;
}

function getRelatedStrideFiles(document: TextDocument): string[] {
    const relatedFiles = new Set<string>();
    if (!document.uri || document.uri.scheme !== 'file' || !document.uri.fsPath) {
        return [];
    }
    const currentPath = path.normalize(document.uri.fsPath);
    const docDir = path.dirname(currentPath);

    // 1. Sibling .stride files in the current directory
    try {
        if (fs.existsSync(docDir)) {
            const entries = fs.readdirSync(docDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.stride')) {
                    const fullPath = path.normalize(path.join(docDir, entry.name));
                    if (fullPath !== currentPath) {
                        relatedFiles.add(fullPath);
                    }
                }
            }
        }
    } catch (e) {}

    // 2. Explicitly imported modules: `import <ModuleName>` (with transitive resolution)
    const queue: string[] = [currentPath, ...relatedFiles];
    const visited = new Set<string>([currentPath]);

    while (queue.length > 0) {
        const filePath = queue.shift()!;
        if (visited.has(filePath) && filePath !== currentPath) continue;
        visited.add(filePath);

        try {
            const content = getStrideFileContent(filePath);
            if (!content) continue;
            const importRegex = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9.]+))/gm;
            let impMatch;
            while ((impMatch = importRegex.exec(content)) !== null) {
                const modName = impMatch[2] || impMatch[3];
                if (!modName) continue;
                const candidate = resolveImportFile(modName, filePath);
                if (candidate && candidate !== currentPath && !relatedFiles.has(candidate)) {
                    relatedFiles.add(candidate);
                    queue.push(candidate);
                }
            }
        } catch (e) {}
    }

    return Array.from(relatedFiles);
}

function resolveImportPaths(target: string, documentOrPath: TextDocument | string): string[] {
    const cleanTarget = target.replace(/['"]/g, '').trim();
    if (!cleanTarget) return [];
    const results = new Set<string>();

    // 1. Single file match from resolveImportFile
    const singleFile = resolveImportFile(cleanTarget, documentOrPath);
    if (singleFile) {
        results.add(path.normalize(singleFile));
    }

    // 2. Check if cleanTarget is a directory or package in docDir, workspace folders, or Stride roots
    const currentPath = typeof documentOrPath === 'string'
        ? path.normalize(documentOrPath)
        : (documentOrPath.uri && documentOrPath.uri.scheme === 'file' && documentOrPath.uri.fsPath)
            ? path.normalize(documentOrPath.uri.fsPath)
            : undefined;
    const docDir = currentPath ? path.dirname(currentPath) : undefined;
    const subPath = cleanTarget.replace(/\./g, path.sep);

    const checkDirForStrideFiles = (dir: string) => {
        try {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.stride')) {
                        results.add(path.normalize(path.join(dir, entry.name)));
                    }
                }
            }
        } catch (e) {}
    };

    if (docDir) {
        checkDirForStrideFiles(path.join(docDir, cleanTarget));
        checkDirForStrideFiles(path.join(docDir, subPath));
    }

    if (workspace.workspaceFolders) {
        for (const wf of workspace.workspaceFolders) {
            checkDirForStrideFiles(path.join(wf.uri.fsPath, cleanTarget));
            checkDirForStrideFiles(path.join(wf.uri.fsPath, subPath));
        }
    }

    for (const rootDir of getStrideRootDirs()) {
        checkDirForStrideFiles(path.join(rootDir, cleanTarget));
        checkDirForStrideFiles(path.join(rootDir, subPath));
        checkDirForStrideFiles(path.join(rootDir, 'library', cleanTarget));
        checkDirForStrideFiles(path.join(rootDir, 'library', '1.0', cleanTarget));
        checkDirForStrideFiles(path.join(rootDir, 'library', subPath));
        checkDirForStrideFiles(path.join(rootDir, 'library', '1.0', subPath));
    }

    // 3. Check indexed library files for package prefix
    const libFiles = getLibraryFiles();
    const targetLower = cleanTarget.toLowerCase();
    for (const libPath of libFiles) {
        const norm = path.normalize(libPath).toLowerCase();
        if (norm.includes(path.sep + targetLower + path.sep)) {
            results.add(path.normalize(libPath));
        }
    }

    return Array.from(results);
}

interface NamespaceInfo {
    name: string;
    kind: 'import' | 'feature' | 'domain' | 'module';
    importTarget?: string;
    targetFiles: string[];
    importLine?: number;
    featureDecl?: ScopeDeclaration;
    featureVariants?: string[];
    domainDecl?: ScopeDeclaration;
}

function resolveNamespace(nsName: string, document: TextDocument): NamespaceInfo | undefined {
    const text = document.getText();
    const lines = text.split(/\r?\n/);

    // 1. Check for `import ... as <nsName>` or `use ... as <nsName>` in current document
    const aliasRegex = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9./\\]+))(?:\s+version\s+[^as\n\r]+)?\s+as\s+([_a-zA-Z0-9]+)\b/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = aliasRegex.exec(line);
        if (m && m[4] === nsName) {
            const impTarget = m[2] || m[3];
            const files = resolveImportPaths(impTarget, document);
            return {
                name: nsName,
                kind: 'import',
                importTarget: impTarget,
                targetFiles: files,
                importLine: i + 1
            };
        }
    }

    // 2. Check for direct `import <nsName>` or `use <nsName>`
    const directRegex = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9./\\]+))/;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = directRegex.exec(line);
        if (m) {
            const impTarget = m[2] || m[3];
            const baseTarget = path.basename(impTarget, '.stride');
            if (baseTarget.toLowerCase() === nsName.toLowerCase() || impTarget.toLowerCase() === nsName.toLowerCase()) {
                const files = resolveImportPaths(impTarget, document);
                return {
                    name: nsName,
                    kind: 'import',
                    importTarget: impTarget,
                    targetFiles: files,
                    importLine: i + 1
                };
            }
        }
    }

    // 3. Check if nsName is a `feature` declared in the document or related files
    const { scopeTree: rootScope } = getCachedDocData(document);
    for (const [name, decl] of rootScope.declarations.entries()) {
        if (name === nsName && decl.kind === 'feature') {
            return {
                name: nsName,
                kind: 'feature',
                targetFiles: [],
                featureDecl: decl,
                featureVariants: decl.variants || []
            };
        }
    }

    // 4. Check if nsName is a domain or module in rootScope
    if (rootScope.declarations.has(nsName)) {
        const decl = rootScope.declarations.get(nsName)!;
        if (decl.kind.includes('domain') || decl.kind === 'module') {
            return {
                name: nsName,
                kind: decl.kind.includes('domain') ? 'domain' : 'module',
                targetFiles: [],
                domainDecl: decl
            };
        }
    }

    // 5. Check if nsName matches an available library or workspace module/package directly
    const directFiles = resolveImportPaths(nsName, document);
    if (directFiles.length > 0) {
        return {
            name: nsName,
            kind: 'import',
            importTarget: nsName,
            targetFiles: directFiles
        };
    }

    return undefined;
}

function getNamespaceCompletions(document: TextDocument, nsName: string, memberPrefix: string): CompletionItem[] | undefined {
    const nsInfo = resolveNamespace(nsName, document);
    if (!nsInfo) return undefined;

    const items: CompletionItem[] = [];
    const seen = new Set<string>();

    const addComp = (label: string, kind: CompletionItemKind, detail?: string, doc?: string) => {
        if (!label || seen.has(label)) return;
        seen.add(label);
        const item = new CompletionItem(label, kind);
        if (detail) item.detail = detail;
        if (doc) item.documentation = new MarkdownString(doc);
        items.push(item);
    };

    if (nsInfo.kind === 'feature' && nsInfo.featureVariants) {
        for (const v of nsInfo.featureVariants) {
            addComp(v, CompletionItemKind.EnumMember, `Variant of feature \`${nsName}\``, `Feature variant \`${nsName}::${v}\``);
        }
        return items;
    }

    if (nsInfo.kind === 'domain' && nsInfo.domainDecl) {
        const decl = nsInfo.domainDecl;
        if (decl.body) {
            const innerDecls = parseDeclarationsFromBlock(decl.body, decl.line, document.uri.fsPath);
            for (const d of innerDecls) {
                let k = CompletionItemKind.Variable;
                if (d.kind.includes('Port') || d.kind === 'port') k = CompletionItemKind.Interface;
                addComp(d.name, k, `${d.signature} (${nsName})`, d.meta);
            }
        }
        return items;
    }

    if (nsInfo.targetFiles && nsInfo.targetFiles.length > 0) {
        for (const f of nsInfo.targetFiles) {
            const content = getStrideFileContent(f);
            if (!content) continue;
            const baseName = path.basename(f);

            // 1. Declarations from scope tree
            const scope = parseScopeTree(content, f);
            for (const [dName, decl] of scope.declarations.entries()) {
                let k = CompletionItemKind.Variable;
                if (decl.kind === 'module' || decl.kind === 'reaction' || decl.kind === 'loop') k = CompletionItemKind.Function;
                else if (decl.kind === 'constant') k = CompletionItemKind.Constant;
                else if (decl.kind === 'state' || decl.kind === 'transition') k = CompletionItemKind.Struct;
                else if (decl.kind === 'type' || decl.kind.includes('domain')) k = CompletionItemKind.Class;
                else if (decl.kind.includes('Port') || decl.kind === 'port') k = CompletionItemKind.Interface;
                else if (decl.kind === 'variant') k = CompletionItemKind.EnumMember;
                addComp(dName, k, `${decl.signature} (${baseName})`, decl.meta);
            }

            // 2. Library symbols
            const symbols = parseLibrarySymbols(content, f);
            for (const sym of symbols) {
                let k = CompletionItemKind.Function;
                if (sym.kind === 'signal' || sym.kind === 'switch' || sym.kind === 'trigger') k = CompletionItemKind.Variable;
                else if (sym.kind === 'constant') k = CompletionItemKind.Constant;
                else if (sym.kind === 'state' || sym.kind === 'transition') k = CompletionItemKind.Struct;
                addComp(sym.name, k, `${sym.signature} (${baseName})`, sym.meta);
            }

            // 3. Types
            const types = parseTypesFromText(content, f);
            for (const t of types) {
                addComp(t.name, CompletionItemKind.Class, `Type ${t.name} (${baseName})`, t.meta);
            }
        }
        return items;
    }

    return items.length > 0 ? items : undefined;
}

function getImportCompletions(document: TextDocument, linePrefix: string, match: RegExpExecArray): CompletionItem[] {
    const items: CompletionItem[] = [];
    const seen = new Set<string>();

    const addModule = (modName: string, detail: string, filePath?: string, isFile?: boolean) => {
        if (!modName || seen.has(modName)) return;
        seen.add(modName);
        const item = new CompletionItem(modName, isFile ? CompletionItemKind.File : CompletionItemKind.Module);
        item.detail = detail;
        if (filePath && fs.existsSync(filePath)) {
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    const content = fs.readFileSync(filePath, 'utf8').substring(0, 500);
                    const metaMatch = /meta:\s*["']([^"']+)["']/.exec(content);
                    if (metaMatch) {
                        item.documentation = new MarkdownString(metaMatch[1]);
                    } else {
                        item.documentation = new MarkdownString(`File: \`${path.basename(filePath)}\``);
                    }
                }
            } catch (e) {}
        }
        items.push(item);
    };

    // 1. Standard Library Modules & Packages
    for (const libPath of getLibraryFiles()) {
        const baseName = path.basename(libPath, '.stride');
        addModule(baseName, 'Stride Standard Library', libPath);

        // Check package directory relative to library root
        for (const rootDir of getStrideRootDirs()) {
            const rel = path.relative(path.join(rootDir, 'library', '1.0'), libPath);
            if (!rel.startsWith('..') && rel.includes(path.sep)) {
                const pkgPath = rel.replace(/\\/g, '/').replace(/\.stride$/, '');
                addModule(pkgPath, 'Stride Standard Library Package', libPath, true);
            }
        }
    }

    // 2. Local sibling files and subdirectories
    if (document.uri && document.uri.scheme === 'file') {
        const docDir = path.dirname(document.uri.fsPath);
        try {
            if (fs.existsSync(docDir)) {
                const entries = fs.readdirSync(docDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile() && entry.name.endsWith('.stride') && path.join(docDir, entry.name) !== document.uri.fsPath) {
                        const bName = path.basename(entry.name, '.stride');
                        addModule(bName, 'Local Module', path.join(docDir, entry.name));
                    } else if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== 'build' && entry.name !== 'out') {
                        const subDir = path.join(docDir, entry.name);
                        try {
                            const subEntries = fs.readdirSync(subDir, { withFileTypes: true });
                            for (const sub of subEntries) {
                                if (sub.isFile() && sub.name.endsWith('.stride')) {
                                    const subRel = `${entry.name}/${path.basename(sub.name, '.stride')}`;
                                    addModule(subRel, 'Local Subdirectory Module', path.join(subDir, sub.name), true);
                                }
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (e) {}
    }

    // 3. Workspace folders
    if (workspace.workspaceFolders) {
        for (const wf of workspace.workspaceFolders) {
            const wfDir = wf.uri.fsPath;
            try {
                if (fs.existsSync(wfDir)) {
                    const entries = fs.readdirSync(wfDir, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isFile() && entry.name.endsWith('.stride')) {
                            const bName = path.basename(entry.name, '.stride');
                            addModule(bName, 'Workspace Module', path.join(wfDir, entry.name));
                        }
                    }
                }
            } catch (e) {}
        }
    }

    // 4. Built-in platform / domain modules commonly used in `use` statements
    const platformModules = ['DesktopAudio', 'RtAudio', 'PufferFish', 'Gamma'];
    for (const pm of platformModules) {
        addModule(pm, 'Stride Platform / Domain Framework');
    }

    return items;
}

function buildAllTypes(document: TextDocument, preMaskedText?: string): Map<string, TypeInfo> {
    const baseTypes = getLibraryTypes();
    const typeMap = new Map<string, TypeInfo>(baseTypes);

    const relatedFiles = getRelatedStrideFiles(document);
    for (const relPath of relatedFiles) {
        try {
            const content = getStrideFileContent(relPath);
            if (content) {
                const parsed = parseTypesFromText(content, relPath);
                for (const t of parsed) {
                    typeMap.set(t.name, t);
                    if (t.typeName) {
                        typeMap.set(t.typeName, t);
                    }
                }
            }
        } catch (e) {}
    }

    try {
        const text = document.getText();
        const docParsed = parseTypesFromText(text, document.uri.fsPath, preMaskedText);
        for (const t of docParsed) {
            typeMap.set(t.name, t);
            if (t.typeName) {
                typeMap.set(t.typeName, t);
            }
        }
    } catch (e) {}

    for (const [alias, target] of Object.entries(TYPE_ALIASES)) {
        if (typeMap.has(target)) {
            typeMap.set(alias, typeMap.get(target)!);
        }
    }

    return typeMap;
}

function getAllTypes(document: TextDocument): Map<string, TypeInfo> {
    return getCachedDocData(document).allTypes;
}

function resolveAllPropertiesForType(kind: string, allTypes: Map<string, TypeInfo>): Map<string, PropertyInfo> {
    const targetKind = TYPE_ALIASES[kind] || kind;
    const typeInfo = allTypes.get(kind) || allTypes.get(targetKind);
    const propMap = new Map<string, PropertyInfo>();
    if (!typeInfo) return propMap;

    for (const p of typeInfo.properties || []) {
        propMap.set(p.name, p);
    }

    const visited = new Set<string>();
    const queue = [...(typeInfo.inherits || [])];
    while (queue.length > 0) {
        const parentName = queue.shift()!;
        if (visited.has(parentName)) continue;
        visited.add(parentName);
        const parentTarget = TYPE_ALIASES[parentName] || parentName;
        const parent = allTypes.get(parentName) || allTypes.get(parentTarget);
        if (parent) {
            for (const p of parent.properties || []) {
                if (!propMap.has(p.name)) {
                    propMap.set(p.name, p);
                }
            }
            if (parent.inherits) {
                queue.push(...parent.inherits);
            }
        }
    }

    if (targetKind === '_Module' || targetKind === '_Reaction' || targetKind === '_Loop' || targetKind === '_CodeGenerator') {
        if (!propMap.has('code')) propMap.set('code', { name: 'code', types: ['_List'], public: true, writeable: true });
        if (!propMap.has('entities')) propMap.set('entities', { name: 'entities', types: ['_List'], public: true, writeable: true });
    }
    if (targetKind === '_Loop') {
        if (!propMap.has('until')) propMap.set('until', { name: 'until', types: ['_Switch', '_Signal'], public: true, writeable: true });
        if (!propMap.has('maxIterations')) propMap.set('maxIterations', { name: 'maxIterations', types: ['_IntLiteral'], public: true, writeable: true });
        if (!propMap.has('iterator')) propMap.set('iterator', { name: 'iterator', types: ['_Signal'], public: true, writeable: true });
    }
    if (targetKind === '_Port' || targetKind === '_MainInputPort' || targetKind === '_MainOutputPort' || targetKind === '_PropertyInputPort' || targetKind === '_PropertyOutputPort') {
        if (!propMap.has('entity')) propMap.set('entity', { name: 'entity', types: ['_Block'], public: true, writeable: true });
    }

    return propMap;
}

function getLibrarySymbols(): Map<string, LibrarySymbol> {
    if (cachedLibrarySymbols) {
        return cachedLibrarySymbols;
    }
    const symbolMap = new Map<string, LibrarySymbol>();

    for (const libPath of getLibraryFiles()) {
        try {
            const content = fs.readFileSync(libPath, 'utf8');
            const parsed = parseLibrarySymbols(content, libPath);
            const isBundledLib = extensionContext && libPath.startsWith(extensionContext.extensionPath);
            for (const s of parsed) {
                if (symbolMap.has(s.name) && isBundledLib) {
                    continue;
                }
                symbolMap.set(s.name, s);
            }
        } catch (e) {}
    }

    cachedLibrarySymbols = symbolMap;
    return symbolMap;
}

function buildAllSymbols(document: TextDocument, preMaskedText?: string): Map<string, LibrarySymbol> {
    const baseSymbols = getLibrarySymbols();
    const symbolMap = new Map<string, LibrarySymbol>(baseSymbols);

    // Parse symbols from sibling and imported .stride files
    const relatedFiles = getRelatedStrideFiles(document);
    for (const relPath of relatedFiles) {
        try {
            const content = getStrideFileContent(relPath);
            if (content) {
                const parsed = parseLibrarySymbols(content, relPath);
                for (const s of parsed) {
                    symbolMap.set(s.name, s);
                }
            }
        } catch (e) {}
    }

    try {
        const text = document.getText();
        const docParsed = parseLibrarySymbols(text, document.uri.fsPath, preMaskedText);
        for (const s of docParsed) {
            symbolMap.set(s.name, s);
        }
    } catch (e) {}

    return symbolMap;
}

function getAllLibrarySymbols(document: TextDocument): Map<string, LibrarySymbol> {
    return getCachedDocData(document).allSymbols;
}

const HOVER_STYLE = 'font-size: 0.76em; line-height: 1.3;';

function createCompactHover(headerCode: string | undefined, bodyMarkdown: string): Hover {
    let full = '';
    if (headerCode) {
        full += `\`\`\`stride\n${headerCode}\n\`\`\`\n`;
    }
    full += `<div style="${HOVER_STYLE}">\n\n${bodyMarkdown}\n\n</div>`;
    const md = new MarkdownString(full, true);
    md.isTrusted = true;
    md.supportHtml = true;
    return new Hover(md);
}

function renderTypeHover(typeInfo: TypeInfo, allTypes: Map<string, TypeInfo>): MarkdownString {
    let signature = `type ${typeInfo.name}`;
    if (typeInfo.typeName && typeInfo.typeName !== typeInfo.name) {
        signature += ` (typeName: "${typeInfo.typeName}")`;
    }

    let body = `\`\`\`stride\n${signature}\n\`\`\`\n`;
    body += `<div style="${HOVER_STYLE}">\n\n`;

    if (typeInfo.meta) {
        body += `*${typeInfo.meta}*\n\n`;
    }

    if (typeInfo.properties && typeInfo.properties.length > 0) {
        body += `**Allowed Properties**:\n`;
        for (const p of typeInfo.properties) {
            let pDesc = `- \`${p.name}:\``;
            if (p.types && p.types.length) {
                pDesc += ` [${p.types.join(', ')}]`;
            }
            if (p.required) {
                pDesc += ` *(required)*`;
            }
            if (p.defaultValue !== undefined) {
                pDesc += ` *(default: ${p.defaultValue})*`;
            }
            if (p.filePath) {
                pDesc += ` — ${formatClickableLink(p.filePath, p.line || 1)}`;
            }
            if (p.meta) {
                pDesc += `\n  *${p.meta}*`;
            }
            body += `${pDesc}\n`;
        }
        body += `\n`;
    }

    const visited = new Set<string>();
    const queue = [...typeInfo.inherits];
    const inheritedProps: { parentName: string; props: PropertyInfo[] }[] = [];

    while (queue.length > 0) {
        const parentName = queue.shift()!;
        if (visited.has(parentName)) continue;
        visited.add(parentName);

        const parent = allTypes.get(parentName);
        if (parent) {
            if (parent.properties && parent.properties.length > 0) {
                inheritedProps.push({ parentName, props: parent.properties });
            }
            queue.push(...parent.inherits);
        }
    }

    if (inheritedProps.length > 0) {
        body += `**Inherited Properties**:\n\n`;
        for (const group of inheritedProps) {
            const parentType = allTypes.get(group.parentName);
            let parentHeader = `**From \`${group.parentName}\`**`;
            if (parentType && parentType.filePath) {
                parentHeader = `**From [${group.parentName}](${formatClickableLink(parentType.filePath, parentType.line || 1).match(/\(([^)]+)\)/)?.[1]})**`;
            }
            body += `${parentHeader}:\n`;
            for (const p of group.props) {
                let pDesc = `- \`${p.name}:\``;
                if (p.types && p.types.length) {
                    pDesc += ` [${p.types.join(', ')}]`;
                }
                if (p.filePath) {
                    pDesc += ` — ${formatClickableLink(p.filePath, p.line || 1)}`;
                }
                if (p.meta) {
                    pDesc += `\n  *${p.meta}*`;
                }
                body += `${pDesc}\n`;
            }
            body += `\n`;
        }
    }

    body += `---\n`;
    if (typeInfo.inherits && typeInfo.inherits.length > 0) {
        const inheritLinks = typeInfo.inherits.map(parentName => {
            const parent = allTypes.get(parentName);
            if (parent && parent.filePath) {
                return `[${parentName}](${formatClickableLink(parent.filePath, parent.line || 1).match(/\(([^)]+)\)/)?.[1]})`;
            }
            return `\`${parentName}\``;
        });
        body += `🔗 **Inherits from**: ${inheritLinks.join(', ')}\n\n`;
    }

    if (typeInfo.filePath) {
        body += `📍 **Declared in**: ${formatClickableLink(typeInfo.filePath, typeInfo.line || 1)}\n`;
    } else if (typeInfo.isBuiltin) {
        body += `🏛️ **Built-in Stride Base Type**\n`;
    }

    body += `\n</div>`;
    const md = new MarkdownString(body, true);
    md.isTrusted = true;
    md.supportHtml = true;
    return md;
}

interface EnclosingDecl {
    kind: string;
    name: string;
    start: number;
    end: number;
    line: number;
    arraySpec?: string;
    generatorVar?: string;
    generatorRange?: string;
}

function findEnclosingDeclarations(text: string): EnclosingDecl[] {
    const root = parseScopeTree(text, '');
    return root.enclosingDecls || [];
}

interface DocCacheEntry {
    version: number;
    maskedText: string;
    scopeTree: ScopeContext;
    enclosingDecls: EnclosingDecl[];
    allTypes: Map<string, TypeInfo>;
    allSymbols: Map<string, LibrarySymbol>;
}

const docCache = new Map<string, DocCacheEntry>();

function getCachedDocData(document: TextDocument): DocCacheEntry {
    const key = document.uri.toString();
    const cached = docCache.get(key);
    if (cached && cached.version === document.version) {
        return cached;
    }
    const text = document.getText();
    const maskedText = maskCommentsAndStrings(text);
    const scopeTree = parseScopeTree(text, document.uri.fsPath, maskedText);
    const enclosingDecls = scopeTree.enclosingDecls || [];
    const allTypes = buildAllTypes(document, maskedText);
    const allSymbols = buildAllSymbols(document, maskedText);
    const entry: DocCacheEntry = {
        version: document.version,
        maskedText,
        scopeTree,
        enclosingDecls,
        allTypes,
        allSymbols
    };
    docCache.set(key, entry);
    return entry;
}

function getCachedInnermostEnclosingDeclaration(document: TextDocument, offset: number): EnclosingDecl | undefined {
    const { enclosingDecls } = getCachedDocData(document);
    let best: EnclosingDecl | undefined = undefined;

    for (const d of enclosingDecls) {
        if (offset >= d.start && offset <= d.end) {
            if (!best || (d.end - d.start < best.end - best.start)) {
                best = d;
            }
        }
    }

    return best;
}

function findPropertyDeclaration(
    propName: string,
    allTypes: Map<string, TypeInfo>,
    enclosingKind?: string
): { prop: PropertyInfo; declaredIn: TypeInfo } | undefined {
    if (enclosingKind) {
        const targetKind = TYPE_ALIASES[enclosingKind] || enclosingKind;
        const typeInfo = allTypes.get(enclosingKind) || allTypes.get(targetKind);
        if (typeInfo) {
            // 1. Direct properties
            const directProp = typeInfo.properties?.find(p => p.name === propName);
            if (directProp) {
                return { prop: directProp, declaredIn: typeInfo };
            }
            // 2. Inherited properties
            const visited = new Set<string>();
            const queue = [...(typeInfo.inherits || [])];
            while (queue.length > 0) {
                const parentName = queue.shift()!;
                if (visited.has(parentName)) continue;
                visited.add(parentName);
                const parentType = allTypes.get(parentName);
                if (parentType) {
                    const parentProp = parentType.properties?.find(p => p.name === propName);
                    if (parentProp) {
                        return { prop: parentProp, declaredIn: parentType };
                    }
                    if (parentType.inherits) {
                        queue.push(...parentType.inherits);
                    }
                }
            }
        }
    }

    // Fallback: search all types
    for (const [_, typeInfo] of allTypes.entries()) {
        const p = typeInfo.properties?.find(x => x.name === propName);
        if (p) {
            return { prop: p, declaredIn: typeInfo };
        }
    }

    return undefined;
}

function renderPropertyHover(
    propName: string,
    allTypes: Map<string, TypeInfo>,
    enclosingKind?: string
): MarkdownString | undefined {
    if (propName === 'variants') {
        const body = `<div style="${HOVER_STYLE}">\n\n` +
            `**Property \`variants:\`**\n\n` +
            `- **Allowed Types**: \`List of [_Any]\`\n\n` +
            `Mutually exclusive variants available for this feature group.\n\n</div>`;
        const md = new MarkdownString(body, true);
        md.isTrusted = true;
        md.supportHtml = true;
        return md;
    }

    const propMatch = findPropertyDeclaration(propName, allTypes, enclosingKind);
    if (!propMatch) return undefined;

    const { prop: foundProp, declaredIn: foundInType } = propMatch;

    let body = `<div style="${HOVER_STYLE}">\n\n`;
    let header = `**Property \`${propName}:\`**`;
    if (enclosingKind && enclosingKind !== foundInType.name && enclosingKind !== foundInType.typeName) {
        header += ` *(on \`${enclosingKind}\` via \`${foundInType.name}\`)*`;
    }
    body += `${header}\n\n`;

    if (foundProp.types && foundProp.types.length > 0) {
        body += `- **Allowed Types**: \`${foundProp.types.join(', ')}\`\n`;
    }

    if (foundProp.required !== undefined) {
        body += `- **Required**: \`${foundProp.required ? 'on (true)' : 'off (false)'}\`\n`;
    }

    if (foundProp.defaultValue !== undefined) {
        body += `- **Default**: \`${foundProp.defaultValue}\`\n`;
    }

    if (foundProp.meta) {
        body += `\n---\n*${foundProp.meta}*\n`;
    }

    body += `\n---\n`;
    if (foundProp.filePath) {
        body += `📍 **Declared in**: ${formatClickableLink(foundProp.filePath, foundProp.line || 1)}`;
        if (foundInType) {
            body += ` (type \`${foundInType.name}\`)`;
        }
        body += `\n`;
    } else if (foundInType?.filePath) {
        body += `📍 **Declared in**: ${formatClickableLink(foundInType.filePath, foundInType.line || 1)} (type \`${foundInType.name}\`)\n`;
    }

    body += `\n</div>`;
    const md = new MarkdownString(body, true);
    md.isTrusted = true;
    md.supportHtml = true;
    return md;
}

function formatPortItem(p: PortInfo, isProperty: boolean): string {
    const displayName = isProperty ? (p.nameField || p.portName) : p.portName;
    const typeStr = p.types || p.boundBlock || (p.portType.toLowerCase().includes('output') ? '_SwitchType' : '_IntType');

    let dirTag = '';
    if (!isProperty) {
        if (p.portType.toLowerCase().includes('input')) {
            dirTag = 'in: ';
        } else if (p.portType.toLowerCase().includes('output')) {
            dirTag = 'out: ';
        }
    } else if (p.portType.toLowerCase().includes('output')) {
        dirTag = 'out: ';
    }

    let tag = `${dirTag}\`${typeStr}\``;
    if (isProperty && p.defaultVal !== undefined) {
        tag += `, default: \`${p.defaultVal}\``;
    }

    let line = `- **\`${displayName}\`** (${tag})`;
    if (p.meta) {
        line += ` — *${p.meta}*`;
    }
    return line;
}

function renderPortsSection(ports: PortInfo[]): string {
    const mainPorts: PortInfo[] = [];
    const propertyPorts: PortInfo[] = [];
    const otherPorts: PortInfo[] = [];

    for (const p of ports) {
        const pType = p.portType.toLowerCase();
        if (pType.startsWith('main')) {
            mainPorts.push(p);
        } else if (pType.startsWith('property')) {
            propertyPorts.push(p);
        } else {
            otherPorts.push(p);
        }
    }

    let result = '';

    if (mainPorts.length > 0) {
        result += `\n**Main Ports**:\n`;
        for (const p of mainPorts) {
            result += `${formatPortItem(p, false)}\n`;
        }
    }

    if (propertyPorts.length > 0) {
        result += `\n**Property Ports**:\n`;
        for (const p of propertyPorts) {
            result += `${formatPortItem(p, true)}\n`;
        }
    }

    if (otherPorts.length > 0) {
        result += `\n**Other Ports**:\n`;
        for (const p of otherPorts) {
            result += `${formatPortItem(p, false)}\n`;
        }
    }

    return result;
}

function renderLibrarySymbolHover(sym: LibrarySymbol, allSymbols: Map<string, LibrarySymbol>, allTypes?: Map<string, TypeInfo>): Hover {
    let body = '';

    const typeInfo = allTypes ? (allTypes.get(sym.kind) || allTypes.get(TYPE_ALIASES[sym.kind] || '')) : undefined;
    let declTypeStr = `\`${sym.kind}\``;
    if (typeInfo && typeInfo.name && typeInfo.name !== sym.kind) {
        declTypeStr += ` (\`${typeInfo.name}\``;
        if (typeInfo.inherits && typeInfo.inherits.length) {
            declTypeStr += `, inherits \`${typeInfo.inherits.join(', ')}\``;
        }
        declTypeStr += `)`;
    }
    body += `- **Declaration Type**: ${declTypeStr}\n`;
    if (sym.kind === 'constant' && sym.arraySpec) {
        body += `- **Kind**: \`constant array\`\n`;
        body += `- **Dimensions**: \`[${sym.arraySpec}]\`\n`;
    } else if (sym.kind === 'constant') {
        body += `- **Kind**: \`constant\`\n`;
    }

    if (sym.kind === 'alias' && sym.targetBlock) {
        const targetSym = allSymbols.get(sym.targetBlock);
        if (targetSym) {
            body += `🔗 **Points to Target**: [${sym.targetBlock}](${formatClickableLink(targetSym.filePath, targetSym.line).match(/\(([^)]+)\)/)?.[1]})\n\n`;
        } else {
            body += `🔗 **Target Block**: \`${sym.targetBlock}\`\n\n`;
        }
    }

    if (sym.meta) {
        body += `\n*${sym.meta}*\n\n`;
    }

    if (sym.inputs && sym.inputs.length) {
        body += `- **Inputs**: \`[${sym.inputs.join(', ')}]\`\n`;
    }
    if (sym.outputs && sym.outputs.length) {
        body += `- **Outputs**: \`[${sym.outputs.join(', ')}]\`\n`;
    }
    if (sym.processing) {
        body += `- **Processing**: \`${sym.processing}\`\n`;
    }

    if (sym.ports && sym.ports.length) {
        body += renderPortsSection(sym.ports);
    }

    if (sym.inherits && sym.inherits.length) {
        const inheritedPorts: { parentName: string; ports: PortInfo[] }[] = [];
        const visitedSyms = new Set<string>();
        const symQueue = [...sym.inherits];
        while (symQueue.length > 0) {
            const pName = symQueue.shift()!;
            if (visitedSyms.has(pName)) continue;
            visitedSyms.add(pName);
            const parentSym = allSymbols.get(pName);
            if (parentSym && parentSym.ports && parentSym.ports.length > 0) {
                inheritedPorts.push({ parentName: pName, ports: parentSym.ports });
            }
            if (parentSym && parentSym.inherits) {
                symQueue.push(...parentSym.inherits);
            }
        }

        if (inheritedPorts.length > 0) {
            body += `\n**Inherited Ports**:\n`;
            for (const group of inheritedPorts) {
                const parentSym = allSymbols.get(group.parentName);
                let parentHeader = `*From \`${group.parentName}\`*`;
                if (parentSym && parentSym.filePath) {
                    parentHeader = `*From [${group.parentName}](${formatClickableLink(parentSym.filePath, parentSym.line).match(/\(([^)]+)\)/)?.[1]})*`;
                }
                body += `\n${parentHeader}:\n`;
                body += renderPortsSection(group.ports);
            }
        }
    }

    body += `\n---\n`;
    if (sym.inherits && sym.inherits.length) {
        body += `🔗 **Inherits from**: \`${sym.inherits.join(', ')}\`\n\n`;
    }
    body += `📍 **Declared in**: ${formatClickableLink(sym.filePath, sym.line)}\n`;
    if (typeInfo && typeInfo.filePath) {
        body += `🔗 **Type Definition**: ${formatClickableLink(typeInfo.filePath, typeInfo.line || 1)}\n`;
    }

    return createCompactHover(sym.signature, body);
}

// ============================================================================
// Fallback Providers Setup
// ============================================================================

function registerFallbackProviders(context: ExtensionContext) {
    if (fallbackProvidersRegistered) return;
    fallbackProvidersRegistered = true;
    extensionContext = context;
    const symbolProvider: DocumentSymbolProvider = {
        provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
            const { scopeTree: rootScope } = getCachedDocData(document);

            function getSymbolKind(kindStr: string, isAnon?: boolean): SymbolKind {
                if (isAnon) {
                    return SymbolKind.Operator;
                }
                if (kindStr === 'constant') {
                    return SymbolKind.Constant;
                } else if (kindStr === 'module' || kindStr === 'reaction' || kindStr === 'loop') {
                    return SymbolKind.Function;
                } else if (kindStr === 'state' || kindStr === 'transition') {
                    return SymbolKind.Struct;
                } else if (kindStr === '_domainDefinition' || kindStr === 'gameDefinition' || kindStr === 'domainDeclaration' || kindStr === 'type') {
                    return SymbolKind.Class;
                } else if (kindStr === 'typeProperty' || kindStr === 'property') {
                    return SymbolKind.Property;
                } else if (kindStr.includes('Port') || kindStr === 'port') {
                    return SymbolKind.Interface;
                } else if (kindStr === 'feature') {
                    return SymbolKind.Interface;
                } else if (kindStr === 'group' || kindStr === '@with') {
                    return SymbolKind.Namespace;
                } else if (kindStr === 'variant') {
                    return SymbolKind.EnumMember;
                }
                return SymbolKind.Variable;
            }

            function convertScopeToSymbols(scope: ScopeContext): DocumentSymbol[] {
                const symbols: DocumentSymbol[] = [];

                // 1. Declarations directly inside this scope (that are not separate child scopes)
                for (const [_, decl] of scope.declarations.entries()) {
                    if (decl.fromDomain) continue;
                    const isChildScope = scope.children.some(c => c.name === decl.name && c.startLine === decl.line);
                    if (!isChildScope) {
                        const dLine = Math.max(0, decl.line - 1);
                        const lineText = document.lineAt(Math.min(dLine, document.lineCount - 1)).text;
                        let pos = lineText.indexOf(decl.name);
                        let len = decl.name.length;
                        if (pos < 0) {
                            pos = lineText.indexOf(decl.kind);
                            len = pos >= 0 ? decl.kind.length : lineText.length;
                        }
                        const selRange = new Range(dLine, pos >= 0 ? pos : 0, dLine, pos >= 0 ? pos + len : lineText.length);
                        const fullRange = new Range(dLine, 0, dLine, lineText.length);
                        let declName = decl.name;
                        let declDetail = decl.isAnonymous ? `${decl.kind} (anonymous)` : decl.kind;
                        let symKind = getSymbolKind(decl.kind, decl.isAnonymous);

                        if (decl.kind === 'constant' && decl.arraySpec) {
                            declName = `${decl.name}[${decl.arraySpec}]`;
                            declDetail = `constant array [${decl.arraySpec}]`;
                            symKind = SymbolKind.Array;
                        } else if (decl.arraySpec) {
                            declName = `${decl.name}[${decl.arraySpec}]`;
                            declDetail = `${decl.kind} array [${decl.arraySpec}]`;
                            symKind = SymbolKind.Array;
                        } else if (decl.kind === 'constant') {
                            symKind = SymbolKind.Constant;
                        } else if (decl.generatorVar && decl.generatorRange) {
                            declDetail = `${decl.generatorVar} in ${decl.generatorRange}`;
                        }
                        const sym = new DocumentSymbol(declName, declDetail, symKind, fullRange, selRange);
                        symbols.push(sym);
                    }
                }

                // 2. Child scopes
                for (const childScope of scope.children) {
                    const sLine = Math.max(0, childScope.startLine - 1);
                    const eLine = Math.max(sLine, childScope.endLine - 1);
                    const lineText = document.lineAt(Math.min(sLine, document.lineCount - 1)).text;
                    const endLineText = document.lineAt(Math.min(eLine, document.lineCount - 1)).text;
                    let pos = lineText.indexOf(childScope.name);
                    let len = childScope.name.length;
                    if (pos < 0) {
                        pos = lineText.indexOf(childScope.kind);
                        len = pos >= 0 ? childScope.kind.length : lineText.length;
                    }
                    const selRange = new Range(sLine, pos >= 0 ? pos : 0, sLine, pos >= 0 ? pos + len : lineText.length);
                    const fullRange = new Range(sLine, 0, eLine, endLineText.length);

                    let scopeName = childScope.name;
                    let detail = childScope.isAnonymous ? `${childScope.kind} (anonymous)` : childScope.kind;
                    let symKind = getSymbolKind(childScope.kind, childScope.isAnonymous);

                    if (childScope.kind === 'constant' && childScope.arraySpec) {
                        scopeName = `${childScope.name}[${childScope.arraySpec}]`;
                        detail = `constant array [${childScope.arraySpec}]`;
                        symKind = SymbolKind.Array;
                    } else if (childScope.arraySpec) {
                        scopeName = `${childScope.name}[${childScope.arraySpec}]`;
                        detail = `${childScope.kind} array [${childScope.arraySpec}]`;
                        symKind = SymbolKind.Array;
                    } else if (childScope.kind === 'constant') {
                        symKind = SymbolKind.Constant;
                    } else if (childScope.generatorVar && childScope.generatorRange) {
                        detail = `${childScope.kind} [${childScope.generatorVar} in ${childScope.generatorRange}]`;
                    }

                    const childNode = new DocumentSymbol(
                        scopeName,
                        detail,
                        symKind,
                        fullRange,
                        selRange
                    );
                    childNode.children = convertScopeToSymbols(childScope);
                    symbols.push(childNode);
                }

                symbols.sort((a, b) => a.range.start.line - b.range.start.line);
                return symbols;
            }

            return convertScopeToSymbols(rootScope);
        }
    };

    const hoverProvider: HoverProvider = {
        provideHover(document: TextDocument, position: Position): Hover | undefined {
            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

            // Check numeric literal hover (including floats like 0.5f32, .5f32, hex 0x1Fu8, binary 0b1010u8)
            const numWordRange = document.getWordRangeAtPosition(
                position,
                /(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*(?:[iu](?:8|16|32|64)|u|usize)?|0[bB][01](?:_?[01])*(?:[iu](?:8|16|32|64)|u|usize)?|[0-9](?:_?[0-9])*\.(?!\.)[0-9]*(?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?(?:f(?:32|64))?|(?<![0-9a-zA-Z_])\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?(?:f(?:32|64))?|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*(?:f(?:32|64))?|[0-9](?:_?[0-9])*(?:[iu](?:8|16|32|64)|u|usize|f(?:32|64))|[0-9](?:_?[0-9])*)/
            );
            if (numWordRange) {
                const numText = document.getText(numWordRange);
                const parsedNum = parseNumericLiteral(numText);
                if (parsedNum) {
                    let header = `literal ${numText}: ${parsedNum.type}`;
                    let body = `**Numeric Literal**: \`${numText}\`\n\n- **Data Type**: \`${parsedNum.type}\`\n`;
                    if (parsedNum.value !== undefined) {
                        body += `- **Value**: \`${parsedNum.value.toString()}\`\n`;
                    }
                    if (parsedNum.suffix) {
                        body += `- **Suffix**: \`${parsedNum.suffix}\` (explicit \`${parsedNum.type}\` type suffix)\n`;
                    }
                    if (parsedNum.error) {
                        body += `\n⚠️ *Literal Error: ${parsedNum.error}*\n`;
                    }
                    return createCompactHover(header, body);
                }
            }

            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            const allTypes = getAllTypes(document);
            const lineText = document.lineAt(position.line).text;
            const afterWord = lineText.substring(wordRange.end.character);
            const isFollowedByColon = /^\s*:/.test(afterWord);
            const enclosingDecl = getCachedInnermostEnclosingDeclaration(document, charOffset);

            // Member access hover (Entity.member or .member):
            const beforeWord = lineText.substring(0, wordRange.start.character);
            const memberEntityMatch = /([_a-zA-Z0-9]+)\.\s*$/.exec(beforeWord);
            if (memberEntityMatch) {
                const entityName = memberEntityMatch[1];
                const { scopeTree: rootScope } = getCachedDocData(document);
                const scopeStack = buildScopeStack(rootScope, position.line + 1);
                const decl = findDeclarationInScopeStack(entityName, scopeStack);
                const allSymbols = getAllLibrarySymbols(document);
                const sym = allSymbols.get(entityName);

                const typeName = decl?.type || decl?.kind || sym?.kind;
                if (typeName) {
                    const targetType = allTypes.get(typeName) || allTypes.get(TYPE_ALIASES[typeName] || typeName);
                    if (targetType && targetType.properties) {
                        const prop = targetType.properties.find(p => p.name === word);
                        if (prop) {
                            let header = `property ${word}`;
                            if (prop.types && prop.types.length > 0) {
                                header += `: ${prop.types.join(' | ')}`;
                            }
                            let body = `**Member Property**: \`${word}\` *(of \`${entityName}\`: \`${typeName}\`)*\n\n`;
                            if (prop.types && prop.types.length > 0) {
                                body += `- **Allowed Types**: \`${prop.types.join(', ')}\`\n`;
                            }
                            if (prop.defaultValue !== undefined) {
                                body += `- **Default**: \`${prop.defaultValue}\`\n`;
                            }
                            if (prop.meta) {
                                body += `\n*${prop.meta}*\n\n`;
                            }
                            if (prop.filePath) {
                                body += `\n📍 Property of \`${typeName}\` in ${formatClickableLink(prop.filePath, prop.line || 1)}`;
                            }
                            return createCompactHover(header, body);
                        }
                    }
                }
            }

            // Namespace member hover (Namespace::member):
            const nsMemberMatch = /([_a-zA-Z0-9]+)::\s*$/.exec(beforeWord);
            if (nsMemberMatch) {
                const nsName = nsMemberMatch[1];
                const nsInfo = resolveNamespace(nsName, document);
                if (nsInfo) {
                    if (nsInfo.kind === 'feature' && nsInfo.featureVariants) {
                        if (nsInfo.featureVariants.includes(word)) {
                            return createCompactHover(`variant ${word}`, `**Variant**: \`${nsName}::${word}\`\n\nVariant of feature \`${nsName}\``);
                        }
                    }
                    if (nsInfo.targetFiles && nsInfo.targetFiles.length > 0) {
                        for (const f of nsInfo.targetFiles) {
                            const content = getStrideFileContent(f);
                            if (!content) continue;
                            const scope = parseScopeTree(content, f);
                            const decl = scope.declarations.get(word);
                            if (decl) {
                                let body = `**${decl.kind}**: \`${nsName}::${word}\`\n\n`;
                                if (decl.meta) body += `*${decl.meta}*\n\n`;
                                body += `📍 Declared in ${formatClickableLink(f, decl.line)}`;
                                return createCompactHover(`${decl.kind} ${decl.signature || word}`, body);
                            }
                            const symbols = parseLibrarySymbols(content, f);
                            const sym = symbols.find(s => s.name === word);
                            if (sym) {
                                let body = `**${sym.kind}**: \`${nsName}::${word}\`\n\n`;
                                if (sym.meta) body += `*${sym.meta}*\n\n`;
                                body += `📍 Declared in ${formatClickableLink(f, sym.line)}`;
                                return createCompactHover(`${sym.kind} ${sym.signature || word}`, body);
                            }
                            const types = parseTypesFromText(content, f);
                            const t = types.find(type => type.name === word);
                            if (t) {
                                let body = `**Type**: \`${nsName}::${word}\`\n\n`;
                                if (t.meta) body += `*${t.meta}*\n\n`;
                                body += `📍 Defined in ${formatClickableLink(f, t.line || 1)}`;
                                return createCompactHover(`type ${word}`, body);
                            }
                        }
                    }
                }
            }

            // Namespace identifier hover (hovering on `Namespace` before `::`):
            if (afterWord.startsWith('::')) {
                const nsInfo = resolveNamespace(word, document);
                if (nsInfo) {
                    if (nsInfo.kind === 'feature') {
                        const variantsStr = (nsInfo.featureVariants || []).map(v => `\`${v}\``).join(', ');
                        let body = `**Feature**: \`${word}\`\n\n`;
                        if (nsInfo.featureDecl?.meta) body += `*${nsInfo.featureDecl.meta}*\n\n`;
                        if (variantsStr) body += `- **Variants**: ${variantsStr}\n`;
                        return createCompactHover(`feature ${word}`, body);
                    }
                    if (nsInfo.kind === 'import') {
                        let body = `**Namespace / Module**: \`${word}\`\n\n`;
                        if (nsInfo.importTarget && nsInfo.importTarget !== word) {
                            body += `- **Aliased Target**: \`${nsInfo.importTarget}\`\n`;
                        }
                        if (nsInfo.targetFiles && nsInfo.targetFiles.length > 0) {
                            body += `- **Resolved Files**:\n` + nsInfo.targetFiles.map(f => `  - ${formatClickableLink(f, 1)}`).join('\n') + '\n';
                        }
                        return createCompactHover(`namespace ${word}`, body);
                    }
                    if (nsInfo.kind === 'domain') {
                        return createCompactHover(`domain ${word}`, `**Domain**: \`${word}\`\n\nCoordinated execution domain.`);
                    }
                }
            }

            // 1. If followed by a colon, check if inside a function/action invocation first (e.g. Place(supply: ...))
            if (isFollowedByColon) {
                const beforeWord = lineText.substring(0, wordRange.start.character);
                let callMatch = /([_a-zA-Z0-9]+)\s*(?:\[[^\]]*\])?\s*\([^()]*$/.exec(beforeWord);
                if (!callMatch) {
                    let combined = beforeWord;
                    for (let prev = position.line - 1; prev >= Math.max(0, position.line - 15); prev--) {
                        const pText = document.lineAt(prev).text;
                        combined = pText + ' ' + combined;
                        const m = /([_a-zA-Z0-9]+)\s*(?:\[[^\]]*\])?\s*\([^()]*$/.exec(combined);
                        if (m) {
                            callMatch = m;
                            break;
                        }
                        if (pText.includes(';')) break;
                    }
                }

                if (callMatch) {
                    const funcName = callMatch[1];
                    const allSymbols = getAllLibrarySymbols(document);
                    const funcSym = allSymbols.get(funcName);
                    const { scopeTree: rootScope } = getCachedDocData(document);
                    const targetScope = findScopeByName(rootScope, funcName);

                    let foundPort: PortInfo | undefined;
                    let targetFilePath: string = document.uri.fsPath;
                    let enclosingName: string = funcName;
                    let boundDecl: ScopeDeclaration | undefined;

                    if (targetScope) {
                        for (const p of targetScope.ports.values()) {
                            if (p.nameField === word || p.portName === word || p.boundBlock === word ||
                                (p.nameField && p.nameField.toLowerCase() === word.toLowerCase()) ||
                                p.portName.toLowerCase() === word.toLowerCase()) {
                                foundPort = p;
                                enclosingName = `${targetScope.kind} ${targetScope.name}`;
                                targetFilePath = document.uri.fsPath;
                                if (p.boundBlock) {
                                    boundDecl = targetScope.declarations.get(p.boundBlock);
                                }
                                break;
                            }
                        }
                    }

                    if (!foundPort && funcSym && funcSym.ports) {
                        for (const p of funcSym.ports) {
                            if (p.nameField === word || p.portName === word || p.boundBlock === word ||
                                (p.nameField && p.nameField.toLowerCase() === word.toLowerCase()) ||
                                p.portName.toLowerCase() === word.toLowerCase()) {
                                foundPort = p;
                                enclosingName = `${funcSym.kind} ${funcSym.name}`;
                                targetFilePath = funcSym.filePath;
                                break;
                            }
                        }
                    }

                    if (foundPort) {
                        let header = `${foundPort.portType} ${foundPort.portName}`;
                        if (foundPort.nameField && foundPort.nameField !== foundPort.portName) {
                            header += ` (name: "${foundPort.nameField}")`;
                        }
                        let body = `**Port Parameter**: \`${foundPort.nameField || foundPort.portName}\`\n\n`;
                        const portTypeName = foundPort.types || boundDecl?.type || boundDecl?.kind || '_IntType';
                        body += `- **Type**: \`${portTypeName}\`\n`;
                        if (foundPort.boundBlock) {
                            body += `- **Bound Block**: \`${foundPort.boundBlock}\``;
                            if (boundDecl?.type) {
                                body += ` (\`${boundDecl.kind} ${boundDecl.name} { type: ${boundDecl.type} }\`)`;
                            }
                            body += `\n`;
                        }
                        if (foundPort.defaultVal !== undefined) {
                            body += `- **Default**: \`${foundPort.defaultVal}\`\n`;
                        }
                        if (foundPort.meta) {
                            body += `\n*${foundPort.meta}*\n\n`;
                        }
                        body += `\n📍 Parameter port for \`${enclosingName}\` in ${formatClickableLink(targetFilePath, foundPort.line || 1)}`;
                        return createCompactHover(header, body);
                    }
                }

                // Fallback to enclosing block declaration property
                const propHover = renderPropertyHover(word, allTypes, enclosingDecl?.kind);
                if (propHover) {
                    return new Hover(propHover);
                }
            }

            // 2. Type definitions from schemas (checked before built-in fallbacks)
            if (!isFollowedByColon) {
                const matchedType = allTypes.get(word) || (TYPE_ALIASES[word] ? allTypes.get(TYPE_ALIASES[word]) : undefined);
                if (matchedType) {
                    return new Hover(renderTypeHover(matchedType, allTypes));
                }
            }

            // 3. Built-in scalar types fallback
            if (BUILTIN_SCALARS[word]) {
                return createCompactHover(undefined, BUILTIN_SCALARS[word]);
            }

            // Keyword: in
            if (word === 'in') {
                return createCompactHover('keyword in', '### Keyword: `in`\n\nSpecifies the iteration domain or range in generator array declarations (e.g. `[Index in 0:8]`).');
            }
            if (word === 'feature') {
                return createCompactHover('keyword feature', '### Keyword: `feature`\n\nDeclares a configurable feature toggle or feature group with optional variants.');
            }
            if (word === '@with' || word === 'with') {
                return createCompactHover('directive @with', '### Directive: `@with`\n\nConditionally includes a declaration, block, stream, or property value based on a boolean feature expression (e.g. `@with(FeatureA && !FeatureB)`).');
            }
            if (word === '@force' || word === 'force') {
                return createCompactHover('directive @force', '### Directive: `@force`\n\nForces a specific feature variant to be selected.');
            }

            // 4. Property Keys fallback
            const propHover = renderPropertyHover(word, allTypes, enclosingDecl?.kind);
            if (propHover) {
                return new Hover(propHover);
            }

            // 5. Check for Import or Use statements (e.g. import GameFunctions -> link to GameFunctions.stride)
            const importMatch = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9.]+))(?:\s+as\s+([_a-zA-Z0-9]+))?/i.exec(lineText);
            if (importMatch) {
                const importTarget = importMatch[2] || importMatch[3];
                if (importTarget && (importTarget === word || importTarget.includes(word) || word === 'import' || word === 'use')) {
                    const targetFile = resolveImportFile(importTarget, document);
                    if (targetFile && fs.existsSync(targetFile)) {
                        const content = fs.readFileSync(targetFile, 'utf8');
                        const decls = parseLibrarySymbols(content, targetFile);
                        let body = `📍 **File**: ${formatClickableLink(targetFile, 1)}\n\n`;
                        if (decls.length > 0) {
                            body += `**Exported Declarations**:\n`;
                            for (const d of decls.slice(0, 15)) {
                                body += `- \`${d.signature}\` (${formatClickableLink(targetFile, d.line)})\n`;
                            }
                            if (decls.length > 15) {
                                body += `*... and ${decls.length - 15} more declarations.*\n`;
                            }
                        }
                        return createCompactHover(`import ${importTarget}`, body);
                    }
                }
            }

            // 6. Check if word is a function, reaction, action, module, or symbol with ports
            const allSymbols = getAllLibrarySymbols(document);
            const libSym = allSymbols.get(word);
            if (libSym && (libSym.ports?.length || libSym.kind === 'reaction' || libSym.kind === 'action' || libSym.kind === 'module' || libSym.kind === 'platformModule')) {
                return renderLibrarySymbolHover(libSym, allSymbols, allTypes);
            }

            // 7. Lexical Scoping & ScopeStack Resolution for local signals, switches, blocks, ports, and variables
            const { scopeTree: rootScope } = getCachedDocData(document);
            const scopeStack = buildScopeStack(rootScope, position.line + 1);
            const decl = findDeclarationInScopeStack(word, scopeStack);

            if (decl) {
                let body = '';
                const currentScope = scopeStack[scopeStack.length - 1];
                if (currentScope && currentScope.kind !== 'root') {
                    body += `📍 **Scope**: \`${currentScope.kind}\` \`${currentScope.name}\`\n\n`;
                }

                if (decl.kind === 'generator') {
                    body += `- **Type**: \`${decl.type || '_IntType'}\`\n`;
                    if (decl.generatorRange) {
                        body += `- **Range**: \`${decl.generatorRange}\`\n`;
                    }
                    if (decl.meta) {
                        body += `\n---\n*${decl.meta}*\n`;
                    }
                    body += `\n---\n`;
                    body += `📍 **Declared in**: ${formatClickableLink(document.uri.fsPath, decl.line)}\n`;
                    return createCompactHover(`(generator) ${decl.name} in ${decl.generatorRange || ''}`, body);
                }

                if (decl.associatedPort) {
                    body += `- **Associated Port**: \`${decl.associatedPort.portName}\` (\`${decl.associatedPort.portType}\`)\n`;
                    if (decl.associatedPort.meta) {
                        body += `\n*${decl.associatedPort.meta}*\n\n`;
                    }
                }

                if (decl.kind === 'constant' && decl.arraySpec) {
                    body += `- **Kind**: \`constant array\`\n`;
                    body += `- **Dimensions**: \`[${decl.arraySpec}]\`\n`;
                } else if (decl.kind === 'constant') {
                    body += `- **Kind**: \`constant\`\n`;
                }
                if (decl.type) {
                    body += `- **Type**: \`${decl.type}\`\n`;
                }
                if (decl.domain) {
                    body += `- **Domain**: \`${decl.domain}\`\n`;
                }
                if (decl.defaultVal) {
                    body += `- **Default**: \`${decl.defaultVal}\`\n`;
                }
                if (decl.boundBlock) {
                    body += `- **Bound Block**: \`${decl.boundBlock}\`\n`;
                }
                if (decl.kind === 'feature') {
                    body += `- **Kind**: \`feature\`\n`;
                    if (decl.variants && decl.variants.length > 0) {
                        body += `- **Variants**: \`[ ${decl.variants.join(', ')} ]\`\n`;
                    }
                }
                if (decl.withCondition) {
                    body += `- **Condition**: \`@with(${decl.withCondition})\`\n`;
                }

                if (decl.meta) {
                    body += `\n---\n*${decl.meta}*\n`;
                }

                body += `\n---\n`;
                body += `📍 **Declared in**: ${formatClickableLink(document.uri.fsPath, decl.line)}\n`;
                if (allTypes.has(decl.kind)) {
                    const t = allTypes.get(decl.kind)!;
                    if (t.filePath) {
                        body += `🔗 **Type Definition**: ${formatClickableLink(t.filePath, t.line || 1)}\n`;
                    }
                }

                return createCompactHover(decl.signature, body);
            }

            // 8. Other Library Symbols fallback
            if (libSym) {
                return renderLibrarySymbolHover(libSym, allSymbols, allTypes);
            }

            return undefined;
        }
    };

    const definitionProvider: DefinitionProvider = {
        provideDefinition(document: TextDocument, position: Position): Location | undefined {
            const lineText = document.lineAt(position.line).text;

            // 0. Check for Import or Use statements (e.g. clicking on GameFunctions in import GameFunctions -> jump to GameFunctions.stride)
            const importMatch = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9.]+))(?:\s+as\s+([_a-zA-Z0-9]+))?/i.exec(lineText);
            if (importMatch) {
                const importTarget = importMatch[2] || importMatch[3];
                if (importTarget) {
                    const targetFile = resolveImportFile(importTarget, document);
                    if (targetFile) {
                        return new Location(Uri.file(targetFile), new Position(0, 0));
                    }
                }
            }

            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            // Also check if word itself is an import target (e.g. if regex didn't match full line)
            if (/^\s*(?:import|use)\b/.test(lineText) && word !== 'import' && word !== 'use' && word !== 'as') {
                const targetFile = resolveImportFile(word, document);
                if (targetFile) {
                    return new Location(Uri.file(targetFile), new Position(0, 0));
                }
            }

            const allTypes = getAllTypes(document);
            const afterWord = lineText.substring(wordRange.end.character);
            const isFollowedByColon = /^\s*:/.test(afterWord);
            const enclosingDecl = getCachedInnermostEnclosingDeclaration(document, charOffset);

            // Member access definition (Entity.member):
            const beforeWord = lineText.substring(0, wordRange.start.character);
            const memberEntityMatch = /([_a-zA-Z0-9]+)\.\s*$/.exec(beforeWord);
            if (memberEntityMatch) {
                const entityName = memberEntityMatch[1];
                const { scopeTree: rootScope } = getCachedDocData(document);
                const scopeStack = buildScopeStack(rootScope, position.line + 1);
                const decl = findDeclarationInScopeStack(entityName, scopeStack);
                const allSymbols = getAllLibrarySymbols(document);
                const sym = allSymbols.get(entityName);

                const typeName = decl?.type || decl?.kind || sym?.kind;
                if (typeName) {
                    const targetType = allTypes.get(typeName) || allTypes.get(TYPE_ALIASES[typeName] || typeName);
                    if (targetType && targetType.properties) {
                        const prop = targetType.properties.find(p => p.name === word);
                        if (prop && prop.filePath) {
                            return new Location(Uri.file(prop.filePath), new Position(Math.max(0, (prop.line || 1) - 1), 0));
                        }
                    }
                }
            }

            // Namespace member definition (Namespace::member):
            const nsMemberMatch = /([_a-zA-Z0-9]+)::\s*$/.exec(beforeWord);
            if (nsMemberMatch) {
                const nsName = nsMemberMatch[1];
                const nsInfo = resolveNamespace(nsName, document);
                if (nsInfo) {
                    if (nsInfo.kind === 'feature' && nsInfo.featureDecl) {
                        return new Location(document.uri, new Position(Math.max(0, nsInfo.featureDecl.line - 1), 0));
                    }
                    if (nsInfo.targetFiles && nsInfo.targetFiles.length > 0) {
                        for (const f of nsInfo.targetFiles) {
                            const content = getStrideFileContent(f);
                            if (!content) continue;
                            const scope = parseScopeTree(content, f);
                            const decl = scope.declarations.get(word);
                            if (decl) {
                                return new Location(Uri.file(f), new Position(Math.max(0, decl.line - 1), 0));
                            }
                            const symbols = parseLibrarySymbols(content, f);
                            const sym = symbols.find(s => s.name === word);
                            if (sym) {
                                return new Location(Uri.file(f), new Position(Math.max(0, sym.line - 1), 0));
                            }
                            const types = parseTypesFromText(content, f);
                            const t = types.find(type => type.name === word);
                            if (t && t.filePath) {
                                return new Location(Uri.file(t.filePath), new Position(Math.max(0, (t.line || 1) - 1), 0));
                            }
                            if (path.basename(f, '.stride').toLowerCase() === word.toLowerCase()) {
                                return new Location(Uri.file(f), new Position(0, 0));
                            }
                        }
                        return new Location(Uri.file(nsInfo.targetFiles[0]), new Position(0, 0));
                    }
                }
            }

            // Namespace identifier definition (clicking on `Namespace` before `::`):
            if (afterWord.startsWith('::')) {
                const nsInfo = resolveNamespace(word, document);
                if (nsInfo) {
                    if (nsInfo.importLine) {
                        return new Location(document.uri, new Position(nsInfo.importLine - 1, 0));
                    }
                    if (nsInfo.kind === 'feature' && nsInfo.featureDecl) {
                        return new Location(document.uri, new Position(Math.max(0, nsInfo.featureDecl.line - 1), 0));
                    }
                    if (nsInfo.targetFiles && nsInfo.targetFiles.length > 0) {
                        return new Location(Uri.file(nsInfo.targetFiles[0]), new Position(0, 0));
                    }
                }
            }

            // 1. If followed by a colon, check if inside a function/action invocation first
            if (isFollowedByColon) {
                const beforeWord = lineText.substring(0, wordRange.start.character);
                let callMatch = /([_a-zA-Z0-9]+)\s*(?:\[[^\]]*\])?\s*\([^()]*$/.exec(beforeWord);
                if (!callMatch) {
                    let combined = beforeWord;
                    for (let prev = position.line - 1; prev >= Math.max(0, position.line - 15); prev--) {
                        const pText = document.lineAt(prev).text;
                        combined = pText + ' ' + combined;
                        const m = /([_a-zA-Z0-9]+)\s*(?:\[[^\]]*\])?\s*\([^()]*$/.exec(combined);
                        if (m) {
                            callMatch = m;
                            break;
                        }
                        if (pText.includes(';')) break;
                    }
                }
                if (callMatch) {
                    const funcName = callMatch[1];
                    const { scopeTree: rootScope } = getCachedDocData(document);
                    const targetScope = findScopeByName(rootScope, funcName);
                    if (targetScope) {
                        for (const p of targetScope.ports.values()) {
                            if (p.nameField === word || p.portName === word || p.boundBlock === word ||
                                (p.nameField && p.nameField.toLowerCase() === word.toLowerCase()) ||
                                p.portName.toLowerCase() === word.toLowerCase()) {
                                return new Location(document.uri, new Position(Math.max(0, (p.line || 1) - 1), 0));
                            }
                        }
                    }
                    const allSymbols = getAllLibrarySymbols(document);
                    const funcSym = allSymbols.get(funcName);
                    if (funcSym && funcSym.ports) {
                        const port = funcSym.ports.find(p => p.nameField === word || p.portName === word || p.boundBlock === word ||
                            (p.nameField && p.nameField.toLowerCase() === word.toLowerCase()) ||
                            p.portName.toLowerCase() === word.toLowerCase());
                        if (port && funcSym.filePath) {
                            return new Location(Uri.file(funcSym.filePath), new Position(Math.max(0, (port.line || 1) - 1), 0));
                        }
                    }
                }

                // Fallback to enclosing block declaration property
                const propMatch = findPropertyDeclaration(word, allTypes, enclosingDecl?.kind);
                if (propMatch && propMatch.prop.filePath) {
                    return new Location(Uri.file(propMatch.prop.filePath), new Position(Math.max(0, (propMatch.prop.line || 1) - 1), 0));
                }
            }

            // 2. Local ScopeStack declarations
            const { scopeTree: rootScope } = getCachedDocData(document);
            const scopeStack = buildScopeStack(rootScope, position.line + 1);
            const decl = findDeclarationInScopeStack(word, scopeStack);
            if (decl) {
                return new Location(document.uri, new Position(Math.max(0, decl.line - 1), 0));
            }

            // 3. Type definitions (if not followed by colon)
            if (!isFollowedByColon) {
                const t = allTypes.get(word) || (TYPE_ALIASES[word] ? allTypes.get(TYPE_ALIASES[word]) : undefined);
                if (t && t.filePath) {
                    return new Location(Uri.file(t.filePath), new Position(Math.max(0, (t.line || 1) - 1), 0));
                }
            } else {
                const propMatch = findPropertyDeclaration(word, allTypes, enclosingDecl?.kind);
                if (propMatch && propMatch.prop.filePath) {
                    return new Location(Uri.file(propMatch.prop.filePath), new Position(Math.max(0, (propMatch.prop.line || 1) - 1), 0));
                }
            }

            // 4. Library Symbols
            const allSymbols = getAllLibrarySymbols(document);
            const sym = allSymbols.get(word);
            if (sym && sym.filePath) {
                return new Location(Uri.file(sym.filePath), new Position(Math.max(0, (sym.line || 1) - 1), 0));
            }

            return undefined;
        }
    };

    const documentLinkProvider: DocumentLinkProvider = {
        provideDocumentLinks(document: TextDocument): DocumentLink[] {
            const links: DocumentLink[] = [];
            const text = document.getText();
            const lines = text.split('\n');
            const importRegex = /^\s*(?:import|use)\s+(?:(["'])(.*?)\1|([_a-zA-Z0-9.]+))/;

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const line = lines[lineIndex];
                const match = importRegex.exec(line);
                if (!match) continue;

                const importTarget = match[2] || match[3];
                if (!importTarget) continue;

                const targetFile = resolveImportFile(importTarget, document);
                if (targetFile) {
                    const startChar = line.indexOf(importTarget);
                    if (startChar >= 0) {
                        const startPos = new Position(lineIndex, startChar);
                        const endPos = new Position(lineIndex, startChar + importTarget.length);
                        const link = new DocumentLink(new Range(startPos, endPos), Uri.file(targetFile));
                        link.tooltip = `Follow import link (opens ${path.basename(targetFile)})`;
                        links.push(link);
                    }
                }
            }
            return links;
        }
    };

    const semanticTokenTypes = ['type', 'class', 'function', 'variable', 'property'];
    const semanticTokenModifiers = ['defaultLibrary', 'declaration'];
    const semanticTokensLegend = new SemanticTokensLegend(semanticTokenTypes, semanticTokenModifiers);

    function isStandardLibraryPath(filePath?: string): boolean {
        if (!filePath) return false;
        const norm = path.normalize(filePath).toLowerCase();
        const striderootDirs = getStrideRootDirs().map(d => path.normalize(d).toLowerCase());
        for (const d of striderootDirs) {
            if (norm.startsWith(d)) return true;
        }
        return norm.includes('strideroot') || (norm.includes('library') && !norm.includes('libgame'));
    }

    const semanticTokensProvider: DocumentSemanticTokensProvider = {
        provideDocumentSemanticTokens(document: TextDocument): SemanticTokens {
            const builder = new SemanticTokensBuilder(semanticTokensLegend);
            const text = document.getText();
            const maskedText = maskCommentsAndStrings(text);
            const lines = text.split('\n');
            const maskedLines = maskedText.split('\n');

            const allTypes = getAllTypes(document);
            const allSymbols = getAllLibrarySymbols(document);
            const libTypes = getLibraryTypes();

            const tokenRegex = /\b(_*[a-zA-Z0-9]+)\b/g;
            const ignoredWords = new Set([
                'import', 'use', 'version', 'with', 'as', 'for', 'in', 'streamRate',
                'and', 'or', 'not', 'on', 'off', 'none', 'true', 'false',
                'signal', 'switch', 'trigger', 'mainInputPort', 'mainOutputPort',
                'propertyInputPort', 'propertyOutputPort', 'port', 'typeProperty',
                'module', 'reaction', 'loop', 'state', 'transition', 'action', 'type',
                '_domainDefinition', 'gameDefinition', 'domainDeclaration', 'platformModule',
                'feature', 'force'
            ]);

            for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
                const lineText = lines[lineIndex];
                const maskedLine = maskedLines[lineIndex];
                if (!maskedLine.trim()) continue;

                let match;
                tokenRegex.lastIndex = 0;
                while ((match = tokenRegex.exec(maskedLine)) !== null) {
                    const token = match[1];
                    const charIndex = match.index;
                    const tokenLen = token.length;

                    // Skip numbers (integers, floats, hex, binary, with underscores or suffixes)
                    if (/^\d/.test(token) || parseNumericLiteral(token) !== undefined) {
                        continue;
                    }

                    // Check if followed by colon (property key)
                    // AGENTS.md Section 5 Invariant: If a token is followed by a colon (`:`), it is a property key
                    const afterToken = lineText.substring(charIndex + tokenLen);
                    const isFollowedByColon = /^\s*:(?!:)/.test(afterToken);

                    if (isFollowedByColon) {
                        builder.push(lineIndex, charIndex, tokenLen, 4, 0); // tokenType 4 = 'property'
                        continue;
                    }

                    // Check if preceded by dot (member access / entity property: Entity.member or .member)
                    const beforeToken = lineText.substring(0, charIndex);
                    // In a float literal like 0.5f32 or .5f32, do not treat fractional digits as a property
                    if (/\d\s*\.\s*$/.test(beforeToken) || (/\.\s*$/.test(beforeToken) && !/([_a-zA-Z0-9])\s*\.\s*$/.test(beforeToken))) {
                        continue;
                    }
                    const isPrecededByDot = /\.\s*$/.test(beforeToken);
                    if (isPrecededByDot) {
                        builder.push(lineIndex, charIndex, tokenLen, 4, 0); // tokenType 4 = 'property'
                        continue;
                    }

                    // Check if followed by dot (entity object in member access: Entity.member)
                    const isFollowedByDot = /^\s*\./.test(afterToken);
                    if (isFollowedByDot) {
                        const sym = allSymbols.get(token);
                        if (sym && (sym.kind === 'signal' || sym.kind === 'switch')) {
                            builder.push(lineIndex, charIndex, tokenLen, 3, 0); // variable
                        } else if (sym && (sym.kind === 'module' || sym.kind === 'reaction' || sym.kind === 'loop')) {
                            builder.push(lineIndex, charIndex, tokenLen, 2, 0); // function
                        } else {
                            builder.push(lineIndex, charIndex, tokenLen, 3, 0); // variable
                        }
                        continue;
                    }

                    // Skip keywords when not followed by colon
                    if (ignoredWords.has(token)) {
                        continue;
                    }

                    // 1. Built-in Primitive Scalars
                    if (BUILTIN_SCALARS[token]) {
                        builder.push(lineIndex, charIndex, tokenLen, 0, 1); // tokenType 0 = 'type', modifier bit 0 = 'defaultLibrary' (Green)
                        continue;
                    }

                    // 2. Known Types from schema
                    const targetKind = TYPE_ALIASES[token] || token;
                    const tInfo = allTypes.get(token) || allTypes.get(targetKind);
                    if (tInfo) {
                        const isLibType = libTypes.has(tInfo.name) && isStandardLibraryPath(libTypes.get(tInfo.name)?.filePath || tInfo.filePath);
                        if (isLibType) {
                            // Standard library primitive/type -> support.type.primitive.stride (Green)
                            builder.push(lineIndex, charIndex, tokenLen, 0, 1); // tokenType 0 = 'type', modifier bit 0 = 'defaultLibrary'
                        } else {
                            // Framework or local import type -> entity.name.type.class.stride (Different Color)
                            builder.push(lineIndex, charIndex, tokenLen, 1, 0); // tokenType 1 = 'class'
                        }
                        continue;
                    }

                    // 3. Known Symbols (framework descriptions, platform data types, functions, reactions, signals, etc.)
                    const sym = allSymbols.get(token);
                    if (sym) {
                        if (sym.kind === 'frameworkDataType') {
                            builder.push(lineIndex, charIndex, tokenLen, 0, 1); // type.defaultLibrary (Green)
                        } else if (sym.kind === '_frameworkDescription' || sym.kind === 'gameDefinition' || sym.kind === '_domainDefinition' || sym.kind === 'domainDeclaration') {
                            builder.push(lineIndex, charIndex, tokenLen, 1, 0); // class (Different Color)
                        } else if (sym.kind === 'signal' || sym.kind === 'switch') {
                            builder.push(lineIndex, charIndex, tokenLen, 3, 0); // tokenType 3 = 'variable'
                        } else {
                            const isLibSym = isStandardLibraryPath(sym.filePath);
                            builder.push(lineIndex, charIndex, tokenLen, 2, isLibSym ? 1 : 0); // tokenType 2 = 'function'
                        }
                        continue;
                    }

                    // 4. Local ScopeStack declarations (including callable header ports and internal entities)
                    const { scopeTree: rootScope } = getCachedDocData(document);
                    const scopeStack = buildScopeStack(rootScope, lineIndex + 1);
                    const localDecl = findDeclarationInScopeStack(token, scopeStack);
                    if (localDecl) {
                        if (localDecl.kind === 'module' || localDecl.kind === 'reaction' || localDecl.kind === 'loop') {
                            builder.push(lineIndex, charIndex, tokenLen, 2, 0); // tokenType 2 = 'function'
                        } else {
                            builder.push(lineIndex, charIndex, tokenLen, 3, 0); // tokenType 3 = 'variable'
                        }
                        continue;
                    }
                }
            }

            return builder.build();
        }
    };

    const completionProvider: CompletionItemProvider = {
        provideCompletionItems(document: TextDocument, position: Position): CompletionItem[] | undefined {
            const lineText = document.lineAt(position.line).text;
            const linePrefix = lineText.substring(0, position.character);

            // 1. Check for import / use autocompletion FIRST (bypasses string check for import "...")
            const importMatch = /^\s*(?:import|use)\s+(?:(["'])([^"']*)|([_a-zA-Z0-9./\\]*))$/i.exec(linePrefix);
            if (importMatch && !linePrefix.includes('#')) {
                return getImportCompletions(document, linePrefix, importMatch);
            }

            // 2. Check for namespace autocompletion (e.g. Ns::, Generators::, Feature::)
            const nsMatch = /([_a-zA-Z0-9]+)::\s*([_a-zA-Z0-9]*)$/.exec(linePrefix);
            if (nsMatch) {
                const nsName = nsMatch[1];
                const memberPrefix = nsMatch[2];
                const nsItems = getNamespaceCompletions(document, nsName, memberPrefix);
                if (nsItems && nsItems.length > 0) {
                    return nsItems;
                }
            }

            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

            const items: CompletionItem[] = [];
            const allTypes = getAllTypes(document);
            const allSymbols = getAllLibrarySymbols(document);

            const dotMatch = /([_a-zA-Z0-9]+)\.\s*([_a-zA-Z0-9]*)$/.exec(linePrefix);
            if (dotMatch) {
                const entityName = dotMatch[1];
                const { scopeTree: rootScope } = getCachedDocData(document);
                const scopeStack = buildScopeStack(rootScope, position.line + 1);
                const decl = findDeclarationInScopeStack(entityName, scopeStack);
                const sym = allSymbols.get(entityName);
                const typeName = decl?.type || decl?.kind || sym?.kind;
                if (typeName) {
                    const targetType = allTypes.get(typeName) || allTypes.get(TYPE_ALIASES[typeName] || typeName);
                    if (targetType && targetType.properties) {
                        for (const prop of targetType.properties) {
                            const item = new CompletionItem(prop.name, CompletionItemKind.Property);
                            if (prop.types && prop.types.length > 0) {
                                item.detail = `${prop.name}: ${prop.types.join(' | ')}`;
                            }
                            if (prop.meta) {
                                item.documentation = new MarkdownString(prop.meta);
                            }
                            items.push(item);
                        }
                        if (items.length > 0) {
                            return items;
                        }
                    }
                }
            }

            for (const [typeName, tInfo] of allTypes.entries()) {
                const item = new CompletionItem(typeName, CompletionItemKind.Class);
                if (tInfo.meta) item.detail = tInfo.meta;
                items.push(item);
            }

            for (const [symName, sym] of allSymbols.entries()) {
                if (!items.find(i => i.label === symName)) {
                    let kind = CompletionItemKind.Function;
                    if (sym.kind === 'signal' || sym.kind === 'switch') kind = CompletionItemKind.Variable;
                    else if (sym.kind === 'state') kind = CompletionItemKind.Struct;
                    const item = new CompletionItem(symName, kind);
                    item.detail = `${sym.signature} (${path.basename(sym.filePath)})`;
                    if (sym.meta) item.documentation = new MarkdownString(sym.meta);
                    items.push(item);
                }
            }

            const keywords = [
                '_domainDefinition', 'gameDefinition', 'module', 'reaction', 'loop',
                'state', 'transition', 'action', 'platformModule', 'signal', 'switch', 'trigger', 'alias',
                'feature', '@with', '@force',
                'mainInputPort', 'mainOutputPort', 'propertyInputPort', 'propertyOutputPort',
                'import', 'use', 'version', 'streamRate', 'in', 'on', 'off', 'none',
                'Int', 'UInt', 'Real', 'Size', 'Int8', 'Int16', 'Int32', 'Int64',
                'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Float32', 'Float64', 'Switch', 'String',
                '_NumericTypes', '_IntegerTypes', '_FloatTypes', '_DataTypes',
                '_IntType', '_RealType', '_SwitchType', '_StateType',
                'default:', 'variants:', 'reset:', 'domain:', 'type:', 'rate:', 'meta:', 'entity:',
                'framework:', 'inputs:', 'outputs:', 'states:', 'transitions:', 'guard:', 'targetState:',
                'playerTypes:', 'supplies:', 'setupActions:', 'board:', 'stateMachines:', 'end:'
            ];

            for (const kw of keywords) {
                if (!items.find(i => i.label === kw)) {
                    const isProp = kw.endsWith(':');
                    const item = new CompletionItem(kw, isProp ? CompletionItemKind.Property : CompletionItemKind.Keyword);
                    items.push(item);
                }
            }

            const { scopeTree: rootScope } = getCachedDocData(document);
            const scopeStack = buildScopeStack(rootScope, position.line + 1);
            for (const s of scopeStack) {
                for (const [dName, decl] of s.declarations.entries()) {
                    if (!items.find(i => i.label === dName)) {
                        let cKind = CompletionItemKind.Variable;
                        if (decl.kind === 'module' || decl.kind === 'reaction' || decl.kind === 'loop') cKind = CompletionItemKind.Function;
                        else if (decl.kind === 'state' || decl.kind === 'transition') cKind = CompletionItemKind.Struct;
                        const item = new CompletionItem(dName, cKind);
                        item.detail = `${decl.signature} (${s.name})`;
                        if (decl.meta) item.documentation = new MarkdownString(decl.meta);
                        items.push(item);
                    }
                }
            }

            return items;
        }
    };

    const diagnosticCollection = languages.createDiagnosticCollection('stride');

    function validateDocument(document: TextDocument) {
        if (document.languageId !== 'stride') return;
        const docData = getCachedDocData(document);
        const text = document.getText();
        const maskedText = docData.maskedText;
        const lines = text.split(/\r?\n/);
        const diagnostics: Diagnostic[] = [];

        const allTypes = docData.allTypes;
        const rootScope = docData.scopeTree;

        // 1. Check Unbalanced Braces / Brackets on MASKED text (ignores strings and comments)
        let openBraces = 0;
        let openBrackets = 0;
        for (let i = 0; i < maskedText.length; i++) {
            const ch = maskedText[i];
            if (ch === '{') openBraces++;
            else if (ch === '}') openBraces--;
            else if (ch === '[') openBrackets++;
            else if (ch === ']') openBrackets--;
        }
        if (openBraces !== 0) {
            const lastLine = Math.max(0, lines.length - 1);
            diagnostics.push(new Diagnostic(
                new Range(lastLine, 0, lastLine, lines[lastLine].length),
                `Syntax Error: Unbalanced curly braces { } (mismatch count: ${Math.abs(openBraces)})`,
                DiagnosticSeverity.Error
            ));
        }
        if (openBrackets !== 0) {
            const lastLine = Math.max(0, lines.length - 1);
            diagnostics.push(new Diagnostic(
                new Range(lastLine, 0, lastLine, lines[lastLine].length),
                `Syntax Error: Unbalanced square brackets [ ] (mismatch count: ${Math.abs(openBrackets)})`,
                DiagnosticSeverity.Error
            ));
        }

        // 2. Validate Declarations (Unknown Type, Invalid Properties, Mutual Exclusivity) on MASKED text
        const ignoredKeywords = new Set(['import', 'use', 'version', 'streamRate']);
        const vWordRegex = /\b([_a-zA-Z0-9]+)\b/g;
        let vMatch;

        while ((vMatch = vWordRegex.exec(maskedText)) !== null) {
            const kind = vMatch[1];
            const vIdx = vMatch.index;
            if (ignoredKeywords.has(kind)) continue;

            const afterWord = maskedText.substring(vIdx + kind.length).trimStart();
            if (afterWord.startsWith(':') && !afterWord.startsWith('::')) continue;

            let name: string | undefined;
            let bracketContent: string | undefined;
            let headerEnd = -1;
            let bodyStart = -1;
            let isCallable = false;
            let parsedHeader: ParsedCallableHeader | undefined;

            if (kind === 'module' || kind === 'reaction' || kind === 'loop') {
                const callableInfo = findCallableBodyStart(maskedText, vIdx + kind.length);
                if (callableInfo) {
                    parsedHeader = parseCallableHeader(kind, callableInfo.headerStr);
                    name = parsedHeader.callableName;
                    bodyStart = callableInfo.bodyStart;
                    headerEnd = callableInfo.bodyStart;
                    isCallable = true;
                }
            }

            if (!isCallable) {
                const stdRegex = /^([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/;
                const sub = maskedText.substring(vIdx);
                const stdMatch = stdRegex.exec(sub);
                if (stdMatch && stdMatch[1] === kind) {
                    name = stdMatch[2];
                    bracketContent = stdMatch[3] ? stdMatch[3].trim() : undefined;
                    headerEnd = vIdx + stdMatch[0].length;
                    bodyStart = headerEnd;
                } else {
                    continue;
                }
            }

            const lineNum = getLineNumber(text, vIdx) - 1;
            const lineText = lines[lineNum] || '';
            const kindPos = lineText.indexOf(kind);
            const kindRange = new Range(lineNum, kindPos >= 0 ? kindPos : 0, lineNum, kindPos >= 0 ? kindPos + kind.length : 10);

            // Callable-specific validations:
            if (isCallable && parsedHeader) {
                if (kind === 'reaction' && parsedHeader.hasMainInputs) {
                    diagnostics.push(new Diagnostic(
                        kindRange,
                        `Syntax Error: Reactions cannot declare main input streams.`,
                        DiagnosticSeverity.Error
                    ));
                }
            }

            if (bracketContent !== undefined && bracketContent.includes(' in ')) {
                const genMatch = /^\s*([_a-zA-Z0-9]+)\s+in\s+(.+)$/.exec(bracketContent);
                if (!genMatch) {
                    diagnostics.push(new Diagnostic(
                        new Range(lineNum, 0, lineNum, lines[lineNum]?.length || 10),
                        `Syntax Error in generator declaration: expected '[<Variable> in <Range>]'`,
                        DiagnosticSeverity.Error
                    ));
                }
            }

            const targetKind = TYPE_ALIASES[kind] || kind;
            const isKnownType = BUILTIN_SCALARS[kind] || allTypes.has(kind) || allTypes.has(targetKind);

            if (!isKnownType && kind !== 'type' && kind !== 'alias' && kind !== 'resource' && kind !== 'domainResource' && kind !== '_frameworkDescription') {
                diagnostics.push(new Diagnostic(
                    kindRange,
                    `Unknown Type Error. Type '${kind}' not recognized.`,
                    DiagnosticSeverity.Error
                ));
            }

            // Validate Properties inside declaration block dynamically from schema
            const block = extractBraceBlock(text, bodyStart, maskedText);
            if (block) {
                if (isCallable && parsedHeader) {
                    const hasPortsProp = /\bports\s*:/.test(block.maskedBody);
                    const hasCodeProp = /\bcode\s*:/.test(block.maskedBody);
                    const hasConflictingProp = /\b(?:entities|blocks|streams)\s*:/.test(block.maskedBody);

                    if (parsedHeader.hasHeaderPorts && hasPortsProp) {
                        diagnostics.push(new Diagnostic(
                            kindRange,
                            `Mutual Exclusivity Error: Header ports and 'ports:' property are mutually exclusive in '${name || kind}'.`,
                            DiagnosticSeverity.Error
                        ));
                    }
                    if (hasCodeProp && hasConflictingProp) {
                        diagnostics.push(new Diagnostic(
                            kindRange,
                            `Mutual Exclusivity Error: 'code:' and 'entities:'/'streams:' properties are mutually exclusive in '${name || kind}'.`,
                            DiagnosticSeverity.Error
                        ));
                    }
                }

                if (isKnownType) {
                    const allowedProps = resolveAllPropertiesForType(kind, allTypes);
                    const maskedBodyStr = block.maskedBody;

                    const propRegex = /\b([_a-zA-Z0-9]+)\s*:/g;
                    let depth = 0;
                    let bIndex = 0;
                    while (bIndex < maskedBodyStr.length) {
                        const ch = maskedBodyStr[bIndex];
                        if (ch === '{' || ch === '[') {
                            depth++;
                            bIndex++;
                            continue;
                        }
                        if (ch === '}' || ch === ']') {
                            if (depth > 0) depth--;
                            bIndex++;
                            continue;
                        }
                        if (depth === 0) {
                            propRegex.lastIndex = bIndex;
                            const pMatch = propRegex.exec(maskedBodyStr);
                            if (pMatch && pMatch.index === bIndex) {
                                const propName = pMatch[1];
                                const globalChar = bodyStart + 1 + pMatch.index;
                                const pStart = document.positionAt(globalChar);
                                const pEnd = document.positionAt(globalChar + propName.length);

                                if (allowedProps.size > 0 && !allowedProps.has(propName)) {
                                    diagnostics.push(new Diagnostic(
                                        new Range(pStart, pEnd),
                                        `Invalid Property Error. Property '${propName}' is not defined for type '${kind}'.`,
                                        DiagnosticSeverity.Error
                                    ));
                                } else if (allowedProps.size > 0 && allowedProps.has(propName)) {
                                    const propInfo = allowedProps.get(propName);
                                    if (propInfo && propInfo.writeable === false) {
                                        diagnostics.push(new Diagnostic(
                                            new Range(pStart, pEnd),
                                            `ReadOnly Property Error: Cannot write to property '${propName}' in declaration of '${name || kind}'. Property is not writeable (writeable: off).`,
                                            DiagnosticSeverity.Error
                                        ));
                                    }
                                }
                                bIndex += pMatch[0].length;
                                continue;
                            }
                        }
                        bIndex++;
                    }
                }
            }

            vWordRegex.lastIndex = bodyStart;
        }

        // 3. Validate Duplicate Symbols in Scope
        function checkDuplicateScope(scope: ScopeContext) {
            const seen = new Map<string, ScopeDeclaration>();
            for (const [sName, sDecl] of scope.declarations.entries()) {
                if (sDecl.withCondition || scope.withCondition) continue;
                if (seen.has(sName)) {
                    const prev = seen.get(sName)!;
                    if (prev.withCondition) continue;
                    const dLine = Math.max(0, sDecl.line - 1);
                    const dLineText = lines[dLine] || '';
                    const pos = dLineText.indexOf(sName);
                    const range = new Range(dLine, pos >= 0 ? pos : 0, dLine, pos >= 0 ? pos + sName.length : 10);
                    diagnostics.push(new Diagnostic(
                        range,
                        `Duplicate Symbol Error. '${sName}' redefined on line ${sDecl.line} (previously on line ${prev.line})`,
                        DiagnosticSeverity.Error
                    ));
                } else {
                    seen.set(sName, sDecl);
                }
            }
            for (const child of scope.children) {
                checkDuplicateScope(child);
            }
        }
        checkDuplicateScope(rootScope);

        // 3b. Validate Feature Expressions (@with and @force directives)
        const declaredFeatures = new Map<string, Set<string>>(); // feature name -> set of variants
        const harvestFeaturesFromScope = (sc: ScopeContext) => {
            if (sc.kind === 'feature') {
                const varSet = new Set<string>(sc.variants || []);
                declaredFeatures.set(sc.name, varSet);
            }
            for (const [_, decl] of sc.declarations.entries()) {
                if (decl.kind === 'feature') {
                    const varSet = new Set<string>(decl.variants || []);
                    declaredFeatures.set(decl.name, varSet);
                }
            }
            for (const child of sc.children) {
                harvestFeaturesFromScope(child);
            }
        };
        harvestFeaturesFromScope(rootScope);

        const directiveRegex = /@(with|force)\s*\(/g;
        let dirMatch: RegExpExecArray | null;
        while ((dirMatch = directiveRegex.exec(maskedText)) !== null) {
            const dirKeyword = dirMatch[1];
            const openParenIdx = dirMatch.index + dirMatch[0].length - 1;
            const parenResult = extractBalancedParens(maskedText, openParenIdx);
            if (!parenResult) {
                const startPos = document.positionAt(dirMatch.index);
                const endPos = document.positionAt(dirMatch.index + dirMatch[0].length);
                diagnostics.push(new Diagnostic(
                    new Range(startPos, endPos),
                    `Unclosed parenthesis in @${dirKeyword} directive`,
                    DiagnosticSeverity.Error
                ));
                continue;
            }

            const exprText = parenResult.content;
            const exprOffset = openParenIdx + 1;

            // Validate feature identifiers in expression: Group::Variant or Feature
            const featTokRegex = /\b([_a-zA-Z][_a-zA-Z0-9]*(?:::[_a-zA-Z][_a-zA-Z0-9]*)?)\b/g;
            let fMatch: RegExpExecArray | null;
            while ((fMatch = featTokRegex.exec(exprText)) !== null) {
                const rawTok = fMatch[1];
                const tokOffset = exprOffset + fMatch.index;
                if (rawTok === 'true' || rawTok === 'false' || rawTok === 'on' || rawTok === 'off') {
                    continue;
                }

                if (rawTok.includes('::')) {
                    const parts = rawTok.split('::');
                    const group = parts[0];
                    const variant = parts[1];
                    if (!declaredFeatures.has(group)) {
                        const startPos = document.positionAt(tokOffset);
                        const endPos = document.positionAt(tokOffset + group.length);
                        diagnostics.push(new Diagnostic(
                            new Range(startPos, endPos),
                            `Undeclared feature symbol '${group}'`,
                            DiagnosticSeverity.Error
                        ));
                    } else {
                        const validVariants = declaredFeatures.get(group)!;
                        if (!validVariants.has(variant)) {
                            const varStartOffset = tokOffset + group.length + 2;
                            const startPos = document.positionAt(varStartOffset);
                            const endPos = document.positionAt(varStartOffset + variant.length);
                            diagnostics.push(new Diagnostic(
                                new Range(startPos, endPos),
                                `'${variant}' is not a valid variant of feature '${group}'`,
                                DiagnosticSeverity.Error
                            ));
                        }
                    }
                } else {
                    if (!declaredFeatures.has(rawTok)) {
                        const startPos = document.positionAt(tokOffset);
                        const endPos = document.positionAt(tokOffset + rawTok.length);
                        diagnostics.push(new Diagnostic(
                            new Range(startPos, endPos),
                            `Undeclared feature symbol '${rawTok}'`,
                            DiagnosticSeverity.Error
                        ));
                    }
                }
            }
        }

        // 4. Validate Undeclared Symbols and Lossy Conversions in Streams (ignoring string literals and comments)
        const validateStreamStatement = (stmtText: string, stmtGlobalIndex: number, stmtLine: number, stmtLength: number) => {
            const scopeStack = buildScopeStack(rootScope, stmtLine);

            // Validate Member Accesses: existence, public (for reads), writeable (for writes)
            const memberAccessRegex = /\b([_a-zA-Z0-9]+)\.([_a-zA-Z0-9]+)\b/g;
            let maMatch;
            while ((maMatch = memberAccessRegex.exec(stmtText)) !== null) {
                const entName = maMatch[1];
                const propName = maMatch[2];
                const decl = findDeclarationInScopeStack(entName, scopeStack);
                const sym = getAllLibrarySymbols(document).get(entName);
                const typeName = decl?.type || decl?.kind || sym?.kind;
                if (!typeName) continue;

                const allProps = resolveAllPropertiesForType(typeName, allTypes);
                const maIndex = stmtGlobalIndex + maMatch.index;
                const pStart = document.positionAt(maIndex + entName.length + 1);
                const pEnd = document.positionAt(maIndex + maMatch[0].length);

                if (allProps.size > 0 && !allProps.has(propName)) {
                    diagnostics.push(new Diagnostic(
                        new Range(pStart, pEnd),
                        `Invalid Property Error: Property '${propName}' is not defined for type '${typeName}'.`,
                        DiagnosticSeverity.Error
                    ));
                    continue;
                }

                const propInfo = allProps.get(propName);
                if (propInfo) {
                    const textBeforeMa = stmtText.slice(0, maMatch.index);
                    const isDest = textBeforeMa.includes('>>');

                    if (isDest) {
                        if (propInfo.writeable === false) {
                            diagnostics.push(new Diagnostic(
                                new Range(pStart, pEnd),
                                `ReadOnly Property Error: Port '${propName}' of type '${typeName}' is read only (writeable: off).`,
                                DiagnosticSeverity.Error
                            ));
                        }
                    } else {
                        if (propInfo.public === false) {
                            diagnostics.push(new Diagnostic(
                                new Range(pStart, pEnd),
                                `Private Property Error: Port '${propName}' of type '${typeName}' is private (public: off) and cannot be accessed externally.`,
                                DiagnosticSeverity.Error
                            ));
                        }
                    }
                }
            }

            // Validate Numeric Literals in Streams (fit within range, valid suffixes, no negative unsigned)
            const numLitPattern = /(?:(?<=[\s,(\[\-+*\/><=]|^)[+-])?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*[a-zA-Z0-9]*|0[bB][01](?:_?[01])*[a-zA-Z0-9]*|[0-9](?:_?[0-9])*\.(?!\.)[0-9]*(?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?[a-zA-Z0-9]*|(?<![0-9a-zA-Z_])\.[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?[a-zA-Z0-9]*|[0-9](?:_?[0-9])*[eE][+-]?[0-9](?:_?[0-9])*[a-zA-Z0-9]*|[0-9](?:_?[0-9])*[a-zA-Z0-9]+|[0-9](?:_?[0-9])*)/g;
            let numMatch;
            while ((numMatch = numLitPattern.exec(stmtText)) !== null) {
                const litStr = numMatch[0];
                if (!litStr || litStr === '+' || litStr === '-') continue;
                const afterLit = stmtText.slice(numMatch.index + litStr.length);
                if (/^\.\./.test(afterLit)) continue;

                const parsed = parseNumericLiteral(litStr);
                if (parsed && parsed.error) {
                    const globalCharIndex = stmtGlobalIndex + numMatch.index;
                    const startPos = document.positionAt(globalCharIndex);
                    const endPos = document.positionAt(globalCharIndex + litStr.length);
                    diagnostics.push(new Diagnostic(
                        new Range(startPos, endPos),
                        parsed.error,
                        DiagnosticSeverity.Error
                    ));
                }
            }

            const tokenRegex = /\b([_a-zA-Z0-9]+)\b/g;
            let tokMatch;
            while ((tokMatch = tokenRegex.exec(stmtText)) !== null) {
                const tok = tokMatch[1];
                if (/^\d/.test(tok) || parseNumericLiteral(tok) !== undefined || tok === 'on' || tok === 'off' || tok === 'none' || tok === 'true' || tok === 'false' || tok === 'with' || tok === 'force' || tok === 'feature') continue;
                if (tok === 'llvm' || tok === 'icmp' || tok === 'fcmp' || tok === 'eq' || tok === 'ne' || tok === 'sgt' || tok === 'sge' || tok === 'slt' || tok === 'sle') continue;

                // If token is immediately followed by a colon (e.g. `entityType:`, `targetSupply:`, `count:`),
                // it is a named parameter / port key in a function or reaction invocation, not an undeclared symbol.
                const afterTok = stmtText.slice(tokMatch.index + tok.length);
                if (/^\s*:/.test(afterTok)) continue;

                // If token is preceded by a dot (e.g. `ValidInst.publicReadOnly`, `.publicReadOnly`),
                // it is a member access / entity property, not an undeclared symbol.
                const beforeTok = stmtText.slice(0, tokMatch.index);
                if (/\.\s*$/.test(beforeTok)) continue;

                const decl = findDeclarationInScopeStack(tok, scopeStack);
                const isLibSym = getAllLibrarySymbols(document).has(tok);
                const isTypeSym = allTypes.has(tok) || BUILTIN_SCALARS[tok];

                if (!decl && !isLibSym && !isTypeSym) {
                    const globalCharIndex = stmtGlobalIndex + tokMatch.index;
                    const startPos = document.positionAt(globalCharIndex);
                    const endPos = document.positionAt(globalCharIndex + tok.length);
                    diagnostics.push(new Diagnostic(
                        new Range(startPos, endPos),
                        `Undeclared Symbol '${tok}'`,
                        DiagnosticSeverity.Error
                    ));
                }
            }

            // Validate Lossy Conversions in Streams (Warning severity with squiggly lines)
            const stages = stmtText.split(/\s*>>\s*/);
            if (stages.length >= 2) {
                const resolveOperandType = (operand: string): { type?: string; isLiteral?: boolean; literalVal?: string } => {
                    const trimmed = operand.trim();
                    const parsedLit = parseNumericLiteral(trimmed);
                    if (parsedLit && parsedLit.isValid) {
                        return { type: parsedLit.type, isLiteral: true, literalVal: trimmed };
                    }
                    if (trimmed === 'on' || trimmed === 'off') {
                        return { type: 'Switch', isLiteral: true, literalVal: trimmed };
                    }
                    const memberMatch = /^([_a-zA-Z0-9]+)\.([_a-zA-Z0-9]+)$/.exec(trimmed);
                    if (memberMatch) {
                        const entName = memberMatch[1];
                        const propName = memberMatch[2];
                        const decl = findDeclarationInScopeStack(entName, scopeStack);
                        if (decl && (decl.type || decl.kind)) {
                            const tName = decl.type || decl.kind;
                            const tInfo = allTypes.get(tName) || allTypes.get(TYPE_ALIASES[tName] || tName);
                            if (tInfo && tInfo.properties) {
                                const pInfo = tInfo.properties.find(p => p.name === propName);
                                if (pInfo && pInfo.types && pInfo.types.length > 0) {
                                    return { type: pInfo.types[0] };
                                }
                            }
                        }
                        return { type: 'Real' };
                    }
                    const idMatch = /^([_a-zA-Z0-9]+)/.exec(trimmed);
                    if (idMatch) {
                        const symName = idMatch[1];
                        const decl = findDeclarationInScopeStack(symName, scopeStack);
                        if (decl) {
                            return { type: decl.type || 'Real' };
                        }
                    }
                    const binMatch = /(.+?)\s*([\+\-\*\/])\s*(.+)/.exec(trimmed);
                    if (binMatch) {
                        const left = resolveOperandType(binMatch[1]);
                        const right = resolveOperandType(binMatch[3]);
                        if (left.type && right.type) {
                            const leftInfo = DATA_TYPE_MAP[left.type];
                            const rightInfo = DATA_TYPE_MAP[right.type];
                            if (leftInfo && rightInfo) {
                                if (leftInfo.kind === 'float' || rightInfo.kind === 'float') {
                                    const promoted = (leftInfo.bits || 64) >= (rightInfo.bits || 64) ? (leftInfo.kind === 'float' ? left.type : right.type) : right.type;
                                    return { type: promoted };
                                }
                                const s1 = leftInfo.signed ?? true;
                                const s2 = rightInfo.signed ?? true;
                                const b1 = leftInfo.bits || 32;
                                const b2 = rightInfo.bits || 32;
                                if (s1 === s2) {
                                    return { type: b1 >= b2 ? left.type : right.type };
                                }
                                const signedBits = s1 ? b1 : b2;
                                const unsignedBits = s1 ? b2 : b1;
                                if (signedBits > unsignedBits) {
                                    return { type: s1 ? left.type : right.type };
                                }
                                const neededBits = unsignedBits * 2;
                                if (neededBits <= 16) return { type: 'Int16' };
                                if (neededBits <= 32) return { type: 'Int32' };
                                return { type: 'Int64' };
                            }
                        }
                    }
                    return {};
                };

                for (let stageIdx = 0; stageIdx < stages.length - 1; stageIdx++) {
                    const srcStr = stages[stageIdx];
                    const dstStr = stages[stageIdx + 1];
                    const srcInfo = resolveOperandType(srcStr);
                    const dstInfo = resolveOperandType(dstStr);

                    if (dstInfo.type) {
                        let riskMsg: string | null = null;
                        if (srcInfo.isLiteral && srcInfo.literalVal !== undefined) {
                            riskMsg = getLiteralConversionRisk(srcInfo.literalVal, dstInfo.type);
                        } else if (srcInfo.type) {
                            riskMsg = getConversionRisk(srcInfo.type, dstInfo.type);
                        }

                        if (riskMsg) {
                            const startPos = document.positionAt(stmtGlobalIndex);
                            const endPos = document.positionAt(stmtGlobalIndex + stmtLength);
                            diagnostics.push(new Diagnostic(
                                new Range(startPos, endPos),
                                `Warning: Conversion from '${srcInfo.type || 'literal'}' to '${dstInfo.type}' ${riskMsg}`,
                                DiagnosticSeverity.Warning
                            ));
                        }
                    }
                }
            }
        };

        const streamBlockRegex = /\b(?:streams|onTransition|code)\s*:\s*\[/g;
        let sMatch;
        while ((sMatch = streamBlockRegex.exec(maskedText)) !== null) {
            const sStart = sMatch.index + sMatch[0].length - 1;
            const sBlock = extractSquareBracketBlock(text, sStart, maskedText);
            if (!sBlock) continue;
            const sLine = getLineNumber(text, sMatch.index);
            let maskedStreamBody = sBlock.maskedBody;
            if (sMatch[0].startsWith('code')) {
                // Mask out declaration blocks inside code: [ ... ] so only stream statements are checked
                const innerDeclRegex = /\b(?:signal|switch|buffer|module|reaction|loop)\b[^{]*\{[^{}]*\}/g;
                maskedStreamBody = maskedStreamBody.replace(innerDeclRegex, (mStr) => ' '.repeat(mStr.length));
            }

            const streamStmtRegex = /([^;]+);/g;
            let stmtMatch;
            while ((stmtMatch = streamStmtRegex.exec(maskedStreamBody)) !== null) {
                const stmtText = stmtMatch[1];
                validateStreamStatement(stmtText, sStart + 1 + stmtMatch.index, sLine, stmtMatch[0].length);
            }
        }

        // Validate top-level stream statements (at brace/bracket depth 0)
        let topBraceDepth = 0;
        let topBracketDepth = 0;
        let stmtStartIndex = 0;
        for (let i = 0; i < maskedText.length; i++) {
            const ch = maskedText[i];
            if (ch === '{') {
                topBraceDepth++;
            } else if (ch === '}') {
                if (topBraceDepth > 0) topBraceDepth--;
                if (topBraceDepth === 0 && topBracketDepth === 0) {
                    stmtStartIndex = i + 1;
                }
            } else if (ch === '[') {
                topBracketDepth++;
            } else if (ch === ']') {
                if (topBracketDepth > 0) topBracketDepth--;
                if (topBraceDepth === 0 && topBracketDepth === 0) {
                    stmtStartIndex = i + 1;
                }
            } else if (ch === ';') {
                if (topBraceDepth === 0 && topBracketDepth === 0) {
                    const rawStmt = maskedText.substring(stmtStartIndex, i);
                    if (rawStmt.includes('>>')) {
                        const stmtTrimmed = rawStmt.trim();
                        if (stmtTrimmed) {
                            const offsetInRaw = rawStmt.indexOf(stmtTrimmed);
                            const actualBase = stmtStartIndex + (offsetInRaw >= 0 ? offsetInRaw : 0);
                            const stmtLine = getLineNumber(text, actualBase);
                            validateStreamStatement(stmtTrimmed, actualBase, stmtLine, stmtTrimmed.length);
                        }
                    }
                    stmtStartIndex = i + 1;
                }
            }
        }

        diagnosticCollection.set(document.uri, diagnostics);
    }

    const validationTimers = new Map<string, NodeJS.Timeout>();

    function scheduleValidation(document: TextDocument) {
        if (document.languageId !== 'stride') return;
        const key = document.uri.toString();
        const existing = validationTimers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const timer = setTimeout(() => {
            validationTimers.delete(key);
            validateDocument(document);
        }, 250);
        validationTimers.set(key, timer);
    }

    // Validate active documents
    for (const doc of workspace.textDocuments) {
        validateDocument(doc);
    }

    const fileWatcher = workspace.createFileSystemWatcher('**/*.stride');
    fileWatcher.onDidCreate(() => invalidateLibraryCache());
    fileWatcher.onDidChange(() => invalidateLibraryCache());
    fileWatcher.onDidDelete(() => invalidateLibraryCache());

    const configWatcher = workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('stride')) {
            invalidateLibraryCache();
        }
    });

    context.subscriptions.push(
        diagnosticCollection,
        fileWatcher,
        configWatcher,
        workspace.onDidOpenTextDocument(doc => validateDocument(doc)),
        workspace.onDidChangeTextDocument(e => scheduleValidation(e.document)),
        workspace.onDidSaveTextDocument(doc => {
            if (doc.languageId === 'stride') {
                docCache.clear();
                for (const openDoc of workspace.textDocuments) {
                    if (openDoc.languageId === 'stride') {
                        scheduleValidation(openDoc);
                    }
                }
            } else {
                validateDocument(doc);
            }
        }),
        workspace.onDidCloseTextDocument(doc => {
            const key = doc.uri.toString();
            const timer = validationTimers.get(key);
            if (timer) {
                clearTimeout(timer);
                validationTimers.delete(key);
            }
            docCache.delete(key);
            diagnosticCollection.delete(doc.uri);
        }),
        languages.registerDocumentSymbolProvider({ scheme: 'file', language: 'stride' }, symbolProvider),
        languages.registerHoverProvider({ scheme: 'file', language: 'stride' }, hoverProvider),
        languages.registerDefinitionProvider({ scheme: 'file', language: 'stride' }, definitionProvider),
        languages.registerDocumentLinkProvider({ scheme: 'file', language: 'stride' }, documentLinkProvider),
        languages.registerDocumentSemanticTokensProvider(
            { scheme: 'file', language: 'stride' },
            semanticTokensProvider,
            semanticTokensLegend
        ),
        languages.registerCompletionItemProvider({ scheme: 'file', language: 'stride' }, completionProvider, '.', ':', '>', '/', '\\', '"', '\'')
    );
}

// ============================================================================
// Stride Compilation, Unit Testing & Debug/F5 Launch Support
// ============================================================================

let strideTerminal: Terminal | undefined;

function getOrCreateTerminal(name: string): Terminal {
    if (strideTerminal && !strideTerminal.exitStatus) {
        return strideTerminal;
    }
    const existing = window.terminals.find(t => t.name === name);
    if (existing && !existing.exitStatus) {
        strideTerminal = existing;
        return existing;
    }
    strideTerminal = window.createTerminal({ name });
    return strideTerminal;
}

function expandVariables(str: string, filePath: string, workspaceFolder?: WorkspaceFolder): string {
    const parsed = path.parse(filePath);
    const wsFolder = workspaceFolder ? workspaceFolder.uri.fsPath : (workspace.workspaceFolders?.[0]?.uri.fsPath || parsed.dir);
    return str
        .replace(/\${file}/g, filePath)
        .replace(/\${fileDirname}/g, parsed.dir)
        .replace(/\${fileBasename}/g, parsed.base)
        .replace(/\${fileBasenameNoExtension}/g, parsed.name)
        .replace(/\${fileExtname}/g, parsed.ext)
        .replace(/\${workspaceFolder}/g, wsFolder);
}

function findExecutable(toolName: string, configSetting: string, envVar: string, searchSubpaths: string[]): string {
    const config = workspace.getConfiguration('stride');
    const configured = config.get<string>(configSetting);
    if (configured && fs.existsSync(configured)) {
        return configured;
    }

    const envPath = process.env[envVar];
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }

    const roots: string[] = [];
    if (workspace.workspaceFolders) {
        for (const wf of workspace.workspaceFolders) {
            roots.push(wf.uri.fsPath);
            roots.push(path.dirname(wf.uri.fsPath));
        }
    }
    if (extensionContext) {
        roots.push(extensionContext.extensionPath);
        roots.push(path.dirname(extensionContext.extensionPath));
    }

    for (const r of roots) {
        for (const sp of searchSubpaths) {
            const candidate = path.isAbsolute(sp) ? sp : path.join(r, sp);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return toolName;
}

function quoteArg(arg: string): string {
    if ((arg.includes(' ') || arg.includes('\t')) && !arg.startsWith('"')) {
        return `"${arg}"`;
    }
    return arg;
}

function buildCommandLine(executable: string, args: (string | undefined)[]): string {
    const validArgs = args.filter((a): a is string => Boolean(a && a.trim().length > 0));
    const quotedExe = quoteArg(executable);
    const formattedArgs = validArgs.map(quoteArg).join(' ');

    if (process.platform === 'win32') {
        if (quotedExe.startsWith('"')) {
            return `& ${quotedExe} ${formattedArgs}`;
        }
    }
    return `${quotedExe} ${formattedArgs}`;
}

async function executeStrideLaunchConfig(config: DebugConfiguration, targetUri?: Uri): Promise<void> {
    let activeDoc = window.activeTextEditor?.document;
    if (targetUri) {
        const found = workspace.textDocuments.find(d => d.uri.toString() === targetUri.toString());
        if (found) {
            activeDoc = found;
        }
    }

    if (activeDoc && activeDoc.isDirty) {
        await activeDoc.save();
    }

    const currentFile = targetUri ? targetUri.fsPath : (activeDoc ? activeDoc.fileName : undefined);
    if (!currentFile && !config.file) {
        window.showErrorMessage('No active Stride file to run or compile.');
        return;
    }

    const wsFolder = currentFile ? workspace.getWorkspaceFolder(Uri.file(currentFile)) : workspace.workspaceFolders?.[0];
    const rawFile = config.file || '${file}';
    const filePath = expandVariables(rawFile, currentFile || '', wsFolder);

    if (!fs.existsSync(filePath)) {
        window.showErrorMessage(`Stride file not found: ${filePath}`);
        return;
    }

    const effectiveStrideroot = getEffectiveStrideRoot();
    const mode = (config.mode || 'compile').toLowerCase();

    if (mode === 'test') {
        const testRunner = findExecutable('stridetest', 'stridetestPath', 'STRIDETEST_PATH', [
            'boardgame/build/Desktop_Qt_6_7_3_MSVC2022_64bit-Debug/libgame/external/stridejit/stridetest.exe',
            'boardgame/build/Desktop_Qt_6_7_3_MSVC2022_64bit-Release/libgame/external/stridejit/stridetest.exe',
            'Stride/build/stridejit/stridetest.exe',
            'build/external/stridejit/stridetest.exe',
            'build/stridetest.exe',
            'bin/stridetest.exe'
        ]);
        const terminal = getOrCreateTerminal('Stride: Test');
        terminal.show();

        const extraArgs: string[] = [];
        if (effectiveStrideroot) {
            extraArgs.push('--root', effectiveStrideroot);
        }
        if (config.args && Array.isArray(config.args)) {
            extraArgs.push(...config.args);
        }

        const cmd = buildCommandLine(testRunner, [filePath, ...extraArgs]);
        terminal.sendText(cmd);
    } else if (mode === 'compile') {
        const compiler = findExecutable('stridec', 'stridecPath', 'STRIDEC_PATH', [
            'build-Stride-Desktop_Qt_6_5_1_MSVC2019_64bit-Release/compiler/stridec.exe',
            'build-Stride-Desktop_Qt_6_5_1_MSVC2019_64bit-Debug/compiler/stridec.exe',
            'Stride/build/compiler/stridec.exe',
            'build/compiler/stridec.exe',
            'compiler/stridec.exe',
            'bin/stridec.exe'
        ]);
        const terminal = getOrCreateTerminal('Stride: Compile');
        terminal.show();

        const defaultOut = `${path.join(path.dirname(filePath), path.parse(filePath).name)}.o`;
        const defaultHdr = `${path.join(path.dirname(filePath), path.parse(filePath).name)}.h`;
        const outFile = config.output ? expandVariables(config.output, filePath, wsFolder) : defaultOut;
        const hdrFile = config.header ? expandVariables(config.header, filePath, wsFolder) : defaultHdr;

        const extraArgs: string[] = ['-c', filePath, '-o', outFile, `--emit-header=${hdrFile}`];
        if (effectiveStrideroot) {
            extraArgs.push(`--strideroot=${effectiveStrideroot}`);
        }

        const configuredFeatures = (config.features && Array.isArray(config.features))
            ? config.features
            : workspace.getConfiguration('stride').get<string[]>('features');
        if (configuredFeatures && Array.isArray(configuredFeatures)) {
            for (const f of configuredFeatures) {
                extraArgs.push('-D', f);
            }
        }
        const configuredDisabledFeatures = (config.disabledFeatures && Array.isArray(config.disabledFeatures))
            ? config.disabledFeatures
            : workspace.getConfiguration('stride').get<string[]>('disabledFeatures');
        if (configuredDisabledFeatures && Array.isArray(configuredDisabledFeatures)) {
            for (const f of configuredDisabledFeatures) {
                extraArgs.push('--no-feature', f);
            }
        }
        const configuredNoDefault = config.noDefaultFeatures !== undefined
            ? config.noDefaultFeatures
            : workspace.getConfiguration('stride').get<boolean>('noDefaultFeatures');
        if (configuredNoDefault) {
            extraArgs.push('--no-default-features');
        }

        if (config.args && Array.isArray(config.args)) {
            extraArgs.push(...config.args);
        }

        const cmd = buildCommandLine(compiler, extraArgs);
        terminal.sendText(cmd);
    } else if (mode === 'flash') {
        const compiler = findExecutable('stridec', 'stridecPath', 'STRIDEC_PATH', [
            'build-Stride-Desktop_Qt_6_5_1_MSVC2019_64bit-Release/compiler/stridec.exe',
            'build-Stride-Desktop_Qt_6_5_1_MSVC2019_64bit-Debug/compiler/stridec.exe',
            'Stride/build/compiler/stridec.exe',
            'build/compiler/stridec.exe',
            'compiler/stridec.exe',
            'bin/stridec.exe'
        ]);
        const terminal = getOrCreateTerminal('Stride: Flash');
        terminal.show();

        const defaultOut = `${path.join(path.dirname(filePath), path.parse(filePath).name)}.o`;
        const defaultHdr = `${path.join(path.dirname(filePath), path.parse(filePath).name)}.h`;
        const outFile = config.output ? expandVariables(config.output, filePath, wsFolder) : defaultOut;
        const hdrFile = config.header ? expandVariables(config.header, filePath, wsFolder) : defaultHdr;

        const extraArgs: string[] = ['-c', filePath, '-o', outFile, `--emit-header=${hdrFile}`];
        if (effectiveStrideroot) {
            extraArgs.push(`--strideroot=${effectiveStrideroot}`);
        }

        const configuredFeatures = (config.features && Array.isArray(config.features))
            ? config.features
            : workspace.getConfiguration('stride').get<string[]>('features');
        if (configuredFeatures && Array.isArray(configuredFeatures)) {
            for (const f of configuredFeatures) {
                extraArgs.push('-D', f);
            }
        }
        const configuredDisabledFeatures = (config.disabledFeatures && Array.isArray(config.disabledFeatures))
            ? config.disabledFeatures
            : workspace.getConfiguration('stride').get<string[]>('disabledFeatures');
        if (configuredDisabledFeatures && Array.isArray(configuredDisabledFeatures)) {
            for (const f of configuredDisabledFeatures) {
                extraArgs.push('--no-feature', f);
            }
        }
        const configuredNoDefault = config.noDefaultFeatures !== undefined
            ? config.noDefaultFeatures
            : workspace.getConfiguration('stride').get<boolean>('noDefaultFeatures');
        if (configuredNoDefault) {
            extraArgs.push('--no-default-features');
        }
        const cmd = buildCommandLine(compiler, extraArgs);
        terminal.sendText(cmd);

        const flashNotice = 'Target binary compiled. Hardware flash / run is designated as a future capability and will be supported in an upcoming release.';
        terminal.sendText(process.platform === 'win32'
            ? `Write-Host "${flashNotice}" -ForegroundColor Cyan`
            : `echo "${flashNotice}"`
        );
        window.showInformationMessage(`Target build generated for ${path.basename(filePath)}. Device flash/run is designated as a future feature.`);
    } else {
        window.showErrorMessage(`Unknown Stride execution mode: ${mode}`);
    }
}

interface StrideQuickPickItem extends QuickPickItem {
    mode: 'test' | 'compile' | 'flash';
}

class StrideDebugConfigurationProvider implements DebugConfigurationProvider {
    provideDebugConfigurations(folder?: WorkspaceFolder, token?: CancellationToken): ProviderResult<DebugConfiguration[]> {
        return [
            {
                type: 'stride',
                request: 'launch',
                name: 'Stride: Run Unit Tests in File',
                mode: 'test',
                file: '${file}'
            },
            {
                type: 'stride',
                request: 'launch',
                name: 'Stride: Compile File to Disk',
                mode: 'compile',
                file: '${file}',
                output: '${fileDirname}/${fileBasenameNoExtension}.o',
                header: '${fileDirname}/${fileBasenameNoExtension}.h'
            },
            {
                type: 'stride',
                request: 'launch',
                name: 'Stride: Build and Flash / Run (Future)',
                mode: 'flash',
                file: '${file}'
            }
        ];
    }

    async resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): Promise<DebugConfiguration | undefined> {
        if (!config.type && !config.request && !config.name) {
            const editor = window.activeTextEditor;
            if (editor && editor.document.languageId === 'stride') {
                const items: StrideQuickPickItem[] = [
                    {
                        label: '$(beaker) Stride: Run Unit Tests in File',
                        description: 'Execute unit tests via stridetest',
                        mode: 'test'
                    },
                    {
                        label: '$(file-binary) Stride: Compile File to Disk',
                        description: 'Compile file to .o object and .h header via stridec',
                        mode: 'compile'
                    },
                    {
                        label: '$(zap) Stride: Build and Flash / Run (Future)',
                        description: 'Compile and prepare hardware upload',
                        mode: 'flash'
                    }
                ];

                const selected = await window.showQuickPick(items, {
                    placeHolder: 'Select Stride launch configuration'
                });

                if (!selected) {
                    return undefined;
                }

                config.type = 'stride';
                config.request = 'launch';
                config.name = selected.label;
                config.mode = selected.mode;
                config.file = '${file}';
                if (selected.mode === 'compile' || selected.mode === 'flash') {
                    config.output = '${fileDirname}/${fileBasenameNoExtension}.o';
                    config.header = '${fileDirname}/${fileBasenameNoExtension}.h';
                }
            } else {
                window.showInformationMessage('Open a Stride (.stride) file to run or compile.');
                return undefined;
            }
        }

        await executeStrideLaunchConfig(config);
        return undefined;
    }
}

function registerDebugAndExecutionCommands(context: ExtensionContext): void {
    const provider = new StrideDebugConfigurationProvider();
    context.subscriptions.push(
        debug.registerDebugConfigurationProvider('stride', provider)
    );

    context.subscriptions.push(
        commands.registerCommand('stride.runTest', async (uri?: Uri) => {
            await executeStrideLaunchConfig({
                type: 'stride',
                request: 'launch',
                name: 'Stride: Run Unit Tests in File',
                mode: 'test',
                file: '${file}'
            }, uri);
        }),
        commands.registerCommand('stride.compileFile', async (uri?: Uri) => {
            await executeStrideLaunchConfig({
                type: 'stride',
                request: 'launch',
                name: 'Stride: Compile File to Disk',
                mode: 'compile',
                file: '${file}',
                output: '${fileDirname}/${fileBasenameNoExtension}.o',
                header: '${fileDirname}/${fileBasenameNoExtension}.h'
            }, uri);
        }),
        commands.registerCommand('stride.buildAndFlash', async (uri?: Uri) => {
            await executeStrideLaunchConfig({
                type: 'stride',
                request: 'launch',
                name: 'Stride: Build and Flash / Run (Future)',
                mode: 'flash',
                file: '${file}'
            }, uri);
        })
    );
}

export async function activate(context: ExtensionContext) {
    extensionContext = context;

    // Register F5 debugging and compilation commands
    registerDebugAndExecutionCommands(context);

    // Register document formatting providers (powered by Prettier)
    context.subscriptions.push(
        languages.registerDocumentFormattingEditProvider(
            { scheme: 'file', language: 'stride' },
            { provideDocumentFormattingEdits }
        ),
        languages.registerDocumentRangeFormattingEditProvider(
            { scheme: 'file', language: 'stride' },
            { provideDocumentRangeFormattingEdits }
        )
    );

    const serverExecutable = findServerBinary(context);

    if (!serverExecutable) {
        console.log('stride-lsp executable not found. Activating built-in TypeScript language providers for Stride.');
        registerFallbackProviders(context);
        return;
    }

    const effectiveStrideroot = getEffectiveStrideRoot();

    console.log(`Starting Stride Language Server: ${serverExecutable}`);
    if (effectiveStrideroot) {
        console.log(`Using Stride Root: ${effectiveStrideroot}`);
    }

    const serverOptions: ServerOptions = {
        command: serverExecutable,
        args: effectiveStrideroot ? [`--strideroot=${effectiveStrideroot}`] : [],
        transport: TransportKind.stdio
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'stride' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.stride')
        },
        errorHandler: {
            error: (error, message, count) => {
                console.error('Stride LSP error:', error, message, count);
                return { action: ErrorAction.Continue };
            },
            closed: () => {
                console.warn('Stride LSP server connection closed. Activating fallback providers.');
                registerFallbackProviders(context);
                return { action: CloseAction.DoNotRestart };
            }
        }
    };

    client = new LanguageClient(
        'strideLanguageServer',
        'Stride Language Server',
        serverOptions,
        clientOptions
    );

    context.subscriptions.push(client);

    try {
        await client.start();
    } catch (err) {
        console.error('Stride LSP server start error:', err);
        window.showWarningMessage(`Stride LSP server start error: ${err}. Falling back to built-in provider.`);
        registerFallbackProviders(context);
    }
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}

export { parseScopeTree, parseDeclarationsFromBlock, findEnclosingDeclarations, ScopeContext, ScopeDeclaration };

