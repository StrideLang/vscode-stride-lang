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
let extensionContext: ExtensionContext | undefined;

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
}

function stripComments(text: string): string {
    return maskCommentsAndStrings(text);
}

function parseDeclarationsFromBlock(blockBody: string, baseLine: number, filePath: string): ScopeDeclaration[] {
    const maskedBody = maskCommentsAndStrings(blockBody);
    const decls: ScopeDeclaration[] = [];
    const declHeaderRegex = /\b([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/g;
    let match;

    while ((match = declHeaderRegex.exec(maskedBody)) !== null) {
        const kind = match[1];
        let name = match[2];
        const bracketContent = match[3] ? match[3].trim() : undefined;
        const annotation = match[4];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(blockBody, headerEnd, maskedBody);
        if (!block) continue;
        const pBody = block.body;

        let dLine = baseLine;
        for (let i = 0; i < match.index; i++) {
            if (blockBody[i] === '\n') dLine++;
        }

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

        const nameMatch = /name\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(pBody);
        const typeNameMatch = /typeName\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(pBody);
        const blockMatch = /block\s*:\s*([_a-zA-Z0-9]+)/.exec(pBody);

        if (!name) {
            name = (nameMatch ? (nameMatch[1] || nameMatch[2]) : undefined) ||
                   (typeNameMatch ? (typeNameMatch[1] || typeNameMatch[2]) : undefined) ||
                   (blockMatch ? blockMatch[1] : undefined) ||
                   (bracketContent ? `[${bracketContent}]` : `${kind}_line${dLine}`);
        }

        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(pBody);
        const typeMatch = /type\s*:\s*([_a-zA-Z0-9.]+)/.exec(pBody);
        const domainMatch = /domain\s*:\s*([_a-zA-Z0-9.]+)/.exec(pBody);
        const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(pBody);

        let sig = `${kind} ${name}`;
        if (bracketContent !== undefined) {
            sig += `[${bracketContent}]`;
        }
        if (annotation) {
            sig += ` @${annotation}`;
        }

        decls.push({
            name,
            kind,
            line: dLine,
            signature: sig,
            body: pBody,
            meta: metaMatch ? metaMatch[1] : undefined,
            type: typeMatch ? typeMatch[1] : undefined,
            domain: domainMatch ? domainMatch[1] : undefined,
            defaultVal: defMatch ? defMatch[1].trim() : undefined,
            boundBlock: blockMatch ? blockMatch[1] : undefined,
            arraySpec,
            generatorVar,
            generatorRange
        });
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

    // Match all block declarations: kind [name] [[array/generator]] [@annotation] { ... }
    const blockHeaderRegex = /\b([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/g;
    let match;

    const discoveredScopes: ScopeContext[] = [];
    const enclosingDecls: EnclosingDecl[] = [];

    while ((match = blockHeaderRegex.exec(maskedText)) !== null) {
        const kind = match[1];
        let name = match[2];
        const bracketContent = match[3] ? match[3].trim() : undefined;
        const annotation = match[4];
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(text, headerEnd, maskedText);
        if (!block) continue;

        const startOffset = match.index;
        const endOffset = headerEnd + block.body.length + 1; // including '}'
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

        const nameMatch = /name\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(block.body);
        const typeNameMatch = /typeName\s*:\s*(?:["']([^"']+)["']|([_a-zA-Z0-9]+))/.exec(block.body);
        const blockMatch = /block\s*:\s*([_a-zA-Z0-9]+)/.exec(block.body);

        if (!name) {
            name = (nameMatch ? (nameMatch[1] || nameMatch[2]) : undefined) ||
                   (typeNameMatch ? (typeNameMatch[1] || typeNameMatch[2]) : undefined) ||
                   (blockMatch ? blockMatch[1] : undefined) ||
                   (bracketContent ? `[${bracketContent}]` : `${kind}_line${startLine}`);
        }

        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(block.body);
        const typeMatch = /type\s*:\s*([_a-zA-Z0-9.]+)/.exec(block.body);
        const domainMatch = /domain\s*:\s*([_a-zA-Z0-9.]+)/.exec(block.body);
        const defMatch = /default\s*:\s*([^;\n\r]+)/.exec(block.body);

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
            declMeta: metaMatch ? metaMatch[1] : undefined,
            declType: typeMatch ? typeMatch[1] : undefined,
            declDomain: domainMatch ? domainMatch[1] : undefined,
            declDefaultVal: defMatch ? defMatch[1].trim() : undefined,
            declBoundBlock: blockMatch ? blockMatch[1] : undefined
        };

        // If this declaration has a generator variable (e.g. Index in 0:8), bind it inside this scope
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
            if (p.nameField) {
                scope.ports.set(p.nameField, p);
            }
            if (p.boundBlock) {
                scope.boundPorts.set(p.boundBlock, p);
            }
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
            if (!parentScope.declarations.has(scope.name)) {
                const decl: ScopeDeclaration = {
                    name: scope.name,
                    kind: scope.kind,
                    line: scope.startLine,
                    signature: `${scope.kind} ${scope.name}${scope.arraySpec ? `[${scope.arraySpec}]` : ''}`,
                    type: scope.declType || scope.kind,
                    domain: scope.declDomain,
                    meta: scope.declMeta || `${scope.kind} declaration`,
                    defaultVal: scope.declDefaultVal,
                    boundBlock: scope.declBoundBlock,
                    arraySpec: scope.arraySpec,
                    generatorVar: scope.generatorVar,
                    generatorRange: scope.generatorRange
                };
                if (parentScope.boundPorts.has(scope.name)) {
                    decl.associatedPort = parentScope.boundPorts.get(scope.name);
                }
                parentScope.declarations.set(scope.name, decl);
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

function getStrideRootDirs(): string[] {
    const rootDirs: string[] = [];
    const config = workspace.getConfiguration('stride');
    const configuredStrideroot = config.get<string>('strideroot');
    if (configuredStrideroot && fs.existsSync(configuredStrideroot)) {
        rootDirs.push(path.join(configuredStrideroot, 'library'));
        rootDirs.push(configuredStrideroot);
        return rootDirs;
    }

    if (process.env.STRIDEROOT && fs.existsSync(process.env.STRIDEROOT)) {
        rootDirs.push(path.join(process.env.STRIDEROOT, 'library'));
        rootDirs.push(process.env.STRIDEROOT);
        return rootDirs;
    }

    // Bundled strideroot is strictly the final fallback
    if (extensionContext) {
        const bundledRoot = extensionContext.asAbsolutePath('strideroot');
        if (fs.existsSync(bundledRoot)) {
            const bundledLib = path.join(bundledRoot, 'library');
            if (fs.existsSync(bundledLib)) rootDirs.push(bundledLib);
            rootDirs.push(bundledRoot);
        }
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

function parseLibrarySymbols(text: string, filePath: string, preMaskedText?: string): LibrarySymbol[] {
    const maskedText = preMaskedText || maskCommentsAndStrings(text);
    const symbols: LibrarySymbol[] = [];
    const declHeaderRegex = /\b([_a-zA-Z0-9]+)\s+([_a-zA-Z0-9]+)(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:@\s*[_a-zA-Z0-9]+)?\s*(?=\{)/g;
    let match;
    const ignoredKinds = new Set(['import', 'use', 'version', 'streamRate', 'type', 'typeProperty', 'constrainedList']);

    while ((match = declHeaderRegex.exec(maskedText)) !== null) {
        const kind = match[1];
        const name = match[2];
        if (ignoredKinds.has(kind)) continue;
        const bracketContent = match[3] ? match[3].trim() : undefined;
        const headerEnd = match.index + match[0].length;
        const block = extractBraceBlock(text, headerEnd, maskedText);
        if (!block) continue;
        const body = block.body;

        let line = 1;
        for (let i = 0; i < match.index; i++) {
            if (text[i] === '\n') line++;
        }

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

        const metaMatch = /meta\s*:\s*['"]([^'"]+)['"]/.exec(body);
        const meta = metaMatch ? metaMatch[1] : undefined;

        const ports = parsePortsFromBlock(body, line, block.maskedBody);

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

function getLibraryTypes(): Map<string, TypeInfo> {
    if (cachedLibraryTypes) {
        return cachedLibraryTypes;
    }
    const typeMap = new Map<string, TypeInfo>();

    for (const schemaPath of getLibraryFiles()) {
        try {
            const content = fs.readFileSync(schemaPath, 'utf8');
            const parsed = parseTypesFromText(content, schemaPath);
            const isStandardLib = schemaPath.includes('strideroot') || schemaPath.includes('library');
            const isBundledLib = extensionContext && schemaPath.startsWith(extensionContext.extensionPath);
            for (const t of parsed) {
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

function getRelatedStrideFiles(document: TextDocument): string[] {
    const relatedFiles = new Set<string>();
    if (!document.uri || document.uri.scheme !== 'file' || !document.uri.fsPath) {
        return [];
    }
    const currentPath = path.normalize(document.uri.fsPath);
    const docDir = path.dirname(currentPath);

    // 1. Sibling .stride files and directory names in the current directory
    const subDirs: string[] = [];
    try {
        if (fs.existsSync(docDir)) {
            const entries = fs.readdirSync(docDir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.stride')) {
                    const fullPath = path.normalize(path.join(docDir, entry.name));
                    if (fullPath !== currentPath) {
                        relatedFiles.add(fullPath);
                    }
                } else if (entry.isDirectory()) {
                    if (entry.name !== '.git' && entry.name !== 'node_modules' && entry.name !== 'build' && entry.name !== 'out') {
                        subDirs.push(path.normalize(path.join(docDir, entry.name)));
                    }
                }
            }
        }
    } catch (e) {}

    // 2. Search directories for imports: strictly current directory, directory names in current directory, and stride root
    const strideRootDirs = getStrideRootDirs();
    const searchDirs = [
        docDir,
        ...subDirs,
        ...strideRootDirs
    ];

    // Explicitly imported modules: `import <ModuleName>` (with transitive resolution)
    const queue: string[] = [currentPath, ...relatedFiles];
    const visited = new Set<string>([currentPath]);

    while (queue.length > 0) {
        const filePath = queue.shift()!;
        if (visited.has(filePath) && filePath !== currentPath) continue;
        visited.add(filePath);

        try {
            const content = getStrideFileContent(filePath);
            if (!content) continue;
            const importRegex = /^\s*import\s+([_a-zA-Z0-9]+)/gm;
            let impMatch;
            while ((impMatch = importRegex.exec(content)) !== null) {
                const modName = impMatch[1];
                for (const dir of searchDirs) {
                    let candidate = path.normalize(path.join(dir, `${modName}.stride`));
                    if (candidate !== currentPath && fs.existsSync(candidate)) {
                        if (!relatedFiles.has(candidate)) {
                            relatedFiles.add(candidate);
                            queue.push(candidate);
                        }
                        break;
                    }
                    candidate = path.normalize(path.join(dir, modName, `${modName}.stride`));
                    if (candidate !== currentPath && fs.existsSync(candidate)) {
                        if (!relatedFiles.has(candidate)) {
                            relatedFiles.add(candidate);
                            queue.push(candidate);
                        }
                        break;
                    }
                }
            }
        } catch (e) {}
    }

    return Array.from(relatedFiles);
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
    extensionContext = context;
    const symbolProvider: DocumentSymbolProvider = {
        provideDocumentSymbols(document: TextDocument): DocumentSymbol[] {
            const { scopeTree: rootScope } = getCachedDocData(document);

            function getSymbolKind(kindStr: string): SymbolKind {
                if (kindStr === 'module' || kindStr === 'reaction' || kindStr === 'loop') {
                    return SymbolKind.Function;
                } else if (kindStr === 'state' || kindStr === 'transition') {
                    return SymbolKind.Struct;
                } else if (kindStr === '_domainDefinition' || kindStr === 'gameDefinition' || kindStr === 'domainDeclaration' || kindStr === 'type') {
                    return SymbolKind.Class;
                } else if (kindStr === 'typeProperty' || kindStr === 'property') {
                    return SymbolKind.Property;
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
                        let declDetail = decl.kind;
                        if (decl.generatorVar && decl.generatorRange) {
                            declDetail = `${decl.generatorVar} in ${decl.generatorRange}`;
                        } else if (decl.arraySpec) {
                            declDetail = `${decl.kind} [${decl.arraySpec}]`;
                        }
                        const sym = new DocumentSymbol(decl.name, declDetail, getSymbolKind(decl.kind), fullRange, selRange);
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

                    let detail = childScope.kind;
                    if (childScope.generatorVar && childScope.generatorRange) {
                        detail = `${childScope.kind} [${childScope.generatorVar} in ${childScope.generatorRange}]`;
                    } else if (childScope.arraySpec) {
                        detail = `${childScope.kind} [${childScope.arraySpec}]`;
                    }

                    const childNode = new DocumentSymbol(
                        childScope.name,
                        detail,
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
            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            const allTypes = getAllTypes(document);
            const lineText = document.lineAt(position.line).text;
            const afterWord = lineText.substring(wordRange.end.character);
            const isFollowedByColon = /^\s*:/.test(afterWord);
            const enclosingDecl = getCachedInnermostEnclosingDeclaration(document, charOffset);

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

            // 2. Built-in scalar types
            if (BUILTIN_SCALARS[word]) {
                return createCompactHover(undefined, BUILTIN_SCALARS[word]);
            }

            // Keyword: in
            if (word === 'in') {
                return createCompactHover('keyword in', '### Keyword: `in`\n\nSpecifies the iteration domain or range in generator array declarations (e.g. `[Index in 0:8]`).');
            }

            // 3. Type definitions (only if not followed by colon / not a property key)
            if (!isFollowedByColon) {
                const matchedType = allTypes.get(word);
                if (matchedType) {
                    return new Hover(renderTypeHover(matchedType, allTypes));
                }
            }

            // 4. Property Keys fallback
            const propHover = renderPropertyHover(word, allTypes, enclosingDecl?.kind);
            if (propHover) {
                return new Hover(propHover);
            }

            // 5. Check for Import statements (e.g. import GameFunctions -> link to GameFunctions.stride)
            const importMatch = /^\s*import\s+([_a-zA-Z0-9]+)/.exec(lineText);
            if (importMatch && importMatch[1] === word) {
                for (const libPath of getLibraryFiles()) {
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

            // 6. Lexical Scoping & ScopeStack Resolution for local signals, switches, blocks, ports, and variables
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

            // 7. Library Symbols across the workspace / standard library files
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
            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

            const wordRange = document.getWordRangeAtPosition(position, /[_@a-zA-Z0-9]+/);
            if (!wordRange) return undefined;
            const word = document.getText(wordRange);

            const allTypes = getAllTypes(document);
            const lineText = document.lineAt(position.line).text;
            const afterWord = lineText.substring(wordRange.end.character);
            const isFollowedByColon = /^\s*:/.test(afterWord);
            const enclosingDecl = getCachedInnermostEnclosingDeclaration(document, charOffset);

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

    const completionProvider: CompletionItemProvider = {
        provideCompletionItems(document: TextDocument, position: Position): CompletionItem[] | undefined {
            const charOffset = document.offsetAt(position);
            if (isOffsetInCommentOrString(document.getText(), charOffset)) {
                return undefined;
            }

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
                'state', 'transition', 'action', 'platformModule', 'signal', 'switch', 'trigger',
                'mainInputPort', 'mainOutputPort', 'propertyInputPort', 'propertyOutputPort',
                'import', 'use', 'version', 'streamRate', 'in', 'on', 'off', 'none',
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

        // 2. Validate Declarations (Unknown Type, Invalid Properties) on MASKED text
        const declHeaderRegex = /\b([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[((?:[^\[\]]|\[[^\]]*\])*)\])?(?:\s*@\s*([_a-zA-Z0-9]+))?\s*(?=\{)/g;
        let match;
        const ignoredKeywords = new Set(['import', 'use', 'version', 'streamRate']);

        while ((match = declHeaderRegex.exec(maskedText)) !== null) {
            const kind = match[1];
            const name = match[2];
            const bracketContent = match[3] ? match[3].trim() : undefined;
            if (ignoredKeywords.has(kind)) continue;

            if (bracketContent !== undefined && bracketContent.includes(' in ')) {
                const genMatch = /^\s*([_a-zA-Z0-9]+)\s+in\s+(.+)$/.exec(bracketContent);
                if (!genMatch) {
                    const lineNum = getLineNumber(text, match.index) - 1;
                    diagnostics.push(new Diagnostic(
                        new Range(lineNum, 0, lineNum, lines[lineNum]?.length || 10),
                        `Syntax Error in generator declaration: expected '[<Variable> in <Range>]'`,
                        DiagnosticSeverity.Error
                    ));
                }
            }

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
            const block = extractBraceBlock(text, headerEnd, maskedText);
            if (block && isKnownType) {
                const allowedProps = resolveAllPropertiesForType(kind, allTypes);
                const maskedBodyStr = block.maskedBody;

                // Scan only top-level properties of this block (depth 0 of braces & brackets)
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

        // 4. Validate Undeclared Symbols in Streams (ignoring string literals and comments)
        const streamBlockRegex = /\b(?:streams|onTransition)\s*:\s*\[/g;
        let sMatch;
        while ((sMatch = streamBlockRegex.exec(maskedText)) !== null) {
            const sStart = sMatch.index + sMatch[0].length - 1;
            const sBlock = extractSquareBracketBlock(text, sStart, maskedText);
            if (!sBlock) continue;
            const sLine = getLineNumber(text, sMatch.index);
            const scopeStack = buildScopeStack(rootScope, sLine);
            const maskedStreamBody = sBlock.maskedBody;

            const streamStmtRegex = /([^;]+);/g;
            let stmtMatch;
            while ((stmtMatch = streamStmtRegex.exec(maskedStreamBody)) !== null) {
                const stmtText = stmtMatch[1];
                const tokenRegex = /\b([_a-zA-Z0-9]+)\b/g;
                let tokMatch;
                while ((tokMatch = tokenRegex.exec(stmtText)) !== null) {
                    const tok = tokMatch[1];
                    if (/^\d+$/.test(tok) || tok === 'on' || tok === 'off' || tok === 'none' || tok === 'true' || tok === 'false') continue;
                    if (tok === 'llvm' || tok === 'icmp' || tok === 'fcmp' || tok === 'eq' || tok === 'ne' || tok === 'sgt' || tok === 'sge' || tok === 'slt' || tok === 'sle') continue;

                    // If token is immediately followed by a colon (e.g. `entityType:`, `targetSupply:`, `count:`),
                    // it is a named parameter / port key in a function or reaction invocation, not an undeclared symbol.
                    const afterTok = stmtText.slice(tokMatch.index + tok.length);
                    if (/^\s*:/.test(afterTok)) continue;

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
        languages.registerCompletionItemProvider({ scheme: 'file', language: 'stride' }, completionProvider, '.', ':', '>')
    );
}

export function activate(context: ExtensionContext) {
    extensionContext = context;
    const serverExecutable = findServerBinary(context);

    if (!serverExecutable) {
        console.log('stride-lsp executable not found. Activating built-in TypeScript language providers for Stride.');
        registerFallbackProviders(context);
        return;
    }

    const config = workspace.getConfiguration('stride');
    const configuredStrideroot = config.get<string>('strideroot');
    const bundledStrideroot = context.asAbsolutePath('strideroot');
    let effectiveStrideroot: string | undefined = undefined;

    if (configuredStrideroot && fs.existsSync(configuredStrideroot)) {
        effectiveStrideroot = configuredStrideroot;
    } else if (process.env.STRIDEROOT && fs.existsSync(process.env.STRIDEROOT)) {
        effectiveStrideroot = process.env.STRIDEROOT;
    } else if (fs.existsSync(bundledStrideroot)) {
        effectiveStrideroot = bundledStrideroot;
    }

    console.log(`Starting Stride Language Server: ${serverExecutable}`);
    if (effectiveStrideroot) {
        console.log(`Using Stride Root: ${effectiveStrideroot}`);
    }

    const serverOptions: ServerOptions = {
        command: serverExecutable,
        args: effectiveStrideroot ? [`--strideroot=${effectiveStrideroot}`] : [],
        transport: TransportKind.stdio,
        options: effectiveStrideroot ? {
            env: {
                ...process.env,
                STRIDEROOT: effectiveStrideroot
            }
        } : undefined
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

export { parseScopeTree, parseDeclarationsFromBlock, findEnclosingDeclarations, ScopeContext, ScopeDeclaration };

