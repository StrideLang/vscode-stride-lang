/*
    Stride Language Server Protocol (LSP) Server
    Provides real-time diagnostics, on-hover documentation, document symbols,
    go-to-definition, and completions for Stride language and domain files.
*/

#include <iostream>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <fstream>
#include <memory>
#include <cctype>
#include <algorithm>
#include <cstdio>
#include <filesystem>
#include <cstdlib>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "stride/parser/strideparser.h"
#include "stride/codegen/codeanalysis.hpp"
#include "stride/codegen/codevalidator.hpp"
#include "stride/codegen/stridesystem.hpp"
#include "stride/utils/astquery.h"
#include "stride/utils/astvalidation.h"
#include "stride/utils/stridelibrary.h"

using namespace strd;

namespace {

// ============================================================================
// Simple JSON-RPC & JSON Builder Utilities
// ============================================================================

std::string escapeJson(const std::string &s) {
    std::ostringstream o;
    for (char c : s) {
        switch (c) {
            case '"': o << "\\\""; break;
            case '\\': o << "\\\\"; break;
            case '\b': o << "\\b"; break;
            case '\f': o << "\\f"; break;
            case '\n': o << "\\n"; break;
            case '\r': o << "\\r"; break;
            case '\t': o << "\\t"; break;
            default:
                if ('\x00' <= c && c <= '\x1f') {
                    o << "\\u" << std::hex << ((int)c);
                } else {
                    o << c;
                }
        }
    }
    return o.str();
}

void sendLspResponse(const std::string &jsonPayload) {
    std::cout << "Content-Length: " << jsonPayload.length() << "\r\n\r\n" << jsonPayload;
    std::cout.flush();
}

std::string getTempFilePath() {
#ifdef _WIN32
    char tempPath[MAX_PATH];
    char tempFileName[MAX_PATH];
    if (GetTempPathA(MAX_PATH, tempPath) && GetTempFileNameA(tempPath, "strd", 0, tempFileName)) {
        return std::string(tempFileName);
    }
    return "stride_lsp_temp.stride";
#else
    char tempName[] = "/tmp/strd_lsp_XXXXXX";
    int fd = mkstemp(tempName);
    if (fd != -1) {
        close(fd);
        return std::string(tempName);
    }
    return "/tmp/stride_lsp_temp.stride";
#endif
}

std::string uriToPath(const std::string &uri) {
    std::string path = uri;
    const std::string prefix = "file:///";
    const std::string prefix2 = "file://";
    if (path.rfind(prefix, 0) == 0) {
        path = path.substr(prefix.length());
    } else if (path.rfind(prefix2, 0) == 0) {
        path = path.substr(prefix2.length());
    }
#ifdef _WIN32
    size_t pos = 0;
    while ((pos = path.find("%3A", pos)) != std::string::npos) {
        path.replace(pos, 3, ":");
        pos += 1;
    }
    while ((pos = path.find("%3a", pos)) != std::string::npos) {
        path.replace(pos, 3, ":");
        pos += 1;
    }
    for (char &c : path) {
        if (c == '/') c = '\\';
    }
#endif
    return path;
}

// ============================================================================
// Document Cache & Analysis State
// ============================================================================

struct DocumentState {
    std::string uri;
    std::string text;
    int version{0};
    ASTNode tree{nullptr};
    std::vector<LangError> errors;
};

std::map<std::string, DocumentState> openDocuments;

std::string extractMetaDoc(ASTNode node) {
    if (!node) return "";
    auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
    if (!decl) return "";
    auto metaProp = decl->getProperty("meta");
    if (metaProp && metaProp->getValue()) {
        auto valNode = std::dynamic_pointer_cast<ValueNode>(metaProp->getValue());
        if (valNode && valNode->getNodeType() == AST::String) {
            return valNode->getStringValue();
        }
    }
    return "";
}

std::string getWordAtPosition(const std::string &content, int line, int character) {
    std::istringstream stream(content);
    std::string lineStr;
    int curLine = 0;
    while (std::getline(stream, lineStr)) {
        if (curLine == line) {
            if (character < 0 || character >= (int)lineStr.size()) {
                if (character == (int)lineStr.size() && !lineStr.empty()) {
                    character = (int)lineStr.size() - 1;
                } else {
                    return "";
                }
            }
            int start = character;
            while (start > 0 && (isalnum((unsigned char)lineStr[start - 1]) || lineStr[start - 1] == '_' || lineStr[start - 1] == '@')) {
                start--;
            }
            int end = character;
            while (end < (int)lineStr.size() && (isalnum((unsigned char)lineStr[end]) || lineStr[end] == '_' || lineStr[end] == '@')) {
                end++;
            }
            if (start < end) {
                return lineStr.substr(start, end - start);
            }
            return "";
        }
        curLine++;
    }
    return "";
}

ScopeStack buildScopeStackForPosition(ASTNode root, int targetLine) {
    ScopeStack stack;
    if (!root) return stack;

    std::function<void(ASTNode)> traverse = [&](ASTNode node) {
        if (!node) return;
        auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
        if (decl) {
            std::string objType = decl->getObjectType();
            if (objType == "module" || objType == "reaction" || objType == "loop" ||
                objType == "_domainDefinition" || objType == "gameDefinition" ||
                objType == "domainDeclaration" || objType == "state") {
                
                std::vector<ASTNode> localBlocks = ASTQuery::getModuleBlocks(decl);
                auto portsVal = decl->getPropertyValue("ports");
                if (portsVal) {
                    for (const auto &p : portsVal->getChildren()) {
                        localBlocks.push_back(p);
                    }
                }
                auto inputsVal = decl->getPropertyValue("inputs");
                if (inputsVal) {
                    for (const auto &inp : inputsVal->getChildren()) {
                        localBlocks.push_back(inp);
                    }
                }
                auto outputsVal = decl->getPropertyValue("outputs");
                if (outputsVal) {
                    for (const auto &outp : outputsVal->getChildren()) {
                        localBlocks.push_back(outp);
                    }
                }

                stack.push_back({ decl, localBlocks });
            }
        }

        for (const auto &child : node->getChildren()) {
            traverse(child);
        }
    };

    traverse(root);
    return stack;
}

std::shared_ptr<DeclarationNode> findPortForBlockInScopeStack(const ScopeStack &scopeStack, ASTNode root, const std::string &blockName) {
    for (auto it = scopeStack.rbegin(); it != scopeStack.rend(); ++it) {
        for (const auto &node : it->second) {
            auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
            if (decl) {
                std::string type = decl->getType();
                if (type.find("Port") != std::string::npos || type == "port") {
                    auto blockProp = decl->getProperty("block");
                    if (blockProp && blockProp->getValue()) {
                        auto valNode = std::dynamic_pointer_cast<BlockNode>(blockProp->getValue());
                        if (valNode && valNode->getName() == blockName) return decl;
                        auto strNode = std::dynamic_pointer_cast<ValueNode>(blockProp->getValue());
                        if (strNode && strNode->getNodeType() == AST::String && strNode->getStringValue() == blockName) return decl;
                    }
                }
            }
        }
    }
    return nullptr;
}

// ============================================================================
// Stride Standard Library & Symbol Integration
// ============================================================================

StrideLibrary g_library;
ASTNode g_libraryRootTree = nullptr;

std::string findStrideRoot() {
    const char *envRoot = std::getenv("STRIDEROOT");
    if (envRoot && std::filesystem::exists(envRoot)) return std::string(envRoot);
    
    std::vector<std::string> candidates = {
        "C:/Users/Andres/source/repos/Stride/strideroot",
        "C:\\Users\\Andres\\source\\repos\\Stride\\strideroot",
        "../../Stride/strideroot",
        "../Stride/strideroot",
        "C:/Users/Andres/source/repos/boardgame/libgame/external/stridejit/tests/data",
        "C:/Users/Andres/source/repos/vscode-stride-lang/strideroot",
        "strideroot",
        "./strideroot",
        "../strideroot",
        "../../strideroot"
    };
    for (const auto &c : candidates) {
        if (std::filesystem::exists(c)) return c;
    }
    return "";
}

void initLibrary() {
    std::string sRoot = findStrideRoot();
    if (!sRoot.empty()) {
        try {
            g_library.initializeLibrary(sRoot);
            g_libraryRootTree = std::make_shared<AST>();
            auto members = g_library.getLibraryMembers();
            for (const auto &pair : members) {
                for (const auto &node : pair.second) {
                    g_libraryRootTree->addChild(node);
                }
            }
        } catch (...) {
            // Ignore if library path issues
        }
    }
}

// ============================================================================
// LSP Handlers
// ============================================================================

void publishDiagnostics(const std::string &uri, const std::vector<LangError> &errors, const std::string &docText) {
    std::ostringstream json;
    json << "{\"jsonrpc\":\"2.0\",\"method\":\"textDocument/publishDiagnostics\",\"params\":{";
    json << "\"uri\":\"" << escapeJson(uri) << "\",";
    json << "\"diagnostics\":[";

    for (size_t i = 0; i < errors.size(); i++) {
        auto err = errors[i];
        int line = (err.lineNumber > 0) ? (err.lineNumber - 1) : 0;
        int startChar = 0;
        int endChar = 100;

        std::vector<std::string> docLines;
        {
            std::istringstream stream(docText);
            std::string l;
            while (std::getline(stream, l)) {
                docLines.push_back(l);
            }
        }

        std::vector<std::string> searchTokens;
        if (err.type == LangError::InvalidPort) {
            if (err.errorTokens.size() > 1) searchTokens.push_back(err.errorTokens[1]);
            if (err.errorTokens.size() > 0) searchTokens.push_back(err.errorTokens[0]);
        } else if (err.type == LangError::InvalidPortType) {
            if (err.errorTokens.size() > 2) searchTokens.push_back(err.errorTokens[2]);
            if (err.errorTokens.size() > 1) searchTokens.push_back(err.errorTokens[1]);
            if (err.errorTokens.size() > 0) searchTokens.push_back(err.errorTokens[0]);
        } else if (err.type == LangError::ConstraintFail) {
            if (err.errorTokens.size() > 3) searchTokens.push_back(err.errorTokens[3]);
            if (err.errorTokens.size() > 1) searchTokens.push_back(err.errorTokens[1]);
        } else {
            searchTokens = err.errorTokens;
        }

        bool foundToken = false;
        if (!docLines.empty()) {
            for (const auto &tok : searchTokens) {
                if (tok.empty()) continue;

                // Priority 1: Check the given lineNumber
                if (line >= 0 && line < (int)docLines.size()) {
                    const auto &curLineStr = docLines[line];
                    size_t pos = 0;
                    while ((pos = curLineStr.find(tok, pos)) != std::string::npos) {
                        bool wordStart = (pos == 0 || (!isalnum((unsigned char)curLineStr[pos - 1]) && curLineStr[pos - 1] != '_'));
                        size_t endPos = pos + tok.length();
                        bool wordEnd = (endPos >= curLineStr.length() || (!isalnum((unsigned char)curLineStr[endPos]) && curLineStr[endPos] != '_'));
                        if (wordStart && wordEnd) {
                            startChar = (int)pos;
                            endChar = (int)endPos;
                            foundToken = true;
                            break;
                        }
                        pos++;
                    }
                }

                // Priority 2: If not found on reported line, search following lines in the block
                if (!foundToken) {
                    for (int offset = 1; offset < 50; offset++) {
                        int checkDown = line + offset;
                        if (checkDown < (int)docLines.size()) {
                            const auto &curLineStr = docLines[checkDown];
                            size_t pos = 0;
                            while ((pos = curLineStr.find(tok, pos)) != std::string::npos) {
                                bool wordStart = (pos == 0 || (!isalnum((unsigned char)curLineStr[pos - 1]) && curLineStr[pos - 1] != '_'));
                                size_t endPos = pos + tok.length();
                                bool wordEnd = (endPos >= curLineStr.length() || (!isalnum((unsigned char)curLineStr[endPos]) && curLineStr[endPos] != '_'));
                                if (wordStart && wordEnd) {
                                    line = checkDown;
                                    startChar = (int)pos;
                                    endChar = (int)endPos;
                                    foundToken = true;
                                    break;
                                }
                                pos++;
                            }
                            if (foundToken) break;
                        }
                    }
                }

                if (foundToken) break;
            }

            if (!foundToken && line >= 0 && line < (int)docLines.size()) {
                const auto &lineStr = docLines[line];
                size_t first = lineStr.find_first_not_of(" \t\r\n");
                if (first != std::string::npos) {
                    startChar = (int)first;
                    endChar = (int)lineStr.find_last_not_of(" \t\r\n") + 1;
                } else {
                    startChar = 0;
                    endChar = (int)lineStr.length();
                }
            }
        }

        if (i > 0) json << ",";
        json << "{";
        json << "\"range\":{\"start\":{\"line\":" << line << ",\"character\":" << startChar << "},\"end\":{\"line\":" << line << ",\"character\":" << endChar << "}},";
        json << "\"severity\":1,"; // 1 = Error
        json << "\"source\":\"stride\",";
        std::string msg = err.getErrorText();
        // Clean up leading "In file ...:\n    Line X : " prefix if present for cleaner IDE presentation
        size_t colonPos = msg.find(" : ");
        if (colonPos != std::string::npos) {
            msg = msg.substr(colonPos + 3);
        }
        if (msg.empty()) {
            msg = "Syntax or semantic validation error";
            if (!err.errorTokens.empty()) {
                msg = "";
                for (const auto &tok : err.errorTokens) {
                    if (!msg.empty()) msg += " ";
                    msg += tok;
                }
            }
        }
        json << "\"message\":\"" << escapeJson(msg) << "\"";
        json << "}";
    }

    json << "]}}";
    sendLspResponse(json.str());
}

void analyzeDocument(DocumentState &doc) {
    std::string tempFile = getTempFilePath();
    {
        std::ofstream out(tempFile, std::ios::binary);
        out << doc.text;
    }

    doc.errors.clear();
    doc.tree = nullptr;

    AST *parsedTree = parse(tempFile.c_str(), doc.uri.c_str());
    if (parsedTree) {
        doc.tree = std::shared_ptr<AST>(parsedTree);
        
        // Build combined tree with standard library for symbol and type resolution
        ASTNode combinedTree = std::make_shared<AST>();
        if (g_libraryRootTree) {
            for (const auto &libChild : g_libraryRootTree->getChildren()) {
                combinedTree->addChild(libChild);
            }
        }
        for (const auto &docChild : doc.tree->getChildren()) {
            combinedTree->addChild(docChild);
        }

        // 1. Validate AST types using ASTValidation from strideutils
        try {
            std::vector<LangError> valErrors;
            ASTValidation::validateTypes(doc.tree, valErrors, {}, combinedTree, {}, "");
            doc.errors.insert(doc.errors.end(), valErrors.begin(), valErrors.end());
        } catch (...) {
            // Safety catch
        }

        // 2. Validate using CodeValidator on combined tree
        try {
            CodeValidator validator(combinedTree);
            if (!validator.isValid()) {
                auto codeValErrors = validator.getErrors();
                for (const auto &err : codeValErrors) {
                    if (err.filename == tempFile || err.filename == doc.uri || err.filename.empty() || err.filename == uriToPath(doc.uri)) {
                        bool duplicate = false;
                        for (const auto &existing : doc.errors) {
                            if (existing.type == err.type && existing.lineNumber == err.lineNumber) {
                                duplicate = true;
                                break;
                            }
                        }
                        if (!duplicate) {
                            doc.errors.push_back(err);
                        }
                    }
                }
            }
        } catch (...) {
            // Validator safety catch
        }
    } else {
        auto parseErrors = getErrors();
        doc.errors.insert(doc.errors.end(), parseErrors.begin(), parseErrors.end());
    }

    std::remove(tempFile.c_str());
    publishDiagnostics(doc.uri, doc.errors, doc.text);
}

void handleHover(const std::string &id, const std::string &uri, int line, int character) {
    auto it = openDocuments.find(uri);
    std::string hoverText = "";

    if (it != openDocuments.end()) {
        std::string token = getWordAtPosition(it->second.text, line, character);
        if (!token.empty()) {
            if (token == "_IntType") {
                hoverText = "### Built-in Type: `_IntType`\n\nStandard 32-bit signed integer data type.";
            } else if (token == "_RealType") {
                hoverText = "### Built-in Type: `_RealType`\n\n64-bit IEEE 754 double precision floating point data type.";
            } else if (token == "_SwitchType") {
                hoverText = "### Built-in Type: `_SwitchType`\n\nBoolean switch / conditional control signal (`on` / `off`).";
            } else if (token == "_StateType") {
                hoverText = "### Built-in Type: `_StateType`\n\nState machine state representation.";
            } else if (token == "_DomainDefinition" || token == "domainDeclaration") {
                hoverText = "### Domain Definition Type\n\nRoot coordinator type for execution rates, framework backends, input/output signals, and state machines.";
            } else if (token == "gameDefinition") {
                hoverText = "### Domain Definition: `gameDefinition`\n\n**Inherits from**: `_DomainDefinition`\n\nCustom domain type for libgame game definition logic and rule execution.";
            } else if (token == "signal") {
                hoverText = "### Keyword: `signal`\n\nDeclares a continuous dataflow signal block or stream variable.";
            } else if (token == "switch") {
                hoverText = "### Keyword: `switch`\n\nDeclares a discrete boolean control switch block with `on` / `off` states.";
            } else if (token == "module") {
                hoverText = "### Keyword: `module`\n\nDeclares a reusable stream processing module with input/output ports and stream definitions.";
            } else if (token == "reaction") {
                hoverText = "### Keyword: `reaction`\n\nDeclares an event-triggered reaction block executed conditionally when its trigger switch fires.";
            } else if (token == "loop") {
                hoverText = "### Keyword: `loop`\n\nDeclares an iterative loop construct evaluated until its `terminateWhen` condition is satisfied.";
            } else if (token == "state") {
                hoverText = "### Keyword: `state`\n\nDeclares a state machine or an individual state within a state machine hierarchy.";
            } else if (token == "transition") {
                hoverText = "### Keyword: `transition`\n\nDeclares a state machine transition with target state, guard condition, and action streams.";
            } else if (token == "platformModule") {
                hoverText = "### Keyword: `platformModule`\n\nLow-level native code or LLVM IR template binding.";
            } else if (it->second.tree) {
                ScopeStack scopeStack = buildScopeStackForPosition(it->second.tree, line + 1);
                auto decl = ASTQuery::findDeclarationByName(token, scopeStack, it->second.tree);
                auto portForBlock = findPortForBlockInScopeStack(scopeStack, it->second.tree, token);

                if (decl || portForBlock) {
                    std::ostringstream md;
                    md << "```stride\n";
                    if (decl) {
                        md << decl->getType() << " " << decl->getName();
                    } else if (portForBlock) {
                        md << "signal / field " << token;
                    }
                    md << "\n```\n";

                    if (portForBlock) {
                        md << "- **Associated Port**: `" << portForBlock->getName() << "` (`" << portForBlock->getType() << "`)\n";
                        std::string portMeta = extractMetaDoc(portForBlock);
                        if (!portMeta.empty()) {
                            md << "\n---\n*" << portMeta << "*\n\n";
                        }
                    }

                    if (decl) {
                        std::string meta = extractMetaDoc(decl);
                        if (!meta.empty() && (!portForBlock || extractMetaDoc(portForBlock) != meta)) {
                            md << "\n---\n*" << meta << "*\n\n";
                        }

                        auto props = decl->getProperties();
                        if (!props.empty()) {
                            md << "#### Properties:\n";
                            for (const auto &p : props) {
                                if (p && p->getName() != "meta") {
                                    md << "- `" << p->getName() << "`\n";
                                }
                            }
                        }
                    }

                    hoverText = md.str();
                }
            }
        }
    }


    std::ostringstream json;
    json << "{\"jsonrpc\":\"2.0\",\"id\":" << id << ",\"result\":";
    if (hoverText.empty()) {
        json << "null";
    } else {
        json << "{\"contents\":{\"kind\":\"markdown\",\"value\":\"" << escapeJson(hoverText) << "\"}}";
    }
    json << "}";
    sendLspResponse(json.str());
}

std::string renderDocumentSymbol(ASTNode node) {
    if (!node) return "";
    auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
    if (!decl || decl->getName().empty()) return "";

    int symbolKind = 13; // Variable default
    std::string type = decl->getType();
    if (type == "module" || type == "reaction" || type == "loop") {
        symbolKind = 6; // Method / Function
    } else if (type == "state" || type == "transition") {
        symbolKind = 24; // Event / Struct
    } else if (type == "_domainDefinition" || type == "gameDefinition" || type == "domainDeclaration") {
        symbolKind = 5; // Class
    } else if (type.find("Port") != std::string::npos || type == "port") {
        symbolKind = 11; // Interface
    } else if (type == "signal" || type == "switch" || type == "trigger") {
        symbolKind = 13; // Variable
    }

    int startLine = (decl->getLine() > 0) ? (decl->getLine() - 1) : 0;
    int endLine = startLine;

    std::vector<std::string> childSymbolsJson;
    std::function<void(ASTNode)> findChildren = [&](ASTNode cur) {
        if (!cur) return;
        for (const auto &child : cur->getChildren()) {
            auto childDecl = std::dynamic_pointer_cast<DeclarationNode>(child);
            if (childDecl && !childDecl->getName().empty()) {
                int cLine = (childDecl->getLine() > 0) ? (childDecl->getLine() - 1) : 0;
                if (cLine > endLine) endLine = cLine;
                std::string rendered = renderDocumentSymbol(child);
                if (!rendered.empty()) {
                    childSymbolsJson.push_back(rendered);
                }
            } else {
                findChildren(child);
            }
        }
    };
    findChildren(node);

    std::ostringstream s;
    s << "{";
    s << "\"name\":\"" << escapeJson(decl->getName()) << "\",";
    s << "\"detail\":\"" << escapeJson(type) << "\",";
    s << "\"kind\":" << symbolKind << ",";
    s << "\"range\":{\"start\":{\"line\":" << startLine << ",\"character\":0},\"end\":{\"line\":" << endLine << ",\"character\":100}},";
    s << "\"selectionRange\":{\"start\":{\"line\":" << startLine << ",\"character\":0},\"end\":{\"line\":" << startLine << ",\"character\":100}}";
    if (!childSymbolsJson.empty()) {
        s << ",\"children\":[";
        for (size_t i = 0; i < childSymbolsJson.size(); i++) {
            if (i > 0) s << ",";
            s << childSymbolsJson[i];
        }
        s << "]";
    }
    s << "}";
    return s.str();
}

void handleDocumentSymbols(const std::string &id, const std::string &uri) {
    auto it = openDocuments.find(uri);
    std::vector<std::string> symbols;
    if (it != openDocuments.end() && it->second.tree) {
        for (const auto &child : it->second.tree->getChildren()) {
            auto decl = std::dynamic_pointer_cast<DeclarationNode>(child);
            if (decl && !decl->getName().empty()) {
                std::string rendered = renderDocumentSymbol(decl);
                if (!rendered.empty()) symbols.push_back(rendered);
            }
        }
    }

    std::ostringstream json;
    json << "{\"jsonrpc\":\"2.0\",\"id\":" << id << ",\"result\":[";
    for (size_t i = 0; i < symbols.size(); i++) {
        if (i > 0) json << ",";
        json << symbols[i];
    }
    json << "]}";
    sendLspResponse(json.str());
}

void handleCompletion(const std::string &id) {
    static const char *keywords[] = {
        "_domainDefinition", "gameDefinition", "module", "reaction", "loop",
        "state", "transition", "platformModule", "platformFunction", "type",
        "signal", "switch", "trigger", "mainInputPort", "mainOutputPort",
        "propertyInputPort", "propertyOutputPort", "import", "use", "version",
        "streamRate", "on", "off", "none", "_IntType", "_RealType", "_SwitchType",
        "_StateType", "default:", "reset:", "domain:", "type:", "rate:", "meta:",
        "framework:", "inputs:", "outputs:", "states:", "transitions:", "guard:", "targetState:"
    };

    std::ostringstream json;
    json << "{\"jsonrpc\":\"2.0\",\"id\":" << id << ",\"result\":{\"isIncomplete\":false,\"items\":[";
    size_t count = sizeof(keywords) / sizeof(keywords[0]);
    for (size_t i = 0; i < count; i++) {
        if (i > 0) json << ",";
        json << "{";
        json << "\"label\":\"" << keywords[i] << "\",";
        json << "\"kind\":" << (std::string(keywords[i]).find(':') != std::string::npos ? 10 : 14);
        json << "}";
    }
    json << "]}}";
    sendLspResponse(json.str());
}

void handleDefinition(const std::string &id, const std::string &uri, int line, int character) {
    auto it = openDocuments.find(uri);
    std::string result = "null";

    if (it != openDocuments.end() && it->second.tree) {
        std::string token = getWordAtPosition(it->second.text, line, character);
        if (!token.empty()) {
            ScopeStack scopeStack = buildScopeStackForPosition(it->second.tree, line + 1);
            auto decl = ASTQuery::findDeclarationByName(token, scopeStack, it->second.tree);
            if (decl) {
                int declLine = (decl->getLine() > 0) ? (decl->getLine() - 1) : 0;
                std::ostringstream r;
                r << "{";
                r << "\"uri\":\"" << escapeJson(uri) << "\",";
                r << "\"range\":{\"start\":{\"line\":" << declLine << ",\"character\":0},\"end\":{\"line\":" << declLine << ",\"character\":100}}";
                r << "}";
                result = r.str();
            }
        }
    }

    std::ostringstream json;
    json << "{\"jsonrpc\":\"2.0\",\"id\":" << id << ",\"result\":" << result << "}";
    sendLspResponse(json.str());
}

std::string unescapeJsonString(const std::string &input) {
    std::string unescaped = "";
    for (size_t i = 0; i < input.size(); i++) {
        if (input[i] == '\\' && i + 1 < input.size()) {
            char next = input[i + 1];
            if (next == 'n') { unescaped += '\n'; i++; continue; }
            if (next == 'r') { unescaped += '\r'; i++; continue; }
            if (next == 't') { unescaped += '\t'; i++; continue; }
            if (next == '"') { unescaped += '"'; i++; continue; }
            if (next == '\\') { unescaped += '\\'; i++; continue; }
            if (next == '/') { unescaped += '/'; i++; continue; }
            if (next == 'u' && i + 5 < input.size()) {
                std::string hexStr = input.substr(i + 2, 4);
                char *endPtr = nullptr;
                long code = std::strtol(hexStr.c_str(), &endPtr, 16);
                if (endPtr == hexStr.c_str() + 4) {
                    if (code <= 0x7F) {
                        unescaped += (char)code;
                    }
                    i += 5;
                    continue;
                }
            }
        }
        unescaped += input[i];
    }
    return unescaped;
}

std::string getJsonStringField(const std::string &json, const std::string &key) {
    std::string search = "\"" + key + "\":\"";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        search = "\"" + key + "\": \"";
        pos = json.find(search);
    }
    if (pos == std::string::npos) return "";
    pos += search.length();

