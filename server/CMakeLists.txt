cmake_minimum_required(VERSION 3.14)
project(stride-lsp LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Configure paths to Stride dependencies (override via -DSTRIDE_ROOT=... if needed)
# TODO we should use FindStride once that is implemented
set(STRIDE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../boardgame/libgame/external" CACHE PATH "Path to Stride dependencies root")

if(NOT TARGET StrideParser)
    add_subdirectory("${STRIDE_ROOT}/strideparser" strideparser_build)
endif()

if(NOT TARGET StrideUtils)
    add_subdirectory("${STRIDE_ROOT}/strideutils" strideutils_build)
endif()

if(NOT TARGET StrideCodegen)
    add_subdirectory("${STRIDE_ROOT}/codegen" stridecodegen_build)
endif()

add_executable(stride-lsp src/main.cpp)

target_include_directories(stride-lsp PRIVATE
    "${STRIDE_ROOT}/codegen/include"
    "${STRIDE_ROOT}/strideparser/include"
    "${STRIDE_ROOT}/strideutils/include"
)

target_link_libraries(stride-lsp PRIVATE
    StrideCodegen
    StrideParser
    StrideUtils
)

if (WIN32)
    # Output directly to server/bin for easy discovery by the extension
    set_target_properties(stride-lsp PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_CURRENT_SOURCE_DIR}/bin"
        RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    )
else()
    set_target_properties(stride-lsp PROPERTIES
        RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/bin"
    )
endif()
