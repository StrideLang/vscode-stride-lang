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

/**
 * Splits top-level commas inside a bracketed or parenthesized expression,
 * respecting nested quotes, brackets, and braces.
 */
export function splitByTopLevelCommas(innerStr: string): string[] {
    const parts: string[] = [];
    let current = '';
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let inString: false | '"' | "'" = false;
    let escape = false;

    for (let i = 0; i < innerStr.length; i++) {
        const c = innerStr[i];

        if (inString !== false) {
            current += c;
            if (escape) {
                escape = false;
            } else if (c === '\\') {
                escape = true;
            } else if (c === inString) {
                inString = false;
            }
            continue;
        }

        if (c === '"' || c === "'") {
            inString = c;
            current += c;
            continue;
        }

        if (c === '(') parenDepth++;
        else if (c === ')') parenDepth = Math.max(0, parenDepth - 1);
        else if (c === '[') bracketDepth++;
        else if (c === ']') bracketDepth = Math.max(0, bracketDepth - 1);
        else if (c === '{') braceDepth++;
        else if (c === '}') braceDepth = Math.max(0, braceDepth - 1);

        if (c === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += c;
        }
    }

    if (current.trim().length > 0) {
        parts.push(current.trim());
    }

    return parts;
}

/**
 * Wraps long function argument lists `Func(a, b, c)` or bundles `[a, b, c]`
 * onto multiple lines if exceeding printWidth.
 */
export function wrapArgumentsOrBundles(line: string, printWidth: number): string[] {
    const masked = maskCommentsAndStrings(line);

    // Look for outermost `(...)` with commas
    const parenMatch = masked.match(/([_a-zA-Z0-9]+)\s*\(([^)]+)\)/);
    if (parenMatch && line.length > printWidth) {
        const fullCall = parenMatch[0];
        const fnName = parenMatch[1];
        const innerArgs = parenMatch[2];
        const commaParts = splitByTopLevelCommas(innerArgs);

        if (commaParts.length > 1) {
            const callStart = masked.indexOf(fullCall);
            const prefix = line.substring(0, callStart).trimEnd();
            const suffix = line.substring(callStart + fullCall.length).trimStart();

            const broken: string[] = [];
            const header = (prefix.length > 0 ? prefix + ' ' : '') + fnName + '(';
            broken.push(header);
            for (let k = 0; k < commaParts.length; k++) {
                const arg = commaParts[k];
                const isLast = k === commaParts.length - 1;
                broken.push(arg + (isLast ? '' : ','));
            }
            broken.push(')' + (suffix.length > 0 ? ' ' + suffix : ''));
            return broken;
        }
    }

    // Look for long bundle `[...]` with commas
    const bundleMatch = masked.match(/\[([^\]]+)\]/);
    if (bundleMatch && line.length > printWidth) {
        const fullBundle = bundleMatch[0];
        const innerItems = bundleMatch[1];
        const commaParts = splitByTopLevelCommas(innerItems);

        if (commaParts.length > 1) {
            const bundleStart = masked.indexOf(fullBundle);
            const prefix = line.substring(0, bundleStart).trimEnd();
            const suffix = line.substring(bundleStart + fullBundle.length).trimStart();

            const broken: string[] = [];
            broken.push((prefix.length > 0 ? prefix + ' ' : '') + '[');
            for (let k = 0; k < commaParts.length; k++) {
                const item = commaParts[k];
                const isLast = k === commaParts.length - 1;
                broken.push(item + (isLast ? '' : ','));
            }
            broken.push(']' + (suffix.length > 0 ? ' ' + suffix : ''));
            return broken;
        }
    }

    return [line];
}

/**
 * Pre-processes lines: if a line exceeds printWidth, breaks it at top-level `>>`
 * and/or wraps long argument lists `(...)` and bundles `[...]`.
 */