    size_t endPos = pos;
    while (endPos < json.size()) {
        if (json[endPos] == '"') {
            size_t backslashCount = 0;
            size_t b = endPos;
            while (b > pos && json[b - 1] == '\\') {
                backslashCount++;
                b--;
            }
            if (backslashCount % 2 == 0) {
                break;
            }
        }
        endPos++;
    }
    if (endPos >= json.size()) return "";
    return json.substr(pos, endPos - pos);
}

std::string getJsonId(const std::string &json) {
    size_t pos = json.find("\"id\":");
    if (pos == std::string::npos) return "null";
    pos += 5;
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    size_t endPos = pos;
    while (endPos < json.size() && json[endPos] != ',' && json[endPos] != '}' && json[endPos] != '\r' && json[endPos] != '\n') {
        endPos++;
    }
    return json.substr(pos, endPos - pos);
}

int getJsonIntField(const std::string &json, const std::string &key) {
    std::string search = "\"" + key + "\":";
    size_t pos = json.find(search);
    if (pos == std::string::npos) {
        search = "\"" + key + "\": ";
        pos = json.find(search);
    }
    if (pos == std::string::npos) return 0;
    pos += search.length();
    while (pos < json.size() && (json[pos] == ' ' || json[pos] == '\t')) pos++;
    return std::atoi(json.c_str() + pos);
}

} // anonymous namespace

