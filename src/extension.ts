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
    DiagnosticCollection
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

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
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\bin\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\bin\\Debug\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\bin\\Release\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\build\\Debug\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\build\\Release\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\vscode-stride-lang\\server\\build\\stride-lsp.exe',
        'C:\\Users\\Andres\\source\\repos\\boardgame\\build\\Desktop_Qt_6_7_3_MSVC2022_64bit-Debug\\libgame\\external\\codegen\\Debug\\stride-lsp.exe',
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
    'gameDefinition': '_GameDefinitionType',
    '_GameDefinitionType': '_GameDefinitionType'
};

const BUILTIN_SCALARS: Record<string, string> = {
    '_IntType': '**Built-in Type**: `_IntType` — *Standard 32-bit signed integer data type.*',
    '_RealType': '**Built-in Type**: `_RealType` — *64-bit IEEE 754 double precision floating point data type.*',
    '_SwitchType': '**Built-in Type**: `_SwitchType` — *Boolean switch / conditional control signal (`on` / `off`).*',
    '_StateType': '**Built-in Type**: `_StateType` — *State machine state representation.*',
    '_Signal': '**Built-in Type**: `_Signal` — *Base abstract signal representation in Stride.*'
};

function extractBraceBlock(text: string, startIndex: number): { body: string; endIndex: number } | null {
    let braceCount = 0;
    let inBrace = false;
    let bodyStart = -1;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (char === '{') {
            if (!inBrace) {
                inBrace = true;
                bodyStart = i + 1;
            }
            braceCount++;
        } else if (char === '}') {
            braceCount--;
            if (braceCount === 0 && inBrace) {
                return { body: text.substring(bodyStart, i), endIndex: i + 1 };
            }
        }
    }
    return null;
}

function extractSquareBracketBlock(text: string, startIndex: number): { body: string; endIndex: number } | null {
    let bracketCount = 0;
    let inBracket = false;
    let bodyStart = -1;

    for (let i = startIndex; i < text.length; i++) {
        const char = text[i];
        if (char === '[') {
            if (!inBracket) {
                inBracket = true;
                bodyStart = i + 1;
            }
            bracketCount++;
        } else if (char === ']') {
            bracketCount--;
            if (bracketCount === 0 && inBracket) {
                return { body: text.substring(bodyStart, i), endIndex: i + 1 };
            }
        }
    }
    return null;
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
}

interface ScopeContext {
    name: string;
    kind: string;
    startLine: number;
    endLine: number;
    declarations: Map<string, ScopeDeclaration>;
    ports: Map<string, PortInfo>;
    boundPorts: Map<string, PortInfo>;
    children: ScopeContext[];
    parent?: ScopeContext;
}

function stripComments(text: string): string {
    return text.replace(/#[^\r\n]*/g, match => ' '.repeat(match.length));
}

function parseDeclarationsFromBlock(blockBody: string, baseLine: number, filePath: string): ScopeDeclaration[] {
    const cleanBody = stripComments(blockBody);
    const decls: ScopeDeclaration[] = [];
    const declHeaderRegex = /\b([_a-zA-Z0-9]+)\s+([_a-zA-Z0-9]+)\s*(?=\{)/g;
    let match;

    while ((match = declHeaderRegex.exec(cleanBody)) !== null) {
        const kind = match[1];
        const name = match[2];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(cleanBody, headerEnd);
        if (!block) continue;
        const pBody = block.body;

        let dLine = baseLine;
        for (let i = 0; i < match.index; i++) {
            if (cleanBody[i] === '\n') dLine++;
        }

        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const typeMatch = /type\s*:\s*([_a-zA-Z0-9.]+)/.exec(pBody);
        const domainMatch = /domain\s*:\s*([_a-zA-Z0-9.]+)/.exec(pBody);
        const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);
        const blockMatch = /block\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);

        decls.push({
            name,
            kind,
            line: dLine,
            signature: `${kind} ${name}`,
            body: pBody,
            meta: metaMatch ? metaMatch[1] : undefined,
            type: typeMatch ? typeMatch[1] : undefined,
            domain: domainMatch ? domainMatch[1] : undefined,
            defaultVal: defMatch ? defMatch[1].trim() : undefined,
            boundBlock: blockMatch ? blockMatch[1] : undefined
        });
    }

    return decls;
}

