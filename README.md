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

## Extension Settings

- `stride.server.path`: Optional override for the path to the `stride-lsp.exe` binary.
- `stride.includePaths`: Additional search paths for Stride system and domain definitions.
- `stride.trace.server`: Tracing level for LSP communications (`off`, `messages`, `verbose`).

## License

BSD-3-Clause
