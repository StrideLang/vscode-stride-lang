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

## Compiling, Testing & Launching (F5)

`vscode-stride-lang` provides complete integration with the Stride toolchain (`stridec` compiler and `stridetest` test runner).

### 1. F5 Execution & Interactive Quick-Pick
Press **`F5`** while viewing any `.stride` file to run or compile. If no `.vscode/launch.json` file is present in your workspace, an interactive Quick-Pick menu will prompt you to select from three execution modes:

- **Run Unit Tests in File (`mode: "test"`)**:
  - Invokes `stridetest <file> --root <strideroot>`.
  - Runs inside the dedicated `Stride: Test` integrated terminal.
- **Compile File to Disk (`mode: "compile"`)**:
  - Compiles the active `.stride` file to an object file (`.o`) and C/C++ header (`.h`):
    `stridec -c <file> -o <output.o> --emit-header=<header.h> --strideroot=<strideroot>`
  - Runs inside the dedicated `Stride: Compile` integrated terminal.
- **Build and Flash / Run (Future) (`mode: "flash"`)**:
  - Compiles the target binary and verifies build artifacts, designated for target device upload in an upcoming release.
  - Runs inside the dedicated `Stride: Flash` integrated terminal.

> [!TIP]
> Any unsaved modifications in the active editor are automatically saved before compilation or test execution begins.

### 2. Editor Title & Context Menus
You can also trigger these actions directly without keyboard shortcuts:
- The **Run button** in the top-right editor title bar.
- The **Right-click context menu** inside any `.stride` file.
- The **Command Palette** (`Ctrl+Shift+P`):
  - `Stride: Run Unit Tests in File`
  - `Stride: Compile File to Disk`
  - `Stride: Build and Flash / Run (Future)`

### 3. Launch Configurations (`launch.json`)
You can define custom configurations in `.vscode/launch.json`:

```json
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "stride",
            "request": "launch",
            "name": "Stride: Run Tests",
            "mode": "test",
            "file": "${file}"
        },
        {
            "type": "stride",
            "request": "launch",
            "name": "Stride: Compile to Disk",
            "mode": "compile",
            "file": "${file}",
            "output": "${fileDirname}/${fileBasenameNoExtension}.o",
            "header": "${fileDirname}/${fileBasenameNoExtension}.h"
        },
        {
            "type": "stride",
            "request": "launch",
            "name": "Stride: Build & Flash",
            "mode": "flash",
            "file": "${file}"
        }
    ]
}
```

Supported variable expansions in paths: `${file}`, `${fileDirname}`, `${fileBasename}`, `${fileBasenameNoExtension}`, `${fileExtname}`, and `${workspaceFolder}`.

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
- `stride.stridecPath`: Path to the Stride Compiler binary (`stridec.exe`). If empty, auto-discovery is used.
- `stride.stridetestPath`: Path to the Stride Unit Test Runner binary (`stridetest.exe`). If empty, auto-discovery is used.
- `stride.strideroot`: Path to the Stride root directory containing standard library definitions (overrides environment variable and bundled fallback library).
- `stride.includePaths`: Additional search paths for Stride system and domain definitions.
- `stride.trace.server`: Tracing level for LSP communications (`off`, `messages`, `verbose`).

### Toolchain Discovery Order
When `stride.stridecPath` or `stride.stridetestPath` is not explicitly set, the extension automatically discovers executables in the following order:
1. User settings in VS Code (`stride.stridecPath`, `stride.stridetestPath`).
2. Environment variables (`STRIDEC_PATH`, `STRIDETEST_PATH`).
3. Local workspace and sibling build directories (e.g. `build-Stride-*`, `boardgame/build/*`).
4. System `PATH`.

## License

BSD-3-Clause