function parseScopeTree(text: string, filePath: string): ScopeContext {
    const cleanText = stripComments(text);
    const lines = cleanText.split(/\r?\n/);
    const rootScope: ScopeContext = {
        name: '<root>',
        kind: 'root',
        startLine: 1,
        endLine: lines.length,
        declarations: new Map(),
        ports: new Map(),
        boundPorts: new Map(),
        children: []
    };

    const containerRegex = /\b(_domainDefinition|gameDefinition|domainDeclaration|module|reaction|loop|state|transition|platformModule)\s*(?:([_a-zA-Z0-9]+))?\s*(?=\{)/g;
    let match;

    const discoveredScopes: ScopeContext[] = [];

    while ((match = containerRegex.exec(cleanText)) !== null) {
        const kind = match[1];
        const name = match[2] || `${kind}_line${getLineNumber(cleanText, match.index)}`;
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(cleanText, headerEnd);
        if (!block) continue;

        const startLine = getLineNumber(cleanText, match.index);
        const endLine = getLineNumber(cleanText, headerEnd + block.body.length);

        const scope: ScopeContext = {
            name,
            kind,
            startLine,
            endLine,
            declarations: new Map(),
            ports: new Map(),
            boundPorts: new Map(),
            children: []
        };

        const ports = parsePortsFromBlock(block.body, startLine);
        for (const p of ports) {
            scope.ports.set(p.portName, p);
            if (p.boundBlock) {
                scope.boundPorts.set(p.boundBlock, p);
            }
        }

        const listRegex = /\b(blocks|inputs|outputs|states|transitions)\s*:\s*\[/g;
        let listMatch;
        while ((listMatch = listRegex.exec(block.body)) !== null) {
            const listStart = listMatch.index + listMatch[0].length - 1;
            const listBlock = extractSquareBracketBlock(block.body, listStart);
            if (listBlock) {
                const listLine = getLineNumber(block.body, listMatch.index, startLine);
                const localDecls = parseDeclarationsFromBlock(listBlock.body, listLine, filePath);
                for (const d of localDecls) {
                    if (scope.boundPorts.has(d.name)) {
                        d.associatedPort = scope.boundPorts.get(d.name);
                    }
                    scope.declarations.set(d.name, d);
                }
            }
        }

        const directDecls = parseDeclarationsFromBlock(block.body, startLine, filePath);
        for (const d of directDecls) {
            if (!scope.declarations.has(d.name)) {
                if (scope.boundPorts.has(d.name)) {
                    d.associatedPort = scope.boundPorts.get(d.name);
                }
                scope.declarations.set(d.name, d);
            }
        }

        discoveredScopes.push(scope);
    }

    const topDecls = parseDeclarationsFromBlock(text, 1, filePath);
    for (const d of topDecls) {
        const isInsideDiscoveredScope = discoveredScopes.some(s => d.line >= s.startLine && d.line <= s.endLine);
        if (!isInsideDiscoveredScope) {
            rootScope.declarations.set(d.name, d);
        }
    }

    discoveredScopes.sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine));

    for (const scope of discoveredScopes) {
        let parentScope: ScopeContext = rootScope;
        for (const candidate of discoveredScopes) {
            if (candidate !== scope &&
                candidate.startLine <= scope.startLine &&
                candidate.endLine >= scope.endLine) {
                if (parentScope === rootScope ||
                    (candidate.endLine - candidate.startLine < parentScope.endLine - parentScope.startLine)) {
                    parentScope = candidate;
                }
            }
        }
        scope.parent = parentScope;
        parentScope.children.push(scope);
    }

    return rootScope;
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

function findKnownLibraryFiles(): string[] {
    const files: string[] = [];
    const rootDirs: string[] = [];

    if (process.env.STRIDEROOT) {
        rootDirs.push(path.join(process.env.STRIDEROOT, 'library'));
        rootDirs.push(process.env.STRIDEROOT);
    }

    const candidatePaths = [
        'C:/Users/Andres/source/repos/Stride/strideroot/library',
        'C:\\Users\\Andres\\source\\repos\\Stride\\strideroot\\library',
        'C:/Users/Andres/source/repos/Stride/strideroot',
        '../../Stride/strideroot/library',
        '../Stride/strideroot/library',
        'C:/Users/Andres/source/repos/boardgame/libgame',
        'C:/Users/Andres/source/repos/boardgame/libgame/external/stridejit/tests/data',
        'C:/Users/Andres/source/repos/boardgame/libgame/external/strideparser',
        'C:/Users/Andres/source/repos/boardgame/libgame/external/codegen'
    ];
    for (const c of candidatePaths) {
        if (!rootDirs.includes(c)) rootDirs.push(c);
    }

    if (workspace.workspaceFolders) {
        for (const wf of workspace.workspaceFolders) {
            rootDirs.push(wf.uri.fsPath);
        }
    }

    const config = workspace.getConfiguration('stride');
    const includePaths = config.get<string[]>('includePaths') || [];
    rootDirs.push(...includePaths);

    const visitedDirs = new Set<string>();

    function scanDir(dir: string, depth = 0) {
        if (depth > 6 || visitedDirs.has(dir) || !fs.existsSync(dir)) return;
        visitedDirs.add(dir);
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name !== 'build' && entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== 'out') {
                        scanDir(fullPath, depth + 1);
                    }
                } else if (entry.isFile() && entry.name.endsWith('.stride')) {
                    if (!files.includes(fullPath)) {
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

function parsePortsFromBlock(blockBody: string, baseLine: number = 1): PortInfo[] {
    const ports: PortInfo[] = [];
    const portHeaderRegex = /\b(mainInputPort|mainOutputPort|propertyInputPort|propertyOutputPort|port)\s+([_a-zA-Z0-9]+)\s*(?=\{)/g;
    let match;

    while ((match = portHeaderRegex.exec(blockBody)) !== null) {
        const portType = match[1];
        const portName = match[2];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(blockBody, headerEnd);
        if (!block) continue;
        const pBody = block.body.replace(/#[^\n\r]*/g, '');

        let pLine = baseLine;
        for (let i = 0; i < match.index; i++) {
            if (blockBody[i] === '\n') pLine++;
        }

        const blockMatch = /block\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);
        const nameMatch = /name\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const typeMatch = /type\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);
        const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);

        ports.push({
            portType,
            portName,
            boundBlock: blockMatch ? blockMatch[1] : undefined,
            nameField: nameMatch ? nameMatch[1] : undefined,
            meta: metaMatch ? metaMatch[1] : undefined,
            types: typeMatch ? typeMatch[1] : undefined,
            defaultVal: defMatch ? defMatch[1].trim() : undefined,
            line: pLine
        });
    }
    return ports;
}

function parseLibrarySymbols(text: string, filePath: string): LibrarySymbol[] {
    const cleanText = stripComments(text);
    const symbols: LibrarySymbol[] = [];
    const declHeaderRegex = /\b(_domainDefinition|gameDefinition|module|reaction|loop|state|transition|platformModule|platformFunction|resource|domainResource|_frameworkDescription|alias|signal|switch|trigger)\s+([_a-zA-Z0-9]+)(?:\[[^\]]*\])?(?:@\s*[_a-zA-Z0-9]+)?\s*(?=\{)/g;
    let match;

    while ((match = declHeaderRegex.exec(cleanText)) !== null) {
        const kind = match[1];
        const name = match[2];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(cleanText, headerEnd);
        if (!block) continue;
        const body = block.body;

        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (cleanText[i] === '\n') line++;
        }

        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(body);
        const meta = metaMatch ? metaMatch[1] : undefined;

        const ports = parsePortsFromBlock(body, line);

        const procMatch = /processing\s*:\s*["']([^"']+)["']/.exec(body);
        const processing = procMatch ? procMatch[1] : undefined;

        const inheritsMatch = /inherits\s*:\s*\[([^\]]*)\]/.exec(body);
        const inherits: string[] = [];
        if (inheritsMatch) {
            for (const r of inheritsMatch[1].split(',')) {
                const tr = r.trim().replace(/[\[\]]/g, '').trim();
                if (tr) inherits.push(tr);
            }
        }

        const inputsMatch = /inputs\s*:\s*\[([^\]]*)\]/.exec(body);
        const inputs: string[] = [];
        if (inputsMatch) {
            for (const r of inputsMatch[1].split(',')) {
                const tr = r.trim().replace(/\{[^}]*\}/g, '').trim();
                if (tr) inputs.push(tr);
            }
        }

        const outputsMatch = /outputs\s*:\s*\[([^\]]*)\]/.exec(body);
        const outputs: string[] = [];
        if (outputsMatch) {
            for (const r of outputsMatch[1].split(',')) {
                const tr = r.trim().replace(/\{[^}]*\}/g, '').trim();
                if (tr) outputs.push(tr);
            }
        }

        const targetBlockMatch = /block\s*:\s*([_a-zA-Z0-9]+)/.exec(body);
        const targetBlock = targetBlockMatch ? targetBlockMatch[1] : undefined;

        symbols.push({
            name,
            kind,
            filePath,
            line,
            signature: `${kind} ${name}`,
            ports: ports.length ? ports : undefined,
            meta,
            inherits: inherits.length ? inherits : undefined,
            inputs: inputs.length ? inputs : undefined,
            outputs: outputs.length ? outputs : undefined,
            processing,
            targetBlock
        });
    }

    return symbols;
}

