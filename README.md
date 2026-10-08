# Stride Language Support for Visual Studio Code

Comprehensive language support and Language Server for **[Stride](https://github.com/StrideLang)**, the stream-based dataflow and state machine programming language.

## Features

- **Rich Syntax Highlighting**:
  - Declarations: `_domainDefinition`, `gameDefinition`, `module`, `reaction`, `loop`, `state`, `transition`, `platformModule`, `platformFunction`, `type`.
  - Blocks & Ports: `signal`, `switch`, `trigger`, `mainInputPort`, `mainOutputPort`, `propertyInputPort`, `propertyOutputPort`, `typeProperty`.
  - Built-in Types: `_IntType`, `_RealType`, `_SwitchType`, `_StateType`, `_DomainDefinition`, `_Signal`, `_RootContext`, `_DomainFunction`, `_JitFramework`.
  - Operators: Stream operator (`>>`), arithmetic, logical (`&&`, `||`, `!`, `and`, `or`, `not`), bitwise (`&`, `|`, `~`), scope (`::`), and polymorphism annotations (`@`).
  - Numbers: Hexadecimal (`0xFF`), Floating-point (`3.14`), and Integers (`100`).
  - Constants: `on`, `off`, `none`.
  - Escapes and Platform Module token placeholders (`%%outtokens:0%%`, `%%intokens:0%%`).
- **Language Server (`stride-lsp`)**:
  - **On-Hover Documentation**: Inferred types, rates, domains, port signatures, and docstrings from `meta:` properties.
  - **Real-Time Diagnostics**: Syntax errors from `strideparser` and semantic validation from `strd::CodeValidator`.
  - **Document Symbols & Outline**: Hierarchical overview of domains, modules, states, transitions, and signals.
  - **Go to Definition**: Jump from usages or transitions to declarations.
  - **Auto-Completion**: Context-aware suggestions for keywords, types, and properties.
- **Smart Editing**:
  - Auto-closing pairs and surrounding pairs for braces, brackets, parentheses, and quotes.
  - Context-aware indentation for blocks and property lists.
  - Code folding for bracket blocks and `#region` / `#endregion` markers.
- **Code Snippets**:
  - `domain`: Scaffold a `_domainDefinition`.
  - `module`: Complete module template with ports, blocks, and stream connections.
  - `reaction`: Reaction triggered by switch/property input ports.
  - `loop`: Loop construct with iteration index and `terminateWhen` condition.
  - `statemachine` / `state` / `transition`: Declarative hierarchical state machine definitions.
  - `platformModule`: Low-level LLVM IR binding blocks.
  - `signal` / `switch`: Variable declarations.

---

## Building the Language Server (`server/`)

The C++ Language Server lives under [`server/`](file:///C:/Users/Andres/source/repos/vscode-stride-lang/server).

To build:
```powershell
cd C:\Users\Andres\source\repos\vscode-stride-lang\server
cmake -B build
cmake --build build --config Release
```
This outputs `stride-lsp.exe` directly into `server/bin/`, where the VS Code extension automatically discovers and launches it.

---

## Testing & Development

You can test and debug the extension directly using VS Code's Extension Development Host:

### 1. Launch the Extension Host
1. Open the `vscode-stride-lang` repository in VS Code.
2. Ensure dependencies are compiled:
   ```powershell
   npm install
   npm run compile
   ```
3. Press **`F5`** (or go to the **Run and Debug** panel and select **Run Extension**).
4. A new window labeled `[Extension Development Host]` will open with the Stride extension loaded.
5. Open any `.stride` file in that window to test syntax highlighting, hover, definitions, document outline, completions, and diagnostics.

### 2. Live Reloading
- Run TypeScript watch mode in your terminal:
  ```powershell
  npm run watch
  ```
- After making code changes in `src/extension.ts`, simply press **`Ctrl+R`** inside the `[Extension Development Host]` window (or execute `Developer: Reload Window` from the Command Palette `Ctrl+Shift+P`) to reload the updated extension instantly.

---

## Packaging and Offline Installation

You can package and install the extension without publishing to the VS Code Marketplace.

### 1. Build and Package `.vsix`
```powershell
# Install dependencies & compile TypeScript
npm install
npm run compile

# Package into a standalone .vsix installer
npx @vscode/vsce package
```
This generates `stride-language-0.1.0.vsix` in the project root.

### 2. Installing the `.vsix`

- **Via Command Line**:
  ```powershell
  code --install-extension stride-language-0.1.0.vsix
  ```

- **Via VS Code UI**:
  1. Open the Extensions view (`Ctrl+Shift+X`).
  2. Click the **`...`** (More Actions) menu in the top right of the Extensions panel.
  3. Select **Install from VSIX...** and choose `stride-language-0.1.0.vsix`.

---

## Extension Settings

- `stride.server.path`: Optional override for the path to the `stride-lsp.exe` binary.
- `stride.strideroot`: Path to the Stride root directory containing standard library definitions (overrides environment variable and bundled fallback library).
- `stride.includePaths`: Additional search paths for Stride system and domain definitions.
- `stride.trace.server`: Tracing level for LSP communications (`off`, `messages`, `verbose`).

## License

BSD-3-Clause