export function wrapLongLines(text: string, printWidth: number = 100): string {
    const lines = text.split(/\r?\n/);
    const outLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // If line fits within printWidth, keep it as is
        if (line.length <= printWidth) {
            outLines.push(line);
            continue;
        }

        const trimmed = line.trim();

        // Do not wrap comment lines
        if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('/*')) {
            outLines.push(line);
            continue;
        }

        const masked = maskCommentsAndStrings(line);

        // Check for long stream lines containing top-level `>>`
        // Find positions of `>>` outside of (), [], {}
        const streamOpIndices: number[] = [];
        let pDepth = 0, bDepth = 0, brDepth = 0;
        for (let j = 0; j < masked.length - 1; j++) {
            const c = masked[j];
            if (c === '(') pDepth++;
            else if (c === ')') pDepth = Math.max(0, pDepth - 1);
            else if (c === '[') bDepth++;
            else if (c === ']') bDepth = Math.max(0, bDepth - 1);
            else if (c === '{') brDepth++;
            else if (c === '}') brDepth = Math.max(0, brDepth - 1);

            if (pDepth === 0 && bDepth === 0 && brDepth === 0 && c === '>' && masked[j + 1] === '>') {
                streamOpIndices.push(j);
            }
        }

        if (streamOpIndices.length > 0) {
            // Split stream into stages
            const stages: string[] = [];
            let lastIdx = 0;
            for (const opIdx of streamOpIndices) {
                const stage = line.substring(lastIdx, opIdx).trim();
                if (stage.length > 0) {
                    stages.push(stage);
                }
                lastIdx = opIdx;
            }
            const lastStage = line.substring(lastIdx).trim();
            if (lastStage.length > 0) {
                stages.push(lastStage);
            }

            if (stages.length > 1) {
                for (const st of stages) {
                    if (st.length > printWidth) {
                        outLines.push(...wrapArgumentsOrBundles(st, printWidth));
                    } else {
                        outLines.push(st);
                    }
                }
                continue;
            }
        }

        // If no top-level >> or only 1 stage, check if it has long arguments or bundles
        const wrapped = wrapArgumentsOrBundles(line, printWidth);
        outLines.push(...wrapped);
    }

    return outLines.join('\n');
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
    const printWidth = options.printWidth ?? 100;

    // Wrap long streams (>>), arguments, and bundles exceeding printWidth
    const wrappedText = wrapLongLines(text, printWidth);

    const lines = wrappedText.split(/\r?\n/);
    const maskedText = maskCommentsAndStrings(wrappedText);
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
    const printWidth = resolvedConfig?.printWidth ?? 100;

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

/**
 * VS Code DocumentRangeFormattingEditProvider implementation for Stride documents.
 * Evaluates document context from the top down so that snippet indentation matches
 * the exact scope depth and stream continuation state, while only generating edits
 * strictly within the user's selected range.
 */
