# Change Log

All notable changes to the "stride-language" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Support for renamed and framework-sized core data types:
  - Sized integer types (`Int8`, `Int16`, `Int32`, `Int64`, `UInt8`, `UInt16`, `UInt32`, `UInt64`) and float types (`Float32`, `Float64`).
  - Framework alias types (`Int`, `UInt`, `Real`, `Size`) and scalar types (`Switch`, `String`).
  - Schema type classes (`_NumericTypes`, `_IntegerTypes`, `_FloatTypes`, `_DataTypes`).
  - Alias definitions now follow the `entity:` property with multi-level alias resolution.
- Added diagnostics for lossy type conversions and promotion data loss, highlighted as warnings with squiggly lines in both the native LSP server and the TypeScript fallback engine.
- Synchronized bundled standard library (`strideroot`) with the latest core definitions and framework platforms.
- Fixed native language server build against `stridegen` and `strideparser`.
- Resolved LSP symbol resolution and hover card popups:
  - Isolated JSON-RPC standard output stream from debug / runtime library output by redirecting logging to stderr.
  - Added full dynamic symbol resolution and hover card documentation for data types, aliases, keywords, and AST declarations.
  - Fixed AST validation and type-loss warning extraction without requiring full hardware system declarations in single-file editing mode.
  - Enabled Go-to-Definition navigation across local document declarations and standard library definitions.
- Added interactive Quick-Pick for F5 execution when no `launch.json` is configured:
  - Run Unit Tests in File (`stridetest`)
  - Compile File to Disk (`stridec` emitting `.o` and `.h`)
  - Build and Flash / Run (target compilation with hardware flashing support prepared for an upcoming release)
- Added Editor Title Run button and Context Menu actions for running tests, compiling, and building.
- Added configuration settings `stride.stridecPath` and `stride.stridetestPath` with automatic fallback discovery.
- Fixed Extension Development Host launch crash (code 134 / SIGABRT) by eliminating malformed environment variable cloning on Windows and properly awaiting asynchronous language client startup.
- Added automatic fallback engine activation upon LSP server connection closure, ensuring symbols, hover cards, and diagnostics stay active under all conditions.
- Prevented infinite recursion and stack overflows in LSP document symbols by tracking visited AST nodes.
- Disambiguated property keys from type names during hover lookup based on trailing colon tokens.
- Protected native LSP semantic analysis with structured exception handling to safely catch assertion faults and access violations during interactive editing.
- Initial release
