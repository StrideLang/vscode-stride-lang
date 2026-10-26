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
#include <unordered_set>
#include <regex>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <io.h>
#include <fcntl.h>
#include <windows.h>
#ifdef ERROR
#undef ERROR
#endif
#else
#include <unistd.h>
#endif

#include "stride/parser/strideparser.h"
#include "stride/stridegen/codeanalysis.hpp"
#include "stride/stridegen/coderesolver.hpp"
#include "stride/stridegen/codevalidator.hpp"
#include "stride/stridegen/stridesystem.hpp"
#include "stride/parser/platformnode.h"
#include "stride/utils/astfunctions.h"
#include "stride/utils/astquery.h"
#include "stride/utils/astvalidation.h"
#include "stride/utils/logger.h"
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

static std::streambuf *g_realStdoutBuf = nullptr;

void sendLspResponse(const std::string &jsonPayload) {
    if (g_realStdoutBuf) {
        std::ostream realOut(g_realStdoutBuf);
        realOut << "Content-Length: " << jsonPayload.length() << "\r\n\r\n" << jsonPayload;
        realOut.flush();
    } else {
        std::cout << "Content-Length: " << jsonPayload.length() << "\r\n\r\n" << jsonPayload;
        std::cout.flush();
    }
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
    ASTNode importedTree{nullptr};
    std::vector<LangError> errors;
};

std::map<std::string, DocumentState> openDocuments;
extern std::string g_strideRoot;
std::map<std::string, ASTNode> g_importCache;

void loadImportsForDocument(const std::string &docUri, ASTNode docTree, ASTNode importedTree) {
    if (!docTree || !importedTree) return;
    std::string currentPath = uriToPath(docUri);
    std::filesystem::path currentFilePath(currentPath);
    std::filesystem::path currentDir = currentFilePath.parent_path();

    std::vector<std::filesystem::path> searchDirs;
    if (!currentDir.empty() && std::filesystem::exists(currentDir)) {
        searchDirs.push_back(currentDir);
    }
    if (!g_strideRoot.empty()) {
        searchDirs.push_back(std::filesystem::path(g_strideRoot));
        searchDirs.push_back(std::filesystem::path(g_strideRoot) / "library" / "1.0");
    }

    std::unordered_set<std::string> visited;
    std::vector<std::string> queue;

    for (const auto &child : docTree->getChildren()) {
        if (child->getNodeType() == AST::Import) {
            auto imp = std::static_pointer_cast<ImportNode>(child);
            queue.push_back(imp->importName());
        }
    }

    while (!queue.empty()) {
        std::string impName = queue.back();
        queue.pop_back();

        if (visited.count(impName)) continue;
        visited.insert(impName);

        std::filesystem::path foundPath;
        for (const auto &dir : searchDirs) {
            std::filesystem::path cand = dir / (impName + ".stride");
            if (std::filesystem::exists(cand) && std::filesystem::is_regular_file(cand)) {
                foundPath = cand;
                break;
            }
        }

        if (foundPath.empty()) continue;

        std::error_code ec;
        std::string pathKey = std::filesystem::canonical(foundPath, ec).string();
        if (ec) pathKey = foundPath.string();

        ASTNode impTree = nullptr;
        auto itCache = g_importCache.find(pathKey);
        if (itCache != g_importCache.end()) {
            impTree = itCache->second;
        } else {
            impTree = AST::parseFile(foundPath.string().c_str(), foundPath.string().c_str());
            if (impTree) {
                g_importCache[pathKey] = impTree;
            }
        }

        if (impTree) {
            for (const auto &child : impTree->getChildren()) {
                if (child->getNodeType() == AST::Declaration || child->getNodeType() == AST::ArrayDeclaration) {
                    importedTree->addChild(child);
                } else if (child->getNodeType() == AST::Import) {
                    auto subImp = std::static_pointer_cast<ImportNode>(child);
                    if (!visited.count(subImp->importName())) {
                        queue.push_back(subImp->importName());
                    }
                }
            }
        }
    }
}

std::string extractMetaDoc(ASTNode node) {
    if (!node) return "";
    auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
    if (!decl) return "";
    auto metaVal = decl->getPropertyValue("meta");
    if (metaVal) {
        auto valNode = std::dynamic_pointer_cast<ValueNode>(metaVal);
        if (valNode && valNode->getNodeType() == AST::String) {
            return valNode->getStringValue();
        }
    }
    return "";
}

struct TokenAtPosition {
    std::string token;
    bool followedByColon = false;
};