export async function provideDocumentRangeFormattingEdits(
    document: vscode.TextDocument,
    range: vscode.Range,
    options: vscode.FormattingOptions,
    token?: vscode.CancellationToken
): Promise<vscode.TextEdit[]> {
    if (token?.isCancellationRequested) {
        return [];
    }

    let resolvedConfig: prettier.Options | null = null;
    try {
        resolvedConfig = await prettier.resolveConfig(document.uri.fsPath);
    } catch {
        resolvedConfig = null;
    }

    const tabWidth = resolvedConfig?.tabWidth ?? options.tabSize ?? 4;
    const useTabs = resolvedConfig?.useTabs ?? (!options.insertSpaces);
    const printWidth = resolvedConfig?.printWidth ?? 100;
    const indentUnit = useTabs ? '\t' : ' '.repeat(tabWidth);

    const startLine = range.start.line;
    const endLine = range.end.character === 0 && range.end.line > range.start.line
        ? range.end.line - 1
        : range.end.line;

    const text = document.getText();
    const lines = text.split(/\r?\n/);
    const maskedText = maskCommentsAndStrings(text);
    const maskedLines = maskedText.split(/\r?\n/);

    let indentLevel = 0;
    let inStreamContinuation = false;
    let streamBaseIndent = 0;

    const edits: vscode.TextEdit[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (token?.isCancellationRequested) {
            return [];
        }

        const orig = lines[i];
        const trimmed = orig.trim();
        const maskedLine = maskedLines[i].trim();

        const leadingCloseMatch = maskedLine.match(/^[\}\]\)\s]+/);
        const leadingCloseCount = leadingCloseMatch
            ? leadingCloseMatch[0].replace(/\s/g, '').length
            : 0;

        const currentLineIndent = Math.max(0, indentLevel - leadingCloseCount);

        const startsWithStream = maskedLine.startsWith('>>');
        if (startsWithStream && !inStreamContinuation) {
            inStreamContinuation = true;
            streamBaseIndent = currentLineIndent;
        }

        const isContinuation = inStreamContinuation && (currentLineIndent >= streamBaseIndent);
        const effectiveIndent = currentLineIndent + (isContinuation ? 1 : 0);

        if (i >= startLine && i <= endLine) {
            if (orig.length > printWidth) {
                const sublines = wrapLongLines(orig, printWidth).split(/\r?\n/);
                if (sublines.length > 1) {
                    const formattedSublines: string[] = [];
                    let tempIndentLevel = indentLevel;
                    let tempStreamCont = inStreamContinuation;
                    let tempStreamBase = streamBaseIndent;

                    for (const sub of sublines) {
                        const subTrimmed = sub.trim();
                        if (subTrimmed.length === 0) continue;
                        const subMasked = maskCommentsAndStrings(subTrimmed);
                        const subLeadingCloseMatch = subMasked.match(/^[\}\]\)\s]+/);
                        const subLeadingCloseCount = subLeadingCloseMatch
                            ? subLeadingCloseMatch[0].replace(/\s/g, '').length
                            : 0;

                        const subLineIndent = Math.max(0, tempIndentLevel - subLeadingCloseCount);
                        const subStartsWithStream = subMasked.startsWith('>>');
                        if (subStartsWithStream && !tempStreamCont) {
                            tempStreamCont = true;
                            tempStreamBase = subLineIndent;
                        }
                        const subIsCont = tempStreamCont && (subLineIndent >= tempStreamBase);
                        const subEffectiveIndent = subLineIndent + (subIsCont ? 1 : 0);

                        formattedSublines.push(indentUnit.repeat(subEffectiveIndent) + subTrimmed);

                        const subOpens = (subMasked.match(/[\{\[\(]/g) || []).length;
                        const subCloses = (subMasked.match(/[\}\]\)]/g) || []).length;
                        const subNewIndent = Math.max(0, tempIndentLevel + subOpens - subCloses);

                        const subHasSemicolon = subMasked.endsWith(';') || (subMasked.includes(';') && subCloses >= subOpens);
                        if (tempStreamCont) {
                            if (subHasSemicolon && subNewIndent <= tempStreamBase) {
                                tempStreamCont = false;
                            } else if (subNewIndent < tempStreamBase) {
                                tempStreamCont = false;
                            }
                        } else if (subMasked.includes('>>') && !subHasSemicolon) {
                            tempStreamCont = true;
                            tempStreamBase = subLineIndent;
                        }
                        tempIndentLevel = subNewIndent;
                    }

                    const multiLineResult = formattedSublines.join('\n');
                    if (orig !== multiLineResult) {
                        const lineRange = document.lineAt(i).range;
                        edits.push(vscode.TextEdit.replace(lineRange, multiLineResult));
                    }
                } else {
                    let targetLine: string;
                    if (trimmed.length === 0) {
                        targetLine = '';
                    } else {
                        targetLine = indentUnit.repeat(effectiveIndent) + trimmed;
                    }

                    if (orig !== targetLine) {
                        const lineRange = document.lineAt(i).range;
                        edits.push(vscode.TextEdit.replace(lineRange, targetLine));
                    }
                }
            } else {
                let targetLine: string;
                if (trimmed.length === 0) {
                    targetLine = '';
                } else {
                    targetLine = indentUnit.repeat(effectiveIndent) + trimmed;
                }

                if (orig !== targetLine) {
                    const lineRange = document.lineAt(i).range;
                    edits.push(vscode.TextEdit.replace(lineRange, targetLine));
                }
            }
        }

        if (i > endLine) {
            // Can terminate loop once past the end of the selection
            break;
        }

        // Bracket counting
        const opens = (maskedLine.match(/[\{\[\(]/g) || []).length;
        const closes = (maskedLine.match(/[\}\]\)]/g) || []).length;
        const newIndentLevel = Math.max(0, indentLevel + opens - closes);

        const hasSemicolon = maskedLine.endsWith(';') || (maskedLine.includes(';') && closes >= opens);
        const hasStreamOp = maskedLine.includes('>>');

        if (inStreamContinuation) {
            if (hasSemicolon && newIndentLevel <= streamBaseIndent) {
                inStreamContinuation = false;
            } else if (newIndentLevel < streamBaseIndent) {
                inStreamContinuation = false;
            }
        } else {
            if (hasStreamOp && !hasSemicolon) {
                inStreamContinuation = true;
                streamBaseIndent = currentLineIndent;
            }
        }

        indentLevel = newIndentLevel;
    }

    return edits;
}
