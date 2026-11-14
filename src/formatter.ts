import * as vscode from 'vscode';
import * as prettier from 'prettier';

const { builders, printer } = prettier.doc;
const { indent, hardline } = builders;
const { printDocToString } = printer;

/**
 * Masks out comments (line `#`, `//` and block `/* ... *\/`) and quoted strings (`"..."`, `'...'`)
 * with spaces, preserving line breaks and original character positions.
 * This allows bracket-counting without false positives from strings or comments.
 */
export function maskCommentsAndStrings(text: string): string {
    const chars = text.split('');
    let inString: false | '"' | "'" = false;
    let inLineComment = false;
    let inBlockComment = false;
    let escape = false;

    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        const next = i + 1 < chars.length ? chars[i + 1] : '';

        // Inside block comment /* ... */
        if (inBlockComment) {
            if (c === '*' && next === '/') {
                inBlockComment = false;
                chars[i] = ' ';
                chars[i + 1] = ' ';
                i++;
            } else if (c !== '\n' && c !== '\r') {
                chars[i] = ' ';
            }
            continue;
        }

        // Inside line comment # or //
        if (inLineComment) {
            if (c === '\n' || c === '\r') {
                inLineComment = false;
            } else {
                chars[i] = ' ';
            }
            continue;
        }

        // Inside string "..." or '...'
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

        // Check comment starts
        if (c === '/' && next === '*') {
            inBlockComment = true;
            chars[i] = ' ';
            chars[i + 1] = ' ';
            i++;
            continue;
        }
        if (c === '#' || (c === '/' && next === '/')) {
            inLineComment = true;
            chars[i] = ' ';
            continue;
        }

        // Check string starts
        if (c === '"' || c === "'") {
            inString = c;
            chars[i] = ' ';
            continue;
        }
    }

    return chars.join('');
}

export interface StrideFormatOptions {
    tabWidth?: number;
    useTabs?: boolean;
    printWidth?: number;
}

/**
 * Formats Stride code using the bundled Prettier Doc Printer.
 * Correctly aligns nested blocks (`{ ... }`), arrays/lists (`[ ... ]`), and calls (`( ... )`),
 * while trimming trailing whitespace, removing redundant blank lines, and ensuring
 * a clean trailing newline.
 */
export function formatStrideText(text: string, options: StrideFormatOptions = {}): string {
    const tabWidth = options.tabWidth ?? 4;
    const useTabs = options.useTabs ?? false;

    const lines = text.split(/\r?\n/);
    const maskedText = maskCommentsAndStrings(text);
    const maskedLines = maskedText.split(/\r?\n/);

    let indentLevel = 0;
    const doc: prettier.Doc[] = [];
    let consecutiveBlank = 0;

    let inStreamContinuation = false;
    let streamBaseIndent = 0;

    for (let i = 0; i < lines.length; i++) {
        const orig = lines[i];
        const trimmed = orig.trim();

        // Handle blank lines: preserve at most one consecutive blank line
        if (trimmed.length === 0) {
            if (consecutiveBlank === 0 && doc.length > 0) {
                doc.push(hardline);
                consecutiveBlank++;
            }
            continue;
        }
        consecutiveBlank = 0;

        const maskedLine = maskedLines[i].trim();

        // Count leading closing brackets (e.g. `}`, `]`, `),`, `};`)
        const leadingCloseMatch = maskedLine.match(/^[\}\]\)\s]+/);
        const leadingCloseCount = leadingCloseMatch
            ? leadingCloseMatch[0].replace(/\s/g, '').length
            : 0;

        const currentLineIndent = Math.max(0, indentLevel - leadingCloseCount);

        // Check for stream continuation:
        // If line starts with `>>`, it is a continuation of the previous stream expression
        const startsWithStream = maskedLine.startsWith('>>');
        if (startsWithStream && !inStreamContinuation) {
            inStreamContinuation = true;
            streamBaseIndent = currentLineIndent;
        }

        const isContinuation = inStreamContinuation && (currentLineIndent >= streamBaseIndent);
        const effectiveIndent = currentLineIndent + (isContinuation ? 1 : 0);

        let lineDoc: prettier.Doc;
        if (doc.length === 0 && effectiveIndent === 0) {
            lineDoc = trimmed;
        } else {
            let item: prettier.Doc = [hardline, trimmed];
            for (let d = 0; d < effectiveIndent; d++) {
                item = indent(item);
            }
            lineDoc = item;
        }
        doc.push(lineDoc);

        // Calculate bracket deltas for following lines
        const opens = (maskedLine.match(/[\{\[\(]/g) || []).length;
        const closes = (maskedLine.match(/[\}\]\)]/g) || []).length;
        const newIndentLevel = Math.max(0, indentLevel + opens - closes);

        // Track stream continuation state for subsequent lines:
        // A stream continuation terminates when a semicolon `;` is reached at or below the stream base indent
        const hasSemicolon = maskedLine.endsWith(';') || (maskedLine.includes(';') && closes >= opens);
        const hasStreamOp = maskedLine.includes('>>');

        if (inStreamContinuation) {
            if (hasSemicolon && newIndentLevel <= streamBaseIndent) {
                inStreamContinuation = false;
            } else if (newIndentLevel < streamBaseIndent) {
                inStreamContinuation = false;
            }
        } else {
            // Stream started on this line without terminating semicolon
            if (hasStreamOp && !hasSemicolon) {
                inStreamContinuation = true;
                streamBaseIndent = currentLineIndent;
            }
        }

        indentLevel = newIndentLevel;
    }

    // POSIX compliant final newline
    doc.push(hardline);

    const { formatted } = printDocToString(doc, {
        tabWidth,
        useTabs,
        printWidth: options.printWidth ?? 120
    });

    return formatted;
}

/**
 * VS Code DocumentFormattingEditProvider implementation for Stride documents.
 */
export async function provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token?: vscode.CancellationToken
): Promise<vscode.TextEdit[]> {
    if (token?.isCancellationRequested) {
        return [];
    }

    // Allow user-specified .prettierrc / prettier configuration if present in workspace
    let resolvedConfig: prettier.Options | null = null;
    try {
        resolvedConfig = await prettier.resolveConfig(document.uri.fsPath);
    } catch {
        // Fall back to VS Code settings if config resolution fails or prettierrc is absent
        resolvedConfig = null;
    }

    const tabWidth = resolvedConfig?.tabWidth ?? options.tabSize ?? 4;
    const useTabs = resolvedConfig?.useTabs ?? (!options.insertSpaces);
    const printWidth = resolvedConfig?.printWidth ?? 120;

    const originalText = document.getText();
    const formatted = formatStrideText(originalText, { tabWidth, useTabs, printWidth });

    if (token?.isCancellationRequested || formatted === originalText) {
        return [];
    }

    const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(originalText.length)
    );

    return [vscode.TextEdit.replace(fullRange, formatted)];
}