TokenAtPosition getTokenAtPosition(const std::string &content, int line, int character) {
    std::istringstream stream(content);
    std::string lineStr;
    int curLine = 0;
    while (std::getline(stream, lineStr)) {
        if (!lineStr.empty() && lineStr.back() == '\r') {
            lineStr.pop_back();
        }
        if (curLine == line) {
            if (character < 0 || character >= (int)lineStr.size()) {
                if (character == (int)lineStr.size() && !lineStr.empty()) {
                    character = (int)lineStr.size() - 1;
                } else {
                    return {};
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
                TokenAtPosition res;
                res.token = lineStr.substr(start, end - start);
                int after = end;
                while (after < (int)lineStr.size() && (lineStr[after] == ' ' || lineStr[after] == '\t')) {
                    after++;
                }
                if (after < (int)lineStr.size() && lineStr[after] == ':') {
                    res.followedByColon = true;
                }
                return res;
            }
            return {};
        }
        curLine++;
    }
    return {};
}

std::string getWordAtPosition(const std::string &content, int line, int character) {
    return getTokenAtPosition(content, line, character).token;
}

ScopeStack buildScopeStackForPosition(ASTNode root, int targetLine) {
    ScopeStack stack;
    if (!root) return stack;

    std::function<void(ASTNode)> traverse = [&](ASTNode node) {
        if (!node) return;
        auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
        if (decl) {
            std::string objType = decl->getEntityType();
            if (objType == "module" || objType == "reaction" || objType == "loop" ||
                objType == "_domainDefinition" || objType == "gameDefinition" ||
                objType == "domainDeclaration" || objType == "state") {
                
                std::vector<ASTNode> localBlocks = ASTQuery::getModuleEntities(decl);
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
                std::string type = decl->getEntityType();
                if (type.find("Port") != std::string::npos || type == "port") {
                    auto blockVal = decl->getPropertyValue("block");
                    if (blockVal) {
                        auto entNode = std::dynamic_pointer_cast<EntityNode>(blockVal);
                        if (entNode && entNode->getName() == blockName) return decl;
                        auto valNode = std::dynamic_pointer_cast<ValueNode>(blockVal);
                        if (valNode && valNode->getNodeType() == AST::String && valNode->getStringValue() == blockName) return decl;
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
std::string g_strideRoot;

std::string findStrideRoot(const std::string &explicitRoot = "") {
    if (!explicitRoot.empty() && std::filesystem::exists(explicitRoot)) return explicitRoot;

    const char *envRoot = std::getenv("STRIDEROOT");
    if (envRoot && std::filesystem::exists(envRoot)) return std::string(envRoot);
    
    std::vector<std::string> candidates = {
        "strideroot",
        "./strideroot"
    };
    for (const auto &c : candidates) {
        if (std::filesystem::exists(c)) return c;
    }
    return "";
}

void initLibrary(const std::string &explicitRoot = "") {
    std::string sRoot = findStrideRoot(explicitRoot);
    g_strideRoot = sRoot;
    if (!sRoot.empty()) {
        try {
            g_library.initializeLibrary(sRoot);
            g_libraryRootTree = std::make_shared<AST>();
            auto members = g_library.getLibraryMembers();
            for (const auto &pair : members) {
                for (const auto &node : pair.second) {
                    g_libraryRootTree->addChild(node);
                    if (node->getNodeType() == AST::Package) {
                        for (const auto &pkgChild : node->getChildren()) {
                            g_libraryRootTree->addChild(pkgChild);
                        }
                    }
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

    // Split document lines once for all errors
    std::vector<std::string> docLines;
    {
        std::istringstream stream(docText);
        std::string l;
        while (std::getline(stream, l)) {
            docLines.push_back(l);
        }
    }

    for (size_t i = 0; i < errors.size(); i++) {
        auto err = errors[i];
        int line = (err.lineNumber > 0) ? (err.lineNumber - 1) : 0;
        int startChar = 0;
        int endChar = 100;

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
        } else if (err.type == LangError::LossyConversion) {
            // Tokens are type names and a reason. Mark the whole stream line.
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
        // 1 = Error, 2 = Warning
        json << "\"severity\":" << (err.severity == LangError::Warning ? 2 : 1) << ",";
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

#if defined(_MSC_VER)
static bool safeResolveProcess(CodeResolver *resolver) {
    __try {
        resolver->process();
        return true;
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return false;
    }
}
#else
static bool safeResolveProcess(CodeResolver *resolver) {
    try {
        resolver->process();
        return true;
    } catch (...) {
        return false;
    }
}
#endif

void analyzeDocument(DocumentState &doc) {
    std::string currentPath = uriToPath(doc.uri);
    std::filesystem::path currentFilePath(currentPath);
    std::filesystem::path currentDir = currentFilePath.parent_path();
    std::vector<std::string> importPaths;
    if (!currentDir.empty() && std::filesystem::exists(currentDir)) {
        importPaths.push_back(currentDir.string());
    }

    std::string tempFile = getTempFilePath();
    {
        std::ofstream out(tempFile, std::ios::binary);
        out << doc.text;
    }

    doc.errors.clear();
    doc.tree = AST::parseFile(tempFile.c_str(), currentPath.c_str());
    if (doc.tree) {
        doc.importedTree = std::make_shared<AST>();
        loadImportsForDocument(doc.uri, doc.tree, doc.importedTree);

        // Build combined tree with standard library, imported library, and document symbols
        ASTNode combinedTree = std::make_shared<AST>();
        if (g_libraryRootTree) {
            for (const auto &libChild : g_libraryRootTree->getChildren()) {
                combinedTree->addChild(libChild);
            }
        }
        if (doc.importedTree) {
            for (const auto &impChild : doc.importedTree->getChildren()) {
                combinedTree->addChild(impChild);
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

        // 2. Validate shadowing and data types
        try {
            std::vector<LangError> otherErrors;
            ASTValidation::validateShadowing(combinedTree, otherErrors);
            ASTValidation::validateDataTypes(combinedTree, otherErrors);
            for (const auto &err : otherErrors) {
                if (err.filename.empty() || err.filename == tempFile ||
                    err.filename == doc.uri || err.filename == currentPath) {
                    doc.errors.push_back(err);
                }
            }
        } catch (...) {
            // Safety catch
        }

        // 3. Warn about conversions that can lose data. They are only known
        // after resolving data types, which changes the tree, so a copy is
        // resolved. Only run resolver if the document has no fatal syntax errors.
        if (!g_strideRoot.empty() && doc.errors.empty()) {
            try {
                ASTNode resolved = AST::parseFile(tempFile.c_str(), currentPath.c_str());
                if (resolved) {
                    ASTFunctions::preprocess(resolved, nullptr, importPaths, g_strideRoot);
                    CodeResolver resolver(resolved, g_strideRoot);
                    if (safeResolveProcess(&resolver)) {
                        for (const auto &warning :
                             CodeValidator::findLossyConversions(resolved)) {
                            if (warning.filename == tempFile ||
                                warning.filename == doc.uri ||
                                warning.filename.empty() ||
                                warning.filename == currentPath) {
                                doc.errors.push_back(warning);
                            }
                        }
                    }
                }
            } catch (...) {
                // Resolver safety catch
            }
        }
    } else {
        auto parseErrors = AST::getParseErrors();
        doc.errors.insert(doc.errors.end(), parseErrors.begin(), parseErrors.end());
    }

    std::remove(tempFile.c_str());
    publishDiagnostics(doc.uri, doc.errors, doc.text);
}

bool isPositionInStringOrComment(const std::string &text, int targetLine, int targetChar) {
    int curLine = 0;
    int curChar = 0;
    bool inComment = false;
    char inString = 0;
    bool escape = false;

    for (size_t i = 0; i < text.size(); i++) {
        char c = text[i];
        if (curLine == targetLine && curChar == targetChar) {
            return (inComment || inString != 0 || c == '"' || c == '\'' || c == '#');
        }

        if (inComment) {
            if (c == '\n') {
                inComment = false;
                curLine++;
                curChar = 0;
            } else {
                curChar++;
            }
            continue;
        }

        if (inString != 0) {
            if (escape) {
                escape = false;
            } else if (c == '\\') {
                escape = true;
            } else if (c == inString) {
                inString = 0;
            }
            if (c == '\n') {
                curLine++;
                curChar = 0;
            } else {
                curChar++;
            }
            continue;
        }

        if (c == '#') {
            inComment = true;
            curChar++;
        } else if (c == '"' || c == '\'') {
            inString = c;
            curChar++;
        } else if (c == '\n') {
            curLine++;
            curChar = 0;
        } else {
            curChar++;
        }
    }
    return (inComment || inString != 0);
}

std::shared_ptr<DeclarationNode> findSymbolOrType(const std::string &token, const ScopeStack &scopeStack, ASTNode docTree, ASTNode importedTree = nullptr) {
    std::shared_ptr<DeclarationNode> decl = nullptr;
    if (docTree) {
        decl = ASTQuery::findDeclarationByName(token, scopeStack, docTree);
        if (!decl) decl = ASTQuery::findTypeDeclarationByName(token, scopeStack, docTree);
    }
    if (!decl && importedTree) {
        decl = ASTQuery::findDeclarationByName(token, {}, importedTree);
        if (!decl) decl = ASTQuery::findTypeDeclarationByName(token, {}, importedTree);
    }
    if (!decl && g_libraryRootTree) {
        decl = ASTQuery::findDeclarationByName(token, {}, g_libraryRootTree);
        if (!decl) decl = ASTQuery::findTypeDeclarationByName(token, {}, g_libraryRootTree);
    }
    if (!decl) {
        decl = g_library.findTypeInLibrary(token);
    }

    if (!decl) {
        static const std::unordered_map<std::string, std::string> ALIASES = {
            {"constant", "_Constant"}, {"_Constant", "_Constant"},
            {"module", "_Module"}, {"_Module", "_Module"},
            {"reaction", "_Reaction"}, {"_Reaction", "_Reaction"},
            {"loop", "_Loop"}, {"_Loop", "_Loop"},
            {"state", "_StateType"}, {"_StateType", "_StateType"},
            {"transition", "_TransitionType"}, {"_TransitionType", "_TransitionType"},
            {"signal", "_Signal"}, {"_Signal", "_Signal"},
            {"port", "_Port"}, {"_Port", "_Port"},
            {"switch", "_Switch"}, {"_Switch", "_Switch"},
            {"gameDefinition", "_GameDefinitionType"},
            {"playerType", "_PlayerTypeType"},
            {"supply", "_SupplyType"},
            {"entityType", "_EntityTypeType"},
            {"board", "_BoardType"},
            {"boardSection", "_BoardSectionType"},
            {"action", "_ActionType"},
            {"dict", "_DictionaryType"}
        };
        auto aIt = ALIASES.find(token);
        if (aIt != ALIASES.end()) {
            std::string alias = aIt->second;
            if (docTree) {
                decl = ASTQuery::findDeclarationByName(alias, scopeStack, docTree);
                if (!decl) decl = ASTQuery::findTypeDeclarationByName(alias, scopeStack, docTree);
            }
            if (!decl && importedTree) {
                decl = ASTQuery::findDeclarationByName(alias, {}, importedTree);
                if (!decl) decl = ASTQuery::findTypeDeclarationByName(alias, {}, importedTree);
            }
            if (!decl && g_libraryRootTree) {
                decl = ASTQuery::findDeclarationByName(alias, {}, g_libraryRootTree);
                if (!decl) decl = ASTQuery::findTypeDeclarationByName(alias, {}, g_libraryRootTree);
            }
            if (!decl) decl = g_library.findTypeInLibrary(alias);
        }
    }

    if (!decl) {
        // Generic scan for typeName: "token" in doc, imported, and library trees
        auto matchTypeNameInTree = [&](ASTNode tree) -> std::shared_ptr<DeclarationNode> {
            if (!tree) return nullptr;
            for (const auto &node : tree->getChildren()) {
                if (node->getNodeType() == AST::Declaration) {
                    auto d = std::static_pointer_cast<DeclarationNode>(node);
                    ASTNode tn = d->getPropertyValue("typeName");
                    if (tn && tn->getNodeType() == AST::String) {
                        if (std::static_pointer_cast<ValueNode>(tn)->getStringValue() == token) {
                            return d;
                        }
                    }
                }
            }
            return nullptr;
        };
        if (docTree) decl = matchTypeNameInTree(docTree);
        if (!decl && importedTree) decl = matchTypeNameInTree(importedTree);
        if (!decl && g_libraryRootTree) decl = matchTypeNameInTree(g_libraryRootTree);
    }
    return decl;
}

std::string formatAllowedTypes(ASTNode allowedNode) {
    if (!allowedNode) return "";
    if (allowedNode->getNodeType() == AST::Declaration) {
        auto decl = std::static_pointer_cast<DeclarationNode>(allowedNode);
        std::string entityType = decl->getEntityType();
        if (entityType == "constrainedEntity" || entityType == "constrainedList") {
            auto allowedProps = decl->getPropertyValue("allowed");
            if (allowedProps) {
                std::string inner = formatAllowedTypes(allowedProps);
                if (entityType == "constrainedList") {
                    return "List of [" + inner + "]";
                }
                return inner;
            }
        } else if (entityType == "constrainedInt") {
            std::string res = "int";
            auto minVal = decl->getPropertyValue("minimum");
            auto maxVal = decl->getPropertyValue("maximum");
            if (minVal || maxVal) {
                res += " (";
                if (minVal) res += "min: " + minVal->toText(0, 0, false);
                if (minVal && maxVal) res += ", ";
                if (maxVal) res += "max: " + maxVal->toText(0, 0, false);
                res += ")";
            }
            return res;
        } else if (entityType == "constrainedReal") {
            std::string res = "real";
            auto minVal = decl->getPropertyValue("minimum");
            auto maxVal = decl->getPropertyValue("maximum");
            if (minVal || maxVal) {
                res += " (";
                if (minVal) res += "min: " + minVal->toText(0, 0, false);
                if (minVal && maxVal) res += ", ";
                if (maxVal) res += "max: " + maxVal->toText(0, 0, false);
                res += ")";
            }
            return res;
        } else if (entityType == "constrainedString") {
            return "string";
        }
    } else if (allowedNode->getNodeType() == AST::List) {
        std::string res;
        for (const auto &child : allowedNode->getChildren()) {
            std::string item = formatAllowedTypes(child);
            if (!item.empty()) {
                if (!res.empty()) res += ", ";
                res += item;
            }
        }
        return res;
    } else if (allowedNode->getNodeType() == AST::Entity) {
        return std::static_pointer_cast<EntityNode>(allowedNode)->getName();
    }
    std::string text = allowedNode->toText(0, 0, false);
    for (char &c : text) { if (c == '\n' || c == '\r' || c == '\t') c = ' '; }
    while (text.find("  ") != std::string::npos) {
        text.replace(text.find("  "), 2, " ");
    }
    return text;
}

std::string renderDeclarationHover(std::shared_ptr<DeclarationNode> decl, const std::string &token, const std::string &docUri) {
    if (!decl) return "";
    std::ostringstream md;

    std::string declName = decl->getName();
    std::string entityType = decl->getEntityType();
    bool isArray = (decl->getNodeType() == AST::ArrayDeclaration);
    std::shared_ptr<ArrayNode> arrNode = nullptr;
    if (isArray) {
        arrNode = decl->getArrayIndex();
    }
    std::string arrayDims = "";
    size_t totalElements = 0;
    if (arrNode) {
        std::vector<size_t> indices = arrNode->getIndices();
        if (!indices.empty()) {
            arrayDims = "[";
            totalElements = 1;
            for (size_t i = 0; i < indices.size(); i++) {
                if (i > 0) arrayDims += ", ";
                arrayDims += std::to_string(indices[i]);
                totalElements *= indices[i];
            }
            arrayDims += "]";
        } else if (arrNode->index() && !arrNode->index()->getChildren().empty()) {
            arrayDims = "[";
            const auto &elems = arrNode->index()->getChildren();
            for (size_t i = 0; i < elems.size(); i++) {
                if (i > 0) arrayDims += ", ";
                arrayDims += elems[i]->toText(0, 0, false);
            }
            arrayDims += "]";
        }
    }
    
    ASTNode typeNameVal = decl->getPropertyValue("typeName");
    std::string typeNameStr = "";
    if (typeNameVal && typeNameVal->getNodeType() == AST::String) {
        typeNameStr = std::static_pointer_cast<ValueNode>(typeNameVal)->getStringValue();
    }

    md << "```stride\n";
    if (entityType == "constant" && isArray) {
        md << "constant array " << declName << arrayDims;
    } else if (isArray) {
        md << entityType << " array " << declName << arrayDims;
    } else if (entityType == "type") {
        md << "type " << declName;
        if (!typeNameStr.empty() && typeNameStr != declName) {
            md << " (typeName: \"" << typeNameStr << "\")";
        }
    } else if (entityType == "frameworkDataType") {
        md << "frameworkDataType " << declName;
    } else if (entityType == "alias") {
        md << "alias " << declName;
    } else if (entityType == "typeClass") {
        md << "typeClass " << declName;
    } else {
        md << entityType << " " << declName;
    }
    md << "\n```\n";

    // Detailed metadata for constant array or scalar constant
    if (entityType == "constant" && isArray) {
        md << "- **Kind**: `constant array`\n";
        if (!arrayDims.empty()) {
            md << "- **Dimensions**: `" << arrayDims << "`";
            if (totalElements > 0) {
                md << " (" << totalElements << " elements)";
            }
            md << "\n";
        }
        ASTNode valNode = decl->getPropertyValue("value");
        if (valNode && valNode->getNodeType() == AST::List) {
            size_t count = valNode->getChildren().size();
            std::string valPreview = "[ ";
            size_t previewLimit = std::min(count, (size_t)8);
            for (size_t i = 0; i < previewLimit; i++) {
                if (i > 0) valPreview += ", ";
                valPreview += valNode->getChildren()[i]->toText(0, 0, false);
            }
            if (count > previewLimit) {
                valPreview += ", ... (" + std::to_string(count) + " items) ";
            } else {
                valPreview += " ";
            }
            valPreview += "]";
            md << "- **Elements (" << count << ")**: `" << valPreview << "`\n";
        }
        md << "\n";
    } else if (entityType == "constant" && !isArray) {
        md << "- **Kind**: `constant`\n";
        ASTNode valNode = decl->getPropertyValue("value");
        if (valNode) {
            md << "- **Value**: `" << valNode->toText(0, 0, false) << "`\n";
        }
        md << "\n";
    }

    // Meta documentation
    std::string meta = extractMetaDoc(decl);
    if (!meta.empty()) {
        md << "*" << meta << "*\n\n";
    }

    // Special handling for alias (show target entity)
    if (entityType == "alias") {
        ASTNode entityVal = decl->getPropertyValue("entity");
        if (entityVal) {
            md << "- **Target Entity / Type**: `" << entityVal->toText(0, 0, false) << "`\n\n";
        }
    }

    // Special handling for frameworkDataType (show kind and bits)
    if (entityType == "frameworkDataType") {
        ASTNode kindVal = decl->getPropertyValue("kind");
        ASTNode bitsVal = decl->getPropertyValue("bits");
        if (kindVal) {
            md << "- **Kind**: `" << kindVal->toText(0, 0, false) << "`\n";
        }
        if (bitsVal) {
            md << "- **Bit Size**: `" << bitsVal->toText(0, 0, false) << "`\n";
        }
        md << "\n";
    }

    // Special handling for typeClass (show allowed member types)
    if (entityType == "typeClass") {
        ASTNode typesVal = decl->getPropertyValue("types");
        if (typesVal) {
            md << "- **Allowed Types**: `" << typesVal->toText(0, 0, false) << "`\n\n";
        }
    }

    // Special handling for typeProperty / property (show allowed types, default, required)
    if (entityType == "typeProperty" || entityType == "property") {
        ASTNode allowedVal = decl->getPropertyValue("allowedTypes");
        if (!allowedVal) allowedVal = decl->getPropertyValue("types");
        if (!allowedVal) allowedVal = decl->getPropertyValue("type");
        if (allowedVal) {
            std::string typesStr = formatAllowedTypes(allowedVal);
            if (!typesStr.empty()) {
                md << "- **Allowed Types**: `" << typesStr << "`\n";
            }
        }
        ASTNode reqVal = decl->getPropertyValue("required");
        if (reqVal) {
            std::string reqStr = reqVal->toText(0, 0, false);
            for (char &c : reqStr) c = tolower(c);
            bool isReq = (reqStr.find("on") != std::string::npos || reqStr.find("true") != std::string::npos);
            md << "- **Required**: `" << (isReq ? "on (true)" : "off (false)") << "`\n";
        }
        ASTNode defVal = decl->getPropertyValue("default");
        if (defVal && defVal->getNodeType() != AST::None) {
            std::string defStr = defVal->toText(0, 0, false);
            md << "- **Default**: `" << defStr << "`\n";
        }
        md << "\n";
    }

    // Inherits
    ASTNode inheritsVal = decl->getPropertyValue("inherits");
    std::vector<std::string> inheritsList;
    if (inheritsVal && inheritsVal->getNodeType() == AST::List) {
        for (const auto &inhChild : inheritsVal->getChildren()) {
            if (inhChild->getNodeType() == AST::Entity) {
                inheritsList.push_back(std::static_pointer_cast<EntityNode>(inhChild)->getName());
            } else if (inhChild->getNodeType() == AST::String) {
                inheritsList.push_back(std::static_pointer_cast<ValueNode>(inhChild)->getStringValue());
            }
        }
    }
    if (!inheritsList.empty()) {
        md << "**Inherits from**: ";
        for (size_t i = 0; i < inheritsList.size(); i++) {
            if (i > 0) md << ", ";
            md << "`" << inheritsList[i] << "`";
        }
        md << "\n\n";
    }

    auto renderPropItem = [](std::shared_ptr<DeclarationNode> propDecl) -> std::string {
        std::ostringstream pm;
        std::string pName = propDecl->getName();
        ASTNode nameVal = propDecl->getPropertyValue("name");
        if (nameVal && nameVal->getNodeType() == AST::String) {
            pName = std::static_pointer_cast<ValueNode>(nameVal)->getStringValue();
        }
        pm << "- `" << pName << ":`";

        ASTNode allowedVal = propDecl->getPropertyValue("allowedTypes");
        if (!allowedVal) allowedVal = propDecl->getPropertyValue("types");
        if (!allowedVal) allowedVal = propDecl->getPropertyValue("type");
        if (allowedVal) {
            std::string tText = formatAllowedTypes(allowedVal);
            if (!tText.empty()) {
                pm << " `" << tText << "`";
            }
        }

        ASTNode reqVal = propDecl->getPropertyValue("required");
        if (reqVal) {
            std::string reqStr = reqVal->toText(0, 0, false);
            for (char &c : reqStr) c = tolower(c);
            if (reqStr.find("on") != std::string::npos || reqStr.find("true") != std::string::npos) {
                pm << " *(required)*";
            }
        }

        ASTNode defVal = propDecl->getPropertyValue("default");
        if (defVal && defVal->getNodeType() != AST::None) {
            std::string defStr = defVal->toText(0, 0, false);
            pm << " *(default: " << defStr << ")*";
        }

        std::string pMeta = extractMetaDoc(propDecl);
        if (!pMeta.empty()) {
            pm << "\n  *" << pMeta << "*";
        }
        pm << "\n";
        return pm.str();
    };

    // Properties declared on this type
    ASTNode propsVal = decl->getPropertyValue("properties");
    std::vector<std::shared_ptr<DeclarationNode>> declaredProps;
    if (propsVal && propsVal->getNodeType() == AST::List) {
        for (const auto &pChild : propsVal->getChildren()) {
            if (pChild->getNodeType() == AST::Declaration) {
                declaredProps.push_back(std::static_pointer_cast<DeclarationNode>(pChild));
            }
        }
    }

    if (!declaredProps.empty()) {
        md << "#### Allowed Properties:\n";
        for (const auto &p : declaredProps) {
            md << renderPropItem(p);
        }
        md << "\n";
    }

    // Inherited Properties
    if (!inheritsList.empty()) {
        bool renderedInheritedHeader = false;
        for (const auto &parentName : inheritsList) {
            std::shared_ptr<DeclarationNode> parentDecl = nullptr;
            if (g_libraryRootTree) {
                parentDecl = ASTQuery::findDeclarationByName(parentName, {}, g_libraryRootTree);
            }
            if (!parentDecl) {
                parentDecl = g_library.findTypeInLibrary(parentName);
            }
            if (parentDecl) {
                ASTNode parentPropsVal = parentDecl->getPropertyValue("properties");
                if (parentPropsVal && parentPropsVal->getNodeType() == AST::List && !parentPropsVal->getChildren().empty()) {
                    if (!renderedInheritedHeader) {
                        md << "#### Inherited Properties:\n";
                        renderedInheritedHeader = true;
                    }
                    md << "**From `" << parentName << "`**:\n";
                    for (const auto &pChild : parentPropsVal->getChildren()) {
                        if (pChild->getNodeType() == AST::Declaration) {
                            md << renderPropItem(std::static_pointer_cast<DeclarationNode>(pChild));
                        }
                    }
                    md << "\n";
                }
            }
        }
    }

    // Regular properties (for module/signal/etc.) if not a schema type
    if (entityType != "type" && declaredProps.empty()) {
        auto regularProps = decl->getProperties();
        if (!regularProps.empty()) {
            md << "#### Properties:\n";
            for (const auto &p : regularProps) {
                if (p && p->getName() != "meta") {
                    md << "- `" << p->getName() << "`\n";
                }
            }
            md << "\n";
        }
    }

    // Source file link
    if (!decl->getFilename().empty() && decl->getFilename() != docUri && decl->getFilename() != uriToPath(docUri)) {
        std::error_code ec;
        std::filesystem::path p = std::filesystem::absolute(decl->getFilename(), ec);
        if (ec) p = std::filesystem::path(decl->getFilename());
        md << "📍 *Defined in " << p.filename().string() << "*\n";
    }

    return md.str();
}

struct EnclosingDeclarationInfo {
    std::string kind;
    std::string name;
    bool isFunctionCall = false;
    std::string functionName;
    std::string arraySpec;
    bool isArray = false;
};

EnclosingDeclarationInfo getEnclosingDeclarationInfo(const std::string &docText, int line, int character, ASTNode docTree) {
    EnclosingDeclarationInfo res;

    // 1. Check if inside function/action call on current line
    std::istringstream lStream(docText);
    std::string lineStr;
    int curL = 0;
    std::string beforeCursor = "";
    while (std::getline(lStream, lineStr)) {
        if (!lineStr.empty() && lineStr.back() == '\r') lineStr.pop_back();
        if (curL == line) {
            int endPos = std::min((int)lineStr.size(), std::max(0, character));
            beforeCursor = lineStr.substr(0, endPos);
            break;
        }
        curL++;
    }

    int parenDepth = 0;
    int lastOpenParen = -1;
    for (int i = 0; i < (int)beforeCursor.size(); i++) {
        if (beforeCursor[i] == '(') {
            parenDepth++;
            lastOpenParen = i;
        } else if (beforeCursor[i] == ')') {
            if (parenDepth > 0) parenDepth--;
        }
    }

    if (parenDepth > 0 && lastOpenParen >= 0) {
        int p = lastOpenParen - 1;
        while (p >= 0 && (beforeCursor[p] == ' ' || beforeCursor[p] == '\t' || beforeCursor[p] == ']')) {
            if (beforeCursor[p] == ']') {
                while (p >= 0 && beforeCursor[p] != '[') p--;
                p--;
            } else {
                p--;
            }
        }
        int endName = p + 1;
        while (p >= 0 && (isalnum((unsigned char)beforeCursor[p]) || beforeCursor[p] == '_')) {
            p--;
        }
        int startName = p + 1;
        if (startName < endName) {
            res.isFunctionCall = true;
            res.functionName = beforeCursor.substr(startName, endName - startName);
            return res;
        }
    }

    // 2. Find enclosing block declaration { ... }
    int targetOffset = 0;
    {
        std::istringstream stream(docText);
        std::string curL;
        int curLNum = 0;
        while (curLNum < line && std::getline(stream, curL)) {
            targetOffset += (int)curL.size() + 1;
            curLNum++;
        }
        targetOffset += character;
    }

    int bestSpan = 1e9;
    std::regex declHeaderRegex(R"(\b([_a-zA-Z0-9]+)(?:\s+([_a-zA-Z0-9]+))?(?:\s*\[([^\]]*)\])?(?:\s*@\s*[_a-zA-Z0-9]+)?\s*(?=\{))");
    auto words_begin = std::sregex_iterator(docText.begin(), docText.end(), declHeaderRegex);
    auto words_end = std::sregex_iterator();

    for (std::sregex_iterator i = words_begin; i != words_end; ++i) {
        std::smatch match = *i;
        int headerStart = (int)match.position();
        int headerEnd = headerStart + (int)match.length();

        int openCount = 1;
        int bEnd = headerEnd + 1;
        while (bEnd < (int)docText.size() && openCount > 0) {
            if (docText[bEnd] == '{') openCount++;
            else if (docText[bEnd] == '}') openCount--;
            bEnd++;
        }

        if (targetOffset >= headerEnd && targetOffset <= bEnd) {
            int span = bEnd - headerEnd;
            if (span < bestSpan) {
                bestSpan = span;
                res.kind = match[1].str();
                res.name = match[2].matched ? match[2].str() : "";
                if (match[3].matched) {
                    res.arraySpec = match[3].str();
                    res.isArray = true;
                } else {
                    res.arraySpec = "";
                    res.isArray = false;
                }
            }
        }
    }

    if (docTree) {
        int targetLine = line + 1;
        std::function<void(ASTNode)> traverse = [&](ASTNode node) {
            if (!node) return;
            auto decl = std::dynamic_pointer_cast<DeclarationNode>(node);
            if (decl) {
                int sLine = decl->getLine();
                int eLine = decl->getEndLine() > 0 ? decl->getEndLine() : sLine;
                if (sLine <= targetLine && eLine >= targetLine) {
                    int span = eLine - sLine;
                    if (span < bestSpan) {
                        bestSpan = span;
                        res.kind = decl->getEntityType();
                        res.name = decl->getName();
                        if (decl->getNodeType() == AST::ArrayDeclaration) {
                            res.isArray = true;
                        }
                    }
                }
            }
            for (const auto &child : node->getChildren()) {
                traverse(child);
            }
        };
        traverse(docTree);
    }

    return res;
}

std::string renderPropertyHover(
    const std::string &propName,
    const std::string &enclosingKind,
    const ScopeStack &scopeStack,
    ASTNode docTree,
    ASTNode importedTree,
    const std::string &docUri,
    const EnclosingDeclarationInfo &encInfo = {}
) {
    std::shared_ptr<DeclarationNode> propDecl = nullptr;
    std::string declaredInType = "";

    auto findPropInDecl = [&](std::shared_ptr<DeclarationNode> tDecl) -> std::shared_ptr<DeclarationNode> {
        if (!tDecl) return nullptr;
        ASTNode propsNode = tDecl->getPropertyValue("properties");
        if (propsNode && propsNode->getNodeType() == AST::List) {
            for (const auto &child : propsNode->getChildren()) {
                if (child->getNodeType() == AST::Declaration) {
                    auto p = std::static_pointer_cast<DeclarationNode>(child);
                    std::string pName = p->getName();
                    ASTNode nameVal = p->getPropertyValue("name");
                    if (nameVal && nameVal->getNodeType() == AST::String) {
                        pName = std::static_pointer_cast<ValueNode>(nameVal)->getStringValue();
                    }
                    if (pName == propName) {
                        return p;
                    }
                }
            }
        }
        return nullptr;
    };

    std::shared_ptr<DeclarationNode> typeDecl = nullptr;
    if (!enclosingKind.empty()) {
        typeDecl = findSymbolOrType(enclosingKind, scopeStack, docTree, importedTree);
        if (!typeDecl) typeDecl = ASTQuery::findTypeDeclarationByName(enclosingKind, scopeStack, docTree);
        if (!typeDecl && importedTree) typeDecl = ASTQuery::findTypeDeclarationByName(enclosingKind, {}, importedTree);
        if (!typeDecl && g_libraryRootTree) typeDecl = ASTQuery::findTypeDeclarationByName(enclosingKind, {}, g_libraryRootTree);
        if (!typeDecl) typeDecl = g_library.findTypeInLibrary(enclosingKind);
    }

    if (typeDecl) {
        propDecl = findPropInDecl(typeDecl);
        if (propDecl) {
            declaredInType = typeDecl->getName();
        } else {
            // BFS inherited types
            std::vector<std::string> queue;
            std::set<std::string> visited;
            auto inhVal = typeDecl->getPropertyValue("inherits");
            if (inhVal && inhVal->getNodeType() == AST::List) {
                for (const auto &inhChild : inhVal->getChildren()) {
                    if (inhChild->getNodeType() == AST::Entity) {
                        queue.push_back(std::static_pointer_cast<EntityNode>(inhChild)->getName());
                    } else if (inhChild->getNodeType() == AST::String) {
                        queue.push_back(std::static_pointer_cast<ValueNode>(inhChild)->getStringValue());
                    }
                }
            }
            while (!queue.empty()) {
                std::string pName = queue.front();
                queue.erase(queue.begin());
                if (visited.count(pName)) continue;
                visited.insert(pName);
                auto pDecl = findSymbolOrType(pName, scopeStack, docTree, importedTree);
                if (!pDecl && g_libraryRootTree) pDecl = ASTQuery::findTypeDeclarationByName(pName, {}, g_libraryRootTree);
                if (!pDecl) pDecl = g_library.findTypeInLibrary(pName);
                if (pDecl) {
                    propDecl = findPropInDecl(pDecl);
                    if (propDecl) {
                        declaredInType = pName;
                        break;
                    }
                    auto pInh = pDecl->getPropertyValue("inherits");
                    if (pInh && pInh->getNodeType() == AST::List) {
                        for (const auto &inhChild : pInh->getChildren()) {
                            if (inhChild->getNodeType() == AST::Entity) {
                                queue.push_back(std::static_pointer_cast<EntityNode>(inhChild)->getName());
                            } else if (inhChild->getNodeType() == AST::String) {
                                queue.push_back(std::static_pointer_cast<ValueNode>(inhChild)->getStringValue());
                            }
                        }
                    }
                }
            }
        }
    }

    // Search all known types if not found yet
    if (!propDecl) {
        auto searchInTree = [&](ASTNode tree) -> std::shared_ptr<DeclarationNode> {
            if (!tree) return nullptr;
            for (const auto &node : tree->getChildren()) {
                if (node->getNodeType() == AST::Declaration) {
                    auto decl = std::static_pointer_cast<DeclarationNode>(node);
                    if (decl->getEntityType() == "type") {
                        auto found = findPropInDecl(decl);
                        if (found) {
                            declaredInType = decl->getName();
                            return found;
                        }
                    }
                }
            }
            return nullptr;
        };
        if (docTree) propDecl = searchInTree(docTree);
        if (!propDecl && importedTree) propDecl = searchInTree(importedTree);
        if (!propDecl && g_libraryRootTree) propDecl = searchInTree(g_libraryRootTree);
    }

    if (propDecl) {
        std::ostringstream md;
        md << "### Property: `" << propName << "`";
        if (!enclosingKind.empty()) {
            if (enclosingKind == "constant" && encInfo.isArray) {
                md << " *(on `constant array " << encInfo.name;
                if (!encInfo.arraySpec.empty()) md << "[" << encInfo.arraySpec << "]";
                md << "`)*";
            } else {
                md << " *(on `" << enclosingKind << "`";
                if (!declaredInType.empty() && declaredInType != enclosingKind) {
                    md << " via `" << declaredInType << "`";
                }
                md << ")*";
            }
        }
        md << "\n\n";

        ASTNode allowedVal = propDecl->getPropertyValue("allowedTypes");
        if (!allowedVal) allowedVal = propDecl->getPropertyValue("types");
        if (!allowedVal) allowedVal = propDecl->getPropertyValue("type");
        if (allowedVal) {
            std::string typesStr = formatAllowedTypes(allowedVal);
            if (!typesStr.empty()) {
                md << "- **Allowed Types**: `" << typesStr << "`\n";
            }
        }

        ASTNode reqVal = propDecl->getPropertyValue("required");
        if (reqVal) {
            std::string reqStr = reqVal->toText(0, 0, false);
            for (char &c : reqStr) c = tolower(c);
            bool isReq = (reqStr.find("on") != std::string::npos || reqStr.find("true") != std::string::npos);
            md << "- **Required**: `" << (isReq ? "on (true)" : "off (false)") << "`\n";
        }

        ASTNode defVal = propDecl->getPropertyValue("default");
        if (defVal && defVal->getNodeType() != AST::None) {
            std::string defStr = defVal->toText(0, 0, false);
            md << "- **Default**: `" << defStr << "`\n";
        }

        std::string pMeta = extractMetaDoc(propDecl);
        if (!pMeta.empty()) {
            md << "\n---\n*" << pMeta << "*\n";
        }

        if (!propDecl->getFilename().empty()) {
            std::error_code ec;
            std::filesystem::path p = std::filesystem::absolute(propDecl->getFilename(), ec);
            if (ec) p = std::filesystem::path(propDecl->getFilename());
            std::string linkPath = p.generic_string();
            int pLine = propDecl->getLine();
            md << "\n---\n📍 **Declared in**: [" << p.filename().string() << ":" << pLine << "](file:///" << linkPath << "#L" << pLine << ")";
            if (!declaredInType.empty()) {
                md << " (type `" << declaredInType << "`)";
            }
            md << "\n";
        }
        return md.str();
    }

    // Built-in properties fallback with Allowed Types information
    if (propName == "type") return "### Property: `type`\n\n- **Allowed Types**: `_DataType, _TypeClass`\n\nSpecifies the data type or class constraint of this property or signal.";
    if (propName == "name") return "### Property: `name`\n\n- **Allowed Types**: `_StringLiteral`\n\nIdentifier name of the entity or port.";
    if (propName == "entity") return "### Property: `entity`\n\n- **Allowed Types**: `_Entity`\n\nSpecifies the target entity or type referenced by an `alias` declaration.";
    if (propName == "default") return "### Property: `default`\n\n- **Allowed Types**: `_Any`\n\nDefault or initial value for this signal or property.";
    if (propName == "value") return "### Property: `value`\n\n- **Allowed Types**: `_StringLiteral, _IntLiteral, _RealLiteral, _SwitchLiteral, _Constant, _ResourceType, _NoneLiteral`\n\nCurrent or constant value of this entity.";
    if (propName == "domain") return "### Property: `domain`\n\n- **Allowed Types**: `_DomainDefinition`\n\nExecution domain coordinator governing rate and thread context.";
    if (propName == "rate") return "### Property: `rate`\n\n- **Allowed Types**: `_IntLiteral, _RealLiteral`\n\nProcessing rate (sampling frequency in Hz) for this block or domain.";
    if (propName == "meta") return "### Property: `meta`\n\n- **Allowed Types**: `_StringLiteral`\n\nDocumentation description string displayed on hover and in outline summaries.";
    if (propName == "ports") return "### Property: `ports`\n\n- **Allowed Types**: `List of [_Port]`\n\nList of input and output ports for this module or platform entity.";
    if (propName == "properties") return "### Property: `properties`\n\n- **Allowed Types**: `List of [typeProperty]`\n\nList of typed schema properties defined on this type.";
    if (propName == "blocks") return "### Property: `blocks`\n\n- **Allowed Types**: `List of [_Block]`\n\nChild blocks or entities contained within this block.";
    if (propName == "inputs") return "### Property: `inputs`\n\n- **Allowed Types**: `List of [Port]`\n\nInput signal ports or connections.";
    if (propName == "outputs") return "### Property: `outputs`\n\n- **Allowed Types**: `List of [Port]`\n\nOutput signal ports or connections.";
    if (propName == "guard") return "### Property: `guard`\n\n- **Allowed Types**: `_Switch`\n\nBoolean condition guard that must evaluate to `on` / `true` for a transition to fire.";
    if (propName == "targetState") return "### Property: `targetState`\n\n- **Allowed Types**: `_State`\n\nDestination state activated by this transition.";

    return "### Property: `" + propName + "`\n\nConfiguration property for the enclosing declaration.";
}

void handleHover(const std::string &id, const std::string &uri, int line, int character) {
    auto it = openDocuments.find(uri);
    std::string hoverText = "";

    if (it != openDocuments.end() && !isPositionInStringOrComment(it->second.text, line, character)) {
        TokenAtPosition tokenInfo = getTokenAtPosition(it->second.text, line, character);
        std::string token = tokenInfo.token;
        if (!token.empty()) {
            ScopeStack scopeStack;
            if (it->second.tree) {
                scopeStack = buildScopeStackForPosition(it->second.tree, line + 1);
            }

            if (tokenInfo.followedByColon) {
                // Property key resolution (AGENTS.md Rule 5)
                EnclosingDeclarationInfo encInfo = getEnclosingDeclarationInfo(it->second.text, line, character, it->second.tree);
                if (encInfo.isFunctionCall && !encInfo.functionName.empty()) {
                    auto funcDecl = findSymbolOrType(encInfo.functionName, scopeStack, it->second.tree, it->second.importedTree);
                    std::shared_ptr<DeclarationNode> foundPort = nullptr;
                    if (funcDecl) {
                        auto portsVal = funcDecl->getPropertyValue("ports");
                        if (portsVal && portsVal->getNodeType() == AST::List) {
                            for (const auto &pChild : portsVal->getChildren()) {
                                if (pChild->getNodeType() == AST::Declaration) {
                                    auto p = std::static_pointer_cast<DeclarationNode>(pChild);
                                    std::string pName = p->getName();
                                    ASTNode nVal = p->getPropertyValue("name");
                                    if (nVal && nVal->getNodeType() == AST::String) {
                                        pName = std::static_pointer_cast<ValueNode>(nVal)->getStringValue();
                                    }
                                    if (pName == token) {
                                        foundPort = p;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                    if (foundPort) {
                        std::ostringstream md;
                        md << "**Parameter**: `" << token << "` *(for `" << encInfo.functionName << "`)*\n\n";
                        ASTNode pType = foundPort->getPropertyValue("allowedTypes");
                        if (!pType) pType = foundPort->getPropertyValue("types");
                        if (!pType) pType = foundPort->getPropertyValue("type");
                        if (pType) {
                            std::string tStr = formatAllowedTypes(pType);
                            if (!tStr.empty()) md << "- **Allowed Types**: `" << tStr << "`\n";
                        }
                        ASTNode reqVal = foundPort->getPropertyValue("required");
                        if (reqVal) {
                            std::string reqStr = reqVal->toText(0, 0, false);
                            for (char &c : reqStr) c = tolower(c);
                            bool isReq = (reqStr.find("on") != std::string::npos || reqStr.find("true") != std::string::npos);
                            md << "- **Required**: `" << (isReq ? "on (true)" : "off (false)") << "`\n";
                        }
                        ASTNode defVal = foundPort->getPropertyValue("default");
                        if (defVal && defVal->getNodeType() != AST::None) {
                            md << "- **Default**: `" << defVal->toText(0, 0, false) << "`\n";
                        }
                        std::string pMeta = extractMetaDoc(foundPort);
                        if (!pMeta.empty()) md << "\n---\n*" << pMeta << "*\n";
                        if (!foundPort->getFilename().empty()) {
                            std::error_code ec;
                            std::filesystem::path p = std::filesystem::absolute(foundPort->getFilename(), ec);
                            if (ec) p = std::filesystem::path(foundPort->getFilename());
                            md << "\n---\n📍 **Declared in**: [" << p.filename().string() << ":" << foundPort->getLine() << "](file:///" << p.generic_string() << "#L" << foundPort->getLine() << ")\n";
                        }
                        hoverText = md.str();
                    } else {
                        hoverText = renderPropertyHover(token, encInfo.kind, scopeStack, it->second.tree, it->second.importedTree, uri, encInfo);
                    }
                } else {
                    hoverText = renderPropertyHover(token, encInfo.kind, scopeStack, it->second.tree, it->second.importedTree, uri, encInfo);
                }
            } else {
                std::shared_ptr<DeclarationNode> decl = findSymbolOrType(token, scopeStack, it->second.tree, it->second.importedTree);
                std::shared_ptr<DeclarationNode> portForBlock = nullptr;
                if (it->second.tree) {
                    portForBlock = findPortForBlockInScopeStack(scopeStack, it->second.tree, token);
                }

                if (decl) {
                    hoverText = renderDeclarationHover(decl, token, uri);
                } else if (portForBlock) {
                    std::ostringstream md;
                    md << "```stride\nsignal / field " << token << "\n```\n";
                    md << "- **Associated Port**: `" << portForBlock->getName() << "` (`" << portForBlock->getEntityType() << "`)\n";
                    std::string portMeta = extractMetaDoc(portForBlock);
                    if (!portMeta.empty()) {
                        md << "\n---\n*" << portMeta << "*\n\n";
                    }
                    hoverText = md.str();
                } else {
                    // Fallback to purely syntactic keywords and literals not defined as schema types
                    if (token == "in") {
                        hoverText = "### Keyword: `in`\n\nSpecifies the iteration domain or range in generator array declarations (e.g. `[Index in 0:8]`).";
                    } else if (token == "on") {
                        hoverText = "### Literal: `on`\n\nBoolean / switch state representing active, true, or enabled.";
                    } else if (token == "off") {
                        hoverText = "### Literal: `off`\n\nBoolean / switch state representing inactive, false, or disabled.";
                    } else if (token == "none") {
                        hoverText = "### Literal: `none`\n\nLiteral representing an unassigned or absent value.";
                    } else if (token == "import") {
                        hoverText = "### Keyword: `import`\n\nImports declarations from a Stride module or standard library file.";
                    } else if (token == "use") {
                        hoverText = "### Keyword: `use`\n\nImports definitions with optional aliasing (e.g. `use Math as M`).";
                    } else if (token == "as") {
                        hoverText = "### Keyword: `as`\n\nSpecifies a namespace alias for an imported module.";
                    }
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

    std::string declName = decl->getName();
    std::string type = decl->getEntityType();

    bool isAnon = false;
    if (declName.rfind("___Anonymous___", 0) == 0 ||
        declName.rfind("__Anonymous__", 0) == 0 ||
        declName.rfind("___anonymous___", 0) == 0 ||
        declName.find("Anonymous") != std::string::npos ||
        decl->getCompilerProperty("anonymous") != nullptr) {
        isAnon = true;
    }

    std::string innerName = "";
    if (isAnon) {
        ASTNode nameProp = decl->getPropertyValue("name");
        if (nameProp && nameProp->getNodeType() == AST::String) {
            innerName = std::static_pointer_cast<ValueNode>(nameProp)->getStringValue();
        }
        if (innerName.empty()) {
            ASTNode labelProp = decl->getPropertyValue("label");
            if (labelProp && labelProp->getNodeType() == AST::String) {
                innerName = std::static_pointer_cast<ValueNode>(labelProp)->getStringValue();
            }
        }
    }

    std::string genSpec = "";
    auto genVar = decl->getCompilerProperty("_generatorVar");
    auto genRange = decl->getCompilerProperty("_generatorRange");
    if (genVar && genRange) {
        std::string v = genVar->toText(0, 0, false);
        std::string r = genRange->toText(0, 0, false);
        for (char &c : v) { if (c == '\n' || c == '\r') c = ' '; }
        for (char &c : r) { if (c == '\n' || c == '\r') c = ' '; }
        genSpec = v + " in " + r;
    }

    bool isArray = (decl->getNodeType() == AST::ArrayDeclaration);
    std::string arrayDims = "";
    if (isArray) {
        auto arrNode = decl->getArrayIndex();
        if (arrNode) {
            std::vector<size_t> indices = arrNode->getIndices();
            if (!indices.empty()) {
                arrayDims = "[";
                for (size_t i = 0; i < indices.size(); i++) {
                    if (i > 0) arrayDims += ", ";
                    arrayDims += std::to_string(indices[i]);
                }
                arrayDims += "]";
            } else if (arrNode->index() && !arrNode->index()->getChildren().empty()) {
                arrayDims = "[";
                const auto &elems = arrNode->index()->getChildren();
                for (size_t i = 0; i < elems.size(); i++) {
                    if (i > 0) arrayDims += ", ";
                    arrayDims += elems[i]->toText(0, 0, false);
                }
                arrayDims += "]";
            }
        }
    }

    int symbolKind = 13; // Variable default
    std::string displayName;
    std::string detail = type;

    if (isAnon) {
        // Enclose type name with angle brackets to distinguish anonymous declarations
        displayName = "<" + type + ">";
        if (!innerName.empty()) {
            displayName += " \"" + innerName + "\"";
        } else if (!genSpec.empty()) {
            displayName += " [" + genSpec + "]";
        }
        detail = type + " (anonymous)";
        // Use SymbolKind.Operator (25) to provide a distinct symbol and color in VS Code's Outline
        symbolKind = 25;
    } else {
        if (type == "constant" && isArray) {
            displayName = declName + arrayDims;
            detail = "constant array " + arrayDims;
            symbolKind = 18; // SymbolKind.Array (18)
        } else if (isArray) {
            displayName = declName + arrayDims;
            detail = type + " array " + arrayDims;
            symbolKind = 18; // SymbolKind.Array (18)
        } else {
            displayName = declName;
            if (type == "constant") {
                symbolKind = 14; // SymbolKind.Constant (14)
            } else if (type == "module" || type == "reaction" || type == "loop") {
                symbolKind = 6; // Method / Function
            } else if (type == "state" || type == "transition") {
                symbolKind = 23; // Struct
            } else if (type == "_domainDefinition" || type == "gameDefinition" || type == "domainDeclaration" || type == "type") {
                symbolKind = 5; // Class
            } else if (type == "typeProperty" || type == "property") {
                symbolKind = 7; // Property
            } else if (type.find("Port") != std::string::npos || type == "port") {
                symbolKind = 11; // Interface
            } else if (type == "signal" || type == "switch" || type == "trigger") {
                symbolKind = 13; // Variable
            }
            if (!genSpec.empty()) {
                detail = type + " [" + genSpec + "]";
            }
        }
    }

    int startLine = (decl->getLine() > 0) ? (decl->getLine() - 1) : 0;
    int endLine = startLine;

    std::vector<std::string> childSymbolsJson;
    std::unordered_set<const void *> visited;
    visited.insert(node.get());
    std::function<void(ASTNode)> findChildren = [&](ASTNode cur) {
        if (!cur) return;
        for (const auto &child : cur->getChildren()) {
            if (!child || !visited.insert(child.get()).second) continue;
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
    s << "\"name\":\"" << escapeJson(displayName) << "\",";
    s << "\"detail\":\"" << escapeJson(detail) << "\",";
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
        "streamRate", "in", "on", "off", "none", "_IntType", "_RealType", "_SwitchType",
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

    if (it != openDocuments.end()) {
        std::string currentPath = uriToPath(uri);
        std::filesystem::path currentFilePath(currentPath);
        std::filesystem::path currentDir = currentFilePath.parent_path();

        std::string lineText = "";
        std::istringstream iss(it->second.text);
        std::string curL;
        int curLineIdx = 0;
        while (std::getline(iss, curL)) {
            if (curLineIdx == line) {
                lineText = curL;
                break;
            }
            curLineIdx++;
        }

        std::string token = getWordAtPosition(it->second.text, line, character);
        if (!token.empty()) {
            size_t impPos = lineText.find("import");
            if (impPos == std::string::npos) impPos = lineText.find("use");
            if (impPos != std::string::npos && token != "import" && token != "use" && token != "as" && token != "version") {
                std::string sRoot = findStrideRoot("");
                std::vector<std::filesystem::path> candidates = {
                    currentDir / (token + ".stride"),
                    currentDir / token,
                    currentDir / token / (token + ".stride")
                };
                if (!sRoot.empty()) {
                    candidates.push_back(std::filesystem::path(sRoot) / (token + ".stride"));
                    candidates.push_back(std::filesystem::path(sRoot) / "library" / (token + ".stride"));
                    candidates.push_back(std::filesystem::path(sRoot) / "library" / "1.0" / (token + ".stride"));
                }
                for (const auto &cand : candidates) {
                    if (std::filesystem::exists(cand) && std::filesystem::is_regular_file(cand)) {
                        std::string targetUri = "file:///" + cand.generic_string();
                        std::ostringstream r;
                        r << "{";
                        r << "\"uri\":\"" << escapeJson(targetUri) << "\",";
                        r << "\"range\":{\"start\":{\"line\":0,\"character\":0},\"end\":{\"line\":0,\"character\":0}}";
                        r << "}";
                        result = r.str();
                        break;
                    }
                }
            }

            if (result == "null") {
                ScopeStack scopeStack = it->second.tree ? buildScopeStackForPosition(it->second.tree, line + 1) : ScopeStack();
                std::shared_ptr<DeclarationNode> decl = findSymbolOrType(token, scopeStack, it->second.tree, it->second.importedTree);
                if (decl) {
                    int declLine = (decl->getLine() > 0) ? (decl->getLine() - 1) : 0;
                    std::string targetUri = uri;
                    if (!decl->getFilename().empty()) {
                        std::string fn = decl->getFilename();
                        if (fn.rfind("file://", 0) != 0) {
                            std::error_code ec;
                            std::filesystem::path p = std::filesystem::absolute(fn, ec);
                            if (ec) p = std::filesystem::path(fn);
                            targetUri = "file:///" + p.generic_string();
                        } else {
                            targetUri = fn;
                        }
                    }
                    std::ostringstream r;
                    r << "{";
                    r << "\"uri\":\"" << escapeJson(targetUri) << "\",";
                    r << "\"range\":{\"start\":{\"line\":" << declLine << ",\"character\":0},\"end\":{\"line\":" << declLine << ",\"character\":100}}";
                    r << "}";
                    result = r.str();
                }
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

    // Save true stdout streambuf for LSP JSON-RPC transmission
    g_realStdoutBuf = std::cout.rdbuf();

    // Redirect standard std::cout to std::cerr to prevent any library calls,
    // debug statements, or validator messages from corrupting the JSON-RPC pipe.
    std::cout.rdbuf(std::cerr.rdbuf());

    // Direct all Stride Logger output away from stdout
    Logger::setInfoOutput(&std::cerr);
    Logger::setErrorOutput(&std::cerr);
    Logger::setWarningOutput(&std::cerr);
    Logger::setDebugOutput(&std::cerr);

    std::string explicitRoot = "";
    for (int i = 1; i < argc; i++) {
        std::string arg = argv[i];
        if (arg == "--strideroot" && i + 1 < argc) {
            explicitRoot = argv[++i];
        } else if (arg.rfind("--strideroot=", 0) == 0) {
            explicitRoot = arg.substr(13);
        }
    }

    initLibrary(explicitRoot);

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
