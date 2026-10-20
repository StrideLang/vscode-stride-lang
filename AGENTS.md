# VS Code Stride Language Extension (`vscode-stride-lang`) Development & Agent Guide

This document outlines architectural patterns, code generation and parsing invariants, symbol resolution rules, and build/publishing workflows for developing in `vscode-stride-lang`.

---

## 1. Architecture Overview

`vscode-stride-lang` provides rich language tooling, syntax highlighting, code navigation, autocompletion, hover documentation, document outline, and diagnostics for the **Stride Language** (`.stride` files).

The extension employs a **dual-engine architecture**:

1. **Native C++ Language Server (LSP Mode)**:
   - Implemented in [`server/src/main.cpp`](file:///c:/Users/Andres/source/repos/vscode-stride-lang/server/src/main.cpp).
   - Built against `strideparser`, `strideutils`, and `codegen` C++ libraries.
   - Communicates over standard I/O via JSON-RPC 2.0.
   - Provides full AST validation, syntax error reporting, hover, and document symbol hierarchy.

2. **TypeScript Fallback Engine (In-Process Mode)**:
   - Implemented in [`src/extension.ts`](file:///c:/Users/Andres/source/repos/vscode-stride-lang/src/extension.ts).
   - Automatically activates if the native LSP binary (`stride-lsp.exe`) is unavailable or fails to start.
   - Implements full VS Code providers: `DocumentSymbolProvider`, `HoverProvider`, `DefinitionProvider`, `CompletionItemProvider`, `ReferenceProvider`, `DocumentFormattingEditProvider`, and real-time diagnostics caching.

---

## 2. Directory Structure

```text
vscode-stride-lang/
├── .vscode/               # VS Code launch and task configs
├── server/                # C++ Language Server implementation
│   ├── CMakeLists.txt     # Server CMake build script
│   ├── src/main.cpp       # LSP Server main entrypoint & handlers
│   └── bin/               # Compiled server binaries (stride-lsp.exe)
├── snippets/              # Snippets for Stride declarations and templates
│   └── stride.json
├── src/                   # TypeScript extension implementation
│   └── extension.ts       # Client lifecycle, fallback providers, AST cache
├── strideroot/            # Bundled fallback standard library definitions
│   ├── Core.stride
│   ├── Math.stride
│   └── ...
├── syntaxes/              # TextMate grammar definitions
│   └── stride.tmLanguage.json
├── language-configuration.json # Brackets, comments, indentation rules
├── package.json           # Extension manifest, settings, configuration
└── tsconfig.json          # TypeScript compiler configuration
```

---

## 3. Standard Library & `STRIDEROOT` Resolution Priority

Stride standard library files (`.stride`) define built-in types, platform modules, core functions, and domains.

> [!IMPORTANT]
> **Resolution Priority Order**:
> 1. User configuration in VS Code settings: `stride.strideroot` (`settings.json`).
> 2. Environment variable: `STRIDEROOT`.
> 3. **Bundled Fallback Library**: `./strideroot` inside the extension.
>
> No custom or adjacent directory paths are searched until a formal include directory mechanism is defined.
> **The bundled fallback directory must NEVER override explicit user settings or environment variables.** It only acts as the ultimate fallback when no external library is provided.

---

## 4. Scope Tree & Outline Hierarchy Invariants

### Offset-Based Enclosure Bounding
- In [`src/extension.ts`](file:///c:/Users/Andres/source/repos/vscode-stride-lang/src/extension.ts), `parseScopeTree` and `parseDeclarationsFromBlock` extract all block declarations matching `\b([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?\s*(?=\{)`.
- Named (`module Foo { ... }`) and anonymous (`typeProperty { name: "val" ... }`, `block: Output`) blocks are tracked by exact character offsets (`startOffset`, `endOffset`).
- Scopes are sorted by span size ascending (`endOffset - startOffset`), ensuring child blocks attach to their tightest enclosing parent:
  ```typescript
  candidate.startOffset <= scope.startOffset && candidate.endOffset >= scope.endOffset
  ```

### Outline Child Nodes
- All blocks declared inside containers (such as `typeProperty` in `type { properties: [ ... ] }`, `signal` and `port` inside `module { blocks: [ ... ] }`, and `state` / `transition` inside state machines) MUST appear as nested child nodes under the parent declaration in the VS Code Document Outline.

### Symbol Kind Mappings
| Stride Construct | VS Code `SymbolKind` (TS) | LSP Integer Kind (C++) |
| :--- | :--- | :--- |
| `_domainDefinition`, `gameDefinition`, `domainDeclaration`, `type` | `SymbolKind.Class` | `5` (Class) |
| `module`, `reaction`, `loop` | `SymbolKind.Function` | `6` (Method/Function) |
| `typeProperty`, `property` | `SymbolKind.Property` | `7` (Property) |
| `mainInputPort`, `mainOutputPort`, `propertyInputPort`, `propertyOutputPort`, `port` | `SymbolKind.Interface` | `11` (Interface) |
| `signal`, `switch`, `trigger` | `SymbolKind.Variable` | `13` (Variable) |
| `state`, `transition` | `SymbolKind.Struct` | `23` (Struct) |

---

## 5. Property Key vs. Type Name Resolution Invariant

When parsing or providing hover for tokens inside block declarations:
- If a token is followed by a colon (`:`), it is a **property key** (e.g. `type: _RealType` -> `type` is the field name belonging to the enclosing declaration, not the type `type`).
- Always check `isFollowedByColon` or position within property lists before attempting type name lookup.

---

## 6. Document Caching & Performance

To prevent UI stutter during typing:
- Use `getCachedDocData(document)` in [`src/extension.ts`](file:///c:/Users/Andres/source/repos/vscode-stride-lang/src/extension.ts).
- Data cached: `version`, `cleanText`, `types`, `scopeTree`, and `innermostDeclarationMap`.
- Cache is invalidated strictly on document version change, avoiding redundant AST re-parsing on cursor move, hover, or completion requests.

---

## 7. Compilation, Testing & Launch (F5) Architecture

### F5 DebugConfigurationProvider Contract
- In [`src/extension.ts`](file:///c:/Users/Andres/source/repos/vscode-stride-lang/src/extension.ts), `StrideDebugConfigurationProvider` registers as a VS Code debugger provider for `type: "stride"`.
- It implements `provideDebugConfigurations` (providing default templates for `test`, `compile`, and `flash`) and `resolveDebugConfiguration`.
- If triggered on a `.stride` file without a pre-existing `launch.json`, it prompts the user with an interactive `QuickPick` containing the 3 configurations.
- `resolveDebugConfiguration` triggers `executeStrideLaunchConfig(config)` and returns `undefined` to cleanly terminate the VS Code debug session lifecycle without launching a debug adapter process.
- All dirty documents are automatically saved via `doc.save()` before execution.

### Toolchain Resolution Priority
When finding executables (`stridec.exe`, `stridetest.exe`):
1. VS Code settings: `stride.stridecPath` or `stride.stridetestPath`.
2. Environment variables: `STRIDEC_PATH` or `STRIDETEST_PATH`.
3. Sibling repository build directories (`build-Stride-*`, `boardgame/build/*`, `build/`).
4. Fallback to binary name on system `PATH`.

### Terminal Execution & Variable Expansion
- Dedicated persistent terminals are used for each mode: `Stride: Test`, `Stride: Compile`, `Stride: Flash`.
- Variable substitutions (`${file}`, `${fileDirname}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`, `${workspaceFolder}`) are evaluated before constructing the command string.
- Command lines are escaped with `quoteArg` and prefixed with `&` on Windows PowerShell to ensure robust handling of paths containing whitespace.

---

## 8. Build, Test, and Packaging Instructions

### TypeScript Extension Build
```powershell
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode during development
npm run watch
```

### C++ Language Server Build
```powershell
# Configure CMake
cmake -B server/build -S server -G "Visual Studio 17 2022" -A x64

# Build Debug / Release
cmake --build server/build --config Debug
cmake --build server/build --config Release
```
The output binary is placed in `server/bin/stride-lsp.exe`.

### Packaging & Publishing with VSCE
```powershell
# Create .vsix package
npx vsce package

# Publish to Visual Studio Marketplace
npx vsce publish -p <PERSONAL_ACCESS_TOKEN>
```
- **Publisher**: `StrideLang`
- **PAT Requirements**: Azure DevOps -> Personal Access Token -> All accessible organizations -> Scope: `Marketplace (Acquire, Manage)`.