function parseTypesFromText(text: string, filePath?: string): TypeInfo[] {
    const cleanText = stripComments(text);
    const types: TypeInfo[] = [];
    const typeHeaderRegex = /\btype\s+(_*[a-zA-Z0-9_]+)\s*(?=\{)/g;
    let match;

    while ((match = typeHeaderRegex.exec(cleanText)) !== null) {
        const typeDeclName = match[1];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(cleanText, headerEnd);
        if (!block) continue;

        const body = block.body;

        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (cleanText[i] === '\n') line++;
        }

        const typeNameMatch = /typeName\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(body);
        const typeName = typeNameMatch ? (typeNameMatch[1] || typeNameMatch[2]) : undefined;

        const inheritsMatch = /inherits\s*:\s*\[([^\]]*)\]/.exec(body);
        const inherits: string[] = [];
        if (inheritsMatch) {
            const raw = inheritsMatch[1].split(',');
            for (let r of raw) {
                r = r.trim().replace(/[\[\]]/g, '').trim();
                if (r) inherits.push(r);
            }
        }

        const metaMatch = /meta\s*:\s*["']([^"']+)["']/.exec(body);
        const meta = metaMatch ? metaMatch[1] : undefined;

        const properties: PropertyInfo[] = [];
        const propHeaderRegex = /typeProperty\s*(?:([_a-zA-Z0-9]+)\s*)?(?=\{)/g;
        let pMatch;
        while ((pMatch = propHeaderRegex.exec(body)) !== null) {
            const explicitName = pMatch[1];
            const pHeaderEnd = pMatch.index + pMatch[0].length;
            const pBlock = extractBraceBlock(body, pHeaderEnd);
            if (!pBlock) continue;
            const pBody = pBlock.body;

            let pLine = line;
            for (let i = 0; i < pMatch.index; i++) {
                if (body[i] === '\n') pLine++;
            }

            const nameMatch = /name\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(pBody);
            const propName = (nameMatch ? (nameMatch[1] || nameMatch[2]) : undefined) || explicitName || 'property';

            const typesMatch = /types\s*:\s*\[([^\]]*)\]/.exec(pBody);
            const propTypes: string[] = [];
            if (typesMatch) {
                const rawT = typesMatch[1].split(',');
                for (let rt of rawT) {
                    rt = rt.trim().replace(/\{[^}]*\}/g, '').trim();
                    if (rt) propTypes.push(rt);
                }
            }

            const reqMatch = /required\s*:\s*(on|off|true|false)/.exec(pBody);
            const isReq = reqMatch ? (reqMatch[1] === 'on' || reqMatch[1] === 'true') : false;

            const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);
            const defVal = defMatch ? defMatch[1].trim() : undefined;

            const pMetaMatch = /meta\s*:\s*["']([^"']+)["']/.exec(pBody);
            const pMeta = pMetaMatch ? pMetaMatch[1] : undefined;

            properties.push({
                name: propName,
                types: propTypes.length ? propTypes : undefined,
                required: isReq,
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

function getAllTypes(document: TextDocument): Map<string, TypeInfo> {
    const typeMap = new Map<string, TypeInfo>();

    for (const schemaPath of findKnownLibraryFiles()) {
        try {
            const content = fs.readFileSync(schemaPath, 'utf8');
            const parsed = parseTypesFromText(content, schemaPath);
            const isStandardLib = schemaPath.includes('strideroot') || schemaPath.includes('library');
            for (const t of parsed) {
                const existing = typeMap.get(t.name) || (t.typeName ? typeMap.get(t.typeName) : undefined);
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

    try {
        const docParsed = parseTypesFromText(document.getText(), document.uri.fsPath);
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
    return propMap;
}

function getAllLibrarySymbols(document: TextDocument): Map<string, LibrarySymbol> {
    const symbolMap = new Map<string, LibrarySymbol>();

    for (const libPath of findKnownLibraryFiles()) {
        try {
            const content = fs.readFileSync(libPath, 'utf8');
            const parsed = parseLibrarySymbols(content, libPath);
            for (const s of parsed) {
                symbolMap.set(s.name, s);
            }
        } catch (e) {}
    }

    try {
        const docParsed = parseLibrarySymbols(document.getText(), document.uri.fsPath);
        for (const s of docParsed) {
            symbolMap.set(s.name, s);
        }
    } catch (e) {}

    return symbolMap;
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

function renderPropertyHover(propName: string, allTypes: Map<string, TypeInfo>): MarkdownString | undefined {
    let foundProp: PropertyInfo | undefined;
    let foundInType: TypeInfo | undefined;

    for (const [_, typeInfo] of allTypes.entries()) {
        const p = typeInfo.properties.find(x => x.name === propName);
        if (p) {
            foundProp = p;
            foundInType = typeInfo;
            if (p.filePath) {
                break;
            }
        }
    }

    if (foundProp) {
        let body = `<div style="${HOVER_STYLE}">\n\n`;
        body += `**Property \`${propName}:\`**\n\n`;

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

    return undefined;
}

function renderLibrarySymbolHover(sym: LibrarySymbol, allSymbols: Map<string, LibrarySymbol>): Hover {
    let body = '';

    if (sym.targetBlock) {
        const targetSym = allSymbols.get(sym.targetBlock);
        if (targetSym) {
            body += `🔗 **Points to Target**: [${sym.targetBlock}](${formatClickableLink(targetSym.filePath, targetSym.line).match(/\(([^)]+)\)/)?.[1]})\n\n`;
        } else {
            body += `🔗 **Target Block**: \`${sym.targetBlock}\`\n\n`;
        }
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
        body += `\n**Ports**:\n`;
        for (const p of sym.ports) {
            let pLine = `- \`${p.portName}\` (\`${p.portType}\`)`;
            if (p.boundBlock) pLine += ` ➔ block \`${p.boundBlock}\``;
            if (p.nameField) pLine += ` (id: \`"${p.nameField}"\`)`;
            if (p.types) pLine += ` [${p.types}]`;
            if (p.meta) pLine += `\n  *${p.meta}*`;
            body += `${pLine}\n`;
        }
        body += `\n`;
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
            body += `**Inherited Ports**:\n\n`;
            for (const group of inheritedPorts) {
                const parentSym = allSymbols.get(group.parentName);
                let parentHeader = `**From \`${group.parentName}\`**`;
                if (parentSym && parentSym.filePath) {
                    parentHeader = `**From [${group.parentName}](${formatClickableLink(parentSym.filePath, parentSym.line).match(/\(([^)]+)\)/)?.[1]})**`;
                }
                body += `${parentHeader}:\n`;
                for (const p of group.ports) {
                    let pLine = `- \`${p.portName}\` (\`${p.portType}\`)`;
                    if (p.boundBlock) pLine += ` ➔ block \`${p.boundBlock}\``;
                    if (p.nameField) pLine += ` (id: \`"${p.nameField}"\`)`;
                    if (p.types) pLine += ` [${p.types}]`;
                    if (p.meta) pLine += `\n  *${p.meta}*`;
                    body += `${pLine}\n`;
                }
                body += `\n`;
            }
        }
    }

    if (sym.meta) {
        body += `\n---\n*${sym.meta}*\n`;
    }

    body += `\n---\n`;
    if (sym.inherits && sym.inherits.length) {
        body += `🔗 **Inherits from**: \`${sym.inherits.join(', ')}\`\n\n`;
    }
    body += `📍 **Declared in**: ${formatClickableLink(sym.filePath, sym.line)}\n`;

    return createCompactHover(sym.signature, body);
}

// ============================================================================
// Fallback Providers Setup
// ============================================================================

function registerFallbackProviders(context: ExtensionContext) {
    const symbolProvider: DocumentSymbolProvider = {
        provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
            const text = document.getText();
            const rootScope = parseScopeTree(text, document.uri.fsPath);

            function getSymbolKind(kindStr: string): SymbolKind {
                if (kindStr === 'module' || kindStr === 'reaction' || kindStr === 'loop') {
                    return SymbolKind.Function;
                } else if (kindStr === 'state' || kindStr === 'transition') {
                    return SymbolKind.Struct;
                } else if (kindStr === '_domainDefinition' || kindStr === 'gameDefinition' || kindStr === 'domainDeclaration' || kindStr === 'type') {
                    return SymbolKind.Class;
                } else if (kindStr.includes('Port') || kindStr === 'port') {
                    return SymbolKind.Interface;
                }
                return SymbolKind.Variable;
            }

            function convertScopeToSymbols(scope: ScopeContext): DocumentSymbol[] {
                const symbols: DocumentSymbol[] = [];

                // 1. Declarations directly inside this scope (that are not separate child scopes)
                for (const [_, decl] of scope.declarations.entries()) {
                    const isChildScope = scope.children.some(c => c.name === decl.name && c.startLine === decl.line);
                    if (!isChildScope) {
                        const dLine = Math.max(0, decl.line - 1);
                        const lineText = document.lineAt(Math.min(dLine, document.lineCount - 1)).text;
                        const pos = lineText.indexOf(decl.name);
                        const selRange = new Range(dLine, pos >= 0 ? pos : 0, dLine, pos >= 0 ? pos + decl.name.length : lineText.length);
                        const fullRange = new Range(dLine, 0, dLine, lineText.length);
                        const sym = new DocumentSymbol(decl.name, decl.kind, getSymbolKind(decl.kind), fullRange, selRange);
                        symbols.push(sym);
                    }
                }

                // 2. Child scopes
                for (const childScope of scope.children) {
                    const sLine = Math.max(0, childScope.startLine - 1);
                    const eLine = Math.max(sLine, childScope.endLine - 1);
                    const lineText = document.lineAt(Math.min(sLine, document.lineCount - 1)).text;
                    const endLineText = document.lineAt(Math.min(eLine, document.lineCount - 1)).text;
                    const pos = lineText.indexOf(childScope.name);
                    const selRange = new Range(sLine, pos >= 0 ? pos : 0, sLine, pos >= 0 ? pos + childScope.name.length : lineText.length);
                    const fullRange = new Range(sLine, 0, eLine, endLineText.length);

                    const childNode = new DocumentSymbol(
                        childScope.name,
                        childScope.kind,
                        getSymbolKind(childScope.kind),
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
            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            // 1. Built-in scalar types
            if (BUILTIN_SCALARS[word]) {
                return createCompactHover(undefined, BUILTIN_SCALARS[word]);
            }

            // 2. Type definitions (gameDefinition, _GameDefinitionType, _DomainDefinition, dict, playerType, supply, etc.)
            const allTypes = getAllTypes(document);
            const matchedType = allTypes.get(word);
            if (matchedType) {
                return new Hover(renderTypeHover(matchedType, allTypes));
            }

            // 3. Property Keys (playerTypes, supplies, board, end, domain, type, default, rate, etc.)
            const propHover = renderPropertyHover(word, allTypes);
            if (propHover) {
                return new Hover(propHover);
            }

            // 4. Check for Import statements (e.g. import GameFunctions -> link to GameFunctions.stride)
            const lineText = document.lineAt(position.line).text;
            const importMatch = /^\s*import\s+([_a-zA-Z0-9]+)/.exec(lineText);
            if (importMatch && importMatch[1] === word) {
                for (const libPath of findKnownLibraryFiles()) {
                    if (path.basename(libPath, '.stride') === word || path.basename(libPath) === word) {
                        const content = fs.readFileSync(libPath, 'utf8');
                        const decls = parseLibrarySymbols(content, libPath);
                        let body = `📍 **Library File**: ${formatClickableLink(libPath, 1)}\n\n`;
                        if (decls.length > 0) {
                            body += `**Exported Declarations**:\n`;
                            for (const d of decls.slice(0, 15)) {
                                body += `- \`${d.signature}\` (${formatClickableLink(libPath, d.line)})\n`;
                            }
                            if (decls.length > 15) {
                                body += `*... and ${decls.length - 15} more declarations.*\n`;
                            }
                        }
                        return createCompactHover(`import ${word}`, body);
                    }
                }
            }

            // 5. Lexical Scoping & ScopeStack Resolution for local signals, switches, blocks, ports, and variables
            const rootScope = parseScopeTree(document.getText(), document.uri.fsPath);
            const scopeStack = buildScopeStack(rootScope, position.line + 1);
            const decl = findDeclarationInScopeStack(word, scopeStack);

            if (decl) {
                let body = '';
                const currentScope = scopeStack[scopeStack.length - 1];
                if (currentScope && currentScope.kind !== 'root') {
                    body += `📍 **Scope**: \`${currentScope.kind}\` \`${currentScope.name}\`\n\n`;
                }

                if (decl.associatedPort) {
                    body += `- **Associated Port**: \`${decl.associatedPort.portName}\` (\`${decl.associatedPort.portType}\`)\n`;
                    if (decl.associatedPort.meta) {
                        body += `\n*${decl.associatedPort.meta}*\n\n`;
                    }
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

            // 6. Library Symbols across the workspace / standard library files
            const allSymbols = getAllLibrarySymbols(document);
            const libSym = allSymbols.get(word);
            if (libSym) {
                return renderLibrarySymbolHover(libSym, allSymbols);
            }

            return undefined;
        }
    };

    const definitionProvider: DefinitionProvider = {
        provideDefinition(document: TextDocument, position: Position): Location | undefined {
            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            const rootScope = parseScopeTree(document.getText(), document.uri.fsPath);
            const scopeStack = buildScopeStack(rootScope, position.line + 1);
            const decl = findDeclarationInScopeStack(word, scopeStack);
            if (decl) {
                return new Location(document.uri, new Position(Math.max(0, decl.line - 1), 0));
            }

            const allTypes = getAllTypes(document);
            const t = allTypes.get(word) || (TYPE_ALIASES[word] ? allTypes.get(TYPE_ALIASES[word]) : undefined);
            if (t && t.filePath) {
                return new Location(Uri.file(t.filePath), new Position(Math.max(0, (t.line || 1) - 1), 0));
            }

            const allSymbols = getAllLibrarySymbols(document);
            const sym = allSymbols.get(word);
            if (sym && sym.filePath) {
                return new Location(Uri.file(sym.filePath), new Position(Math.max(0, (sym.line || 1) - 1), 0));
            }

            return undefined;
        }
    };

    const completionProvider: CompletionItemProvider = {
        provideCompletionItems(document: TextDocument): CompletionItem[] {
            const items: CompletionItem[] = [];
            const allTypes = getAllTypes(document);
            const allSymbols = getAllLibrarySymbols(document);

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
                'state', 'transition', 'platformModule', 'signal', 'switch', 'trigger',
                'mainInputPort', 'mainOutputPort', 'propertyInputPort', 'propertyOutputPort',
                'import', 'use', 'version', 'streamRate', 'on', 'off', 'none',
                '_IntType', '_RealType', '_SwitchType', '_StateType',
                'default:', 'reset:', 'domain:', 'type:', 'rate:', 'meta:',
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

            return items;
        }
    };

    const diagnosticCollection = languages.createDiagnosticCollection('stride');

    function validateDocument(document: TextDocument) {
        if (document.languageId !== 'stride') return;
        const text = document.getText();
        const lines = text.split(/\r?\n/);
        const diagnostics: Diagnostic[] = [];

        const allTypes = getAllTypes(document);
        const rootScope = parseScopeTree(text, document.uri.fsPath);

        // 1. Check Unbalanced Braces / Brackets
        let openBraces = 0;
        let openBrackets = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].replace(/#[^\r\n]*/g, '');
            for (let j = 0; j < line.length; j++) {
                if (line[j] === '{') openBraces++;
                else if (line[j] === '}') openBraces--;
                else if (line[j] === '[') openBrackets++;
                else if (line[j] === ']') openBrackets--;
            }
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

        // 2. Validate Declarations (Unknown Type, Invalid Properties)
        const declHeaderRegex = /\b([_a-zA-Z0-9]+)\s+([_a-zA-Z0-9]+)\s*(?=\{)/g;
        let match;
        const ignoredKeywords = new Set(['import', 'use', 'version', 'streamRate']);

        while ((match = declHeaderRegex.exec(text)) !== null) {
            const kind = match[1];
            const name = match[2];
            if (ignoredKeywords.has(kind)) continue;

            const lineNum = getLineNumber(text, match.index) - 1;
            const lineText = lines[lineNum] || '';
            const kindPos = lineText.indexOf(kind);
            const kindRange = new Range(lineNum, kindPos >= 0 ? kindPos : 0, lineNum, kindPos >= 0 ? kindPos + kind.length : 10);

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
            const headerEnd = match.index + match[0].length;
            const block = extractBraceBlock(text, headerEnd);
            if (block && isKnownType) {
                const allowedProps = resolveAllPropertiesForType(kind, allTypes);

                // Scan only top-level properties of this block (depth 0 of braces & brackets)
                const propRegex = /\b([_a-zA-Z0-9]+)\s*:/g;
                let depth = 0;
                let bIndex = 0;
                const bodyStr = block.body;
                while (bIndex < bodyStr.length) {
                    const ch = bodyStr[bIndex];
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
                        const pMatch = propRegex.exec(bodyStr);
                        if (pMatch && pMatch.index === bIndex) {
                            const propName = pMatch[1];
                            const globalChar = headerEnd + 1 + pMatch.index;
                            const pStart = document.positionAt(globalChar);
                            const pEnd = document.positionAt(globalChar + propName.length);

                            if (allowedProps.size > 0 && !allowedProps.has(propName)) {
                                diagnostics.push(new Diagnostic(
                                    new Range(pStart, pEnd),
                                    `Invalid Property Error. Property '${propName}' is not defined for type '${kind}'.`,
                                    DiagnosticSeverity.Error
                                ));
                            }
                            bIndex += pMatch[0].length;
                            continue;
                        }
                    }
                    bIndex++;
                }
            }
        }

        // 3. Validate Duplicate Symbols in Scope
        function checkDuplicateScope(scope: ScopeContext) {
            const seen = new Map<string, ScopeDeclaration>();
            for (const [sName, sDecl] of scope.declarations.entries()) {
                if (seen.has(sName)) {
                    const prev = seen.get(sName)!;
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

        // 4. Validate Undeclared Symbols in Streams
        const streamBlockRegex = /\bstreams\s*:\s*\[/g;
        let sMatch;
        while ((sMatch = streamBlockRegex.exec(text)) !== null) {
            const sStart = sMatch.index + sMatch[0].length - 1;
            const sBlock = extractSquareBracketBlock(text, sStart);
            if (!sBlock) continue;
            const sLine = getLineNumber(text, sMatch.index);
            const scopeStack = buildScopeStack(rootScope, sLine);

            const streamStmtRegex = /([^;]+);/g;
            let stmtMatch;
            while ((stmtMatch = streamStmtRegex.exec(sBlock.body)) !== null) {
                const stmtText = stmtMatch[1];
                const tokenRegex = /\b([_a-zA-Z0-9]+)\b/g;
                let tokMatch;
                while ((tokMatch = tokenRegex.exec(stmtText)) !== null) {
                    const tok = tokMatch[1];
                    if (/^\d+$/.test(tok) || tok === 'on' || tok === 'off' || tok === 'none' || tok === 'true' || tok === 'false') continue;
                    if (tok === 'llvm' || tok === 'icmp' || tok === 'fcmp' || tok === 'eq' || tok === 'ne' || tok === 'sgt' || tok === 'sge' || tok === 'slt' || tok === 'sle') continue;

                    const decl = findDeclarationInScopeStack(tok, scopeStack);
                    const isLibSym = getAllLibrarySymbols(document).has(tok);
                    const isTypeSym = allTypes.has(tok) || BUILTIN_SCALARS[tok];

                    if (!decl && !isLibSym && !isTypeSym) {
                        const globalCharIndex = sStart + 1 + stmtMatch.index + tokMatch.index;
                        const startPos = document.positionAt(globalCharIndex);
                        const endPos = document.positionAt(globalCharIndex + tok.length);
                        diagnostics.push(new Diagnostic(
                            new Range(startPos, endPos),
                            `Undeclared Symbol '${tok}'`,
                            DiagnosticSeverity.Error
                        ));
                    }
                }
            }
        }

        diagnosticCollection.set(document.uri, diagnostics);
    }

    // Validate active documents
    for (const doc of workspace.textDocuments) {
        validateDocument(doc);
    }

    context.subscriptions.push(
        diagnosticCollection,
        workspace.onDidOpenTextDocument(doc => validateDocument(doc)),
        workspace.onDidChangeTextDocument(e => validateDocument(e.document)),
        workspace.onDidSaveTextDocument(doc => validateDocument(doc)),
        workspace.onDidCloseTextDocument(doc => diagnosticCollection.delete(doc.uri)),
        languages.registerDocumentSymbolProvider({ scheme: 'file', language: 'stride' }, symbolProvider),
        languages.registerHoverProvider({ scheme: 'file', language: 'stride' }, hoverProvider),
        languages.registerDefinitionProvider({ scheme: 'file', language: 'stride' }, definitionProvider),
        languages.registerCompletionItemProvider({ scheme: 'file', language: 'stride' }, completionProvider, '.', ':', '>')
    );
}

export function activate(context: ExtensionContext) {
    const serverExecutable = findServerBinary(context);

    if (!serverExecutable) {
        console.log('stride-lsp executable not found. Activating built-in TypeScript language providers for Stride.');
        registerFallbackProviders(context);
        return;
    }

    console.log(`Starting Stride Language Server: ${serverExecutable}`);

    const serverOptions: ServerOptions = {
        command: serverExecutable,
        args: [],
        transport: TransportKind.stdio
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'stride' }],
        synchronize: {
            fileEvents: workspace.createFileSystemWatcher('**/*.stride')
        }
    };

    client = new LanguageClient(
        'strideLanguageServer',
        'Stride Language Server',
        serverOptions,
        clientOptions
    );

    client.start().catch(err => {
        window.showWarningMessage(`Stride LSP server start error: ${err}. Falling back to built-in provider.`);
        registerFallbackProviders(context);
    });
}

export function deactivate(): Thenable<void> | undefined {
    if (!client) {
        return undefined;
    }
    return client.stop();
}