int main(int argc, char **argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    initLibrary();

    while (std::cin.good()) {
        std::string headerLine;
        int contentLength = 0;

        while (std::getline(std::cin, headerLine)) {
            if (!headerLine.empty() && headerLine.back() == '\r') {
                headerLine.pop_back();
            }
            if (headerLine.empty()) {
                break;
            }
            if (headerLine.rfind("Content-Length:", 0) == 0) {
                contentLength = std::atoi(headerLine.substr(15).c_str());
            }
        }

        if (contentLength <= 0) {
            continue;
        }

        std::vector<char> buffer(contentLength);
        std::cin.read(buffer.data(), contentLength);
        std::string message(buffer.data(), contentLength);

        std::string method = getJsonStringField(message, "method");
        std::string id = getJsonId(message);

        if (method == "initialize") {
            std::string initResponse =
                "{\"jsonrpc\":\"2.0\",\"id\":" + id +
                ",\"result\":{\"capabilities\":{"
                "\"textDocumentSync\":1,"
                "\"hoverProvider\":true,"
                "\"documentSymbolProvider\":true,"
                "\"completionProvider\":{\"triggerCharacters\":[\".\",\":\",\">\",\"@\",\"[\"]},"
                "\"definitionProvider\":true"
                "}}}";
            sendLspResponse(initResponse);
        } else if (method == "initialized") {
        } else if (method == "textDocument/didOpen") {
            std::string uri = getJsonStringField(message, "uri");
            std::string text = getJsonStringField(message, "text");
            DocumentState doc;
            doc.uri = uri;
            doc.text = unescapeJsonString(text);
            analyzeDocument(doc);
            openDocuments[uri] = doc;
        } else if (method == "textDocument/didChange") {
            std::string uri = getJsonStringField(message, "uri");
            std::string text = getJsonStringField(message, "text");
            DocumentState doc;
            doc.uri = uri;
            doc.text = unescapeJsonString(text);
            analyzeDocument(doc);
            openDocuments[uri] = doc;
        } else if (method == "textDocument/didSave") {
            std::string uri = getJsonStringField(message, "uri");
            auto it = openDocuments.find(uri);
            if (it != openDocuments.end()) {
                analyzeDocument(it->second);
            }
        } else if (method == "textDocument/didClose") {
            std::string uri = getJsonStringField(message, "uri");
            openDocuments.erase(uri);
        } else if (method == "textDocument/hover") {
            std::string uri = getJsonStringField(message, "uri");
            int line = getJsonIntField(message, "line");
            int character = getJsonIntField(message, "character");
            handleHover(id, uri, line, character);
        } else if (method == "textDocument/documentSymbol") {
            std::string uri = getJsonStringField(message, "uri");
            handleDocumentSymbols(id, uri);
        } else if (method == "textDocument/completion") {
            handleCompletion(id);
        } else if (method == "textDocument/definition") {
            std::string uri = getJsonStringField(message, "uri");
            int line = getJsonIntField(message, "line");
            int character = getJsonIntField(message, "character");
            handleDefinition(id, uri, line, character);
        } else if (method == "shutdown") {
            sendLspResponse("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":null}");
        } else if (method == "exit") {
            break;
        }
    }

    return 0;
}
