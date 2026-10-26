# Stride Unit Testing Formalization & Reference Guide

This document outlines the declarative Unit Testing framework for the Stride language, covering schema definitions, multi-tick stream semantics, assertion modules, benchmarking, zero-heap memory tracking, and integration workflows.

---

## 1. Architectural Principles

- **Declarative Test Specifications:** Tests are declared natively in Stride using the `functionTest` keyword. Test definitions specify input preparation streams (`prepare: [ ... ]`) and output expectation streams (`validate: [ ... ]`) without requiring external test harnesses.
- **Auto-Loaded Standard Assertions:** Assertion modules (`ExpectEqual`, `ExpectNear`, `ExpectTrue`, etc.) are part of the Stride standard library root (`strideroot/library/1.0/Assertions.stride`) and are available globally without requiring explicit `import Assertions;` statements.
- **Universal Test Targets:** Tests can target domains, modules, or standalone functions using the `target:` property (with `function:` supported as a fallback alias).
- **Direct Module & Field Testing:** Modules can be tested directly without domain wrappers. Input ports, property fields, and control/reset switches can all be modulated across ticks in `prepare:` by streaming value lists into ports (`[ v0, v1, ... ] >> Port;`).
- **Conventional Assertion Syntax:** In `validate:`, assertions follow standard Stride streaming conventions where a 2-element list `[ OutputPort, [ expected_values ] ]` is streamed into the assertion module (`[ Output, [ 1.0, 2.0 ] ] >> ExpectEqual();`).
- **Multi-Tick Stream Execution:** For scalar (size 1) input/output ports connected to multi-element lists, the test execution engine automatically iterates across discrete ticks $t = 0 \dots N-1$, feeding sample values sequentially and asserting output conditions at each tick.
- **Zero Runtime Overhead & No-Heap Invariants:** Real-time signal processing demands zero heap allocations during steady-state processing. The test framework enforces allocation tracking per execution step to prevent memory leaks and garbage collection jitter.
- **Statistical Benchmarking:** Automatic profiling calculates warm-up passes, mean latency, median, P99, min/max execution times, and jitter Coefficient of Variation ($CV = \sigma / \mu$).

---

## 2. Core Schema (`FunctionTest.stride` & `Assertions.stride`)

### `_FunctionTest` Schema
**Path:** `strideroot/library/1.0/FunctionTest.stride`

```stride
type _FunctionTest {
    typeName: "functionTest"
    properties: [
        typeProperty Target {
            name: "target"
            allowedTypes: [""]
            default: none
            required: off
        }
        typeProperty Function {
            name: "function"
            allowedTypes: [""]
            default: none
            required: off
        }
        typeProperty Prepare {
            name: "prepare"
            allowedTypes: [""]
            default: none
            required: on
        }
        typeProperty Validate {
            name: "validate"
            allowedTypes: [""]
            default: none
            required: on
        }
        typeProperty Timeout {
            name: "timeout"
            allowedTypes: ["real"]
            default: 0.0
            required: off
        }
    ]
    inherits: [_Base]
}
```

### Property Descriptions
| Property | Type | Required | Description |
|---|---|---|---|
| `target` | Identifier / String | Yes (or `function`) | Name of the target domain, module, or function under test. |
| `function` | Identifier / String | Yes (if `target` omitted) | Legacy alias for `target`. |
| `prepare` | Stream List | Yes | Input stream assignments feeding value lists into ports across ticks (`[ ... ] >> Port;`). |
| `validate` | Stream List | Yes | Output assertions checking port outputs (`[ Port, [ ... ] ] >> ExpectModule();`). |
| `timeout` | Real | No | Maximum allowed execution time in seconds (0.0 = unlimited). |

---

## 3. Assertion Modules (`Assertions.stride`)

**Path:** `strideroot/library/1.0/Assertions.stride`

Stride assertions are expressed as standard stream elements fed by a 2-element list `[ Port, [ ExpectedValues ] ]`:

| Module | Pipeline Syntax | Description |
|---|---|---|
| `ExpectEqual` | `[ Port, [ v0, v1, ... ] ] >> ExpectEqual();` | Exact equality for integers/booleans; default tolerance ($10^{-6}$) for reals. |
| `ExpectNear` | `[ Port, [ v0, v1, ... ] ] >> ExpectNear(epsilon: 0.01);` | Floating-point proximity check ($|actual - expected| \le \epsilon$). |
| `ExpectTrue` | `Port >> ExpectTrue();` | Asserts that boolean/switch output is `true` (`on` / `1`). |
| `ExpectFalse` | `Port >> ExpectFalse();` | Asserts that boolean/switch output is `false` (`off` / `0`). |
| `ExpectGt` | `[ Port, [ min0, min1, ... ] ] >> ExpectGt();` | Asserts strictly greater than ($actual > bound$). |
| `ExpectGe` | `[ Port, [ min0, min1, ... ] ] >> ExpectGe();` | Asserts greater than or equal ($actual \ge bound - \epsilon$). |
| `ExpectLt` | `[ Port, [ max0, max1, ... ] ] >> ExpectLt();` | Asserts strictly less than ($actual < bound$). |
| `ExpectLe` | `[ Port, [ max0, max1, ... ] ] >> ExpectLe();` | Asserts less than or equal ($actual \le bound + \epsilon$). |

---

## 4. Multi-Tick Execution Semantics

When testing a target:

1. **Tick Count Resolution:** The total number of ticks $T$ is computed as the maximum length among all streams defined in `prepare:` ($T = \max_{s \in prepare} |s|$).
2. **Tick-by-Tick Processing:**
   $$\forall t \in [0, T-1]:$$
   - **Step 1 (Input & Field Preparation):** Port inputs and property fields for tick $t$ are loaded from their respective list streams: $Port_i \leftarrow Prepare_i[t]$.
   - **Step 2 (Execution):** The domain/module process function executes for tick $t$.
   - **Step 3 (Validation):** Each output port $Out_j$ is evaluated against its assertion:
     $$\text{Assert}\big(Out_j(t), Validate_j[t]\big)$$
     If any assertion fails, execution immediately halts, reporting the failing port, tick index, expected value/condition, and actual value.

---

## 5. Applied Examples

### Example 1: Direct Module Testing
```stride
module AddTwo {
    ports: [
        mainInputPort InputPort { block: Input },
        mainOutputPort OutputPort { block: Output }
    ]
    blocks: [
        signal Input  { default: 0.0 }
        signal Output { default: 0.0 }
    ]
    streams: [
        Input + 2.0 >> Output;
    ]
}

functionTest AddTwoTest {
    target: AddTwo
    prepare: [
        [ 1.0, 2.0, 3.0, 4.0 ] >> Input;
    ]
    validate: [
        [ Output, [ 3.0, 4.0, 5.0, 6.0 ] ] >> ExpectEqual();
    ]
}
```

### Example 2: Setting Property Fields Over Time
```stride
module Amplifier {
    ports: [
        mainInputPort InPort { block: Input },
        mainOutputPort OutPort { block: Output },
        propertyInputPort FactorPort { name: 'gain' block: Gain }
    ]
    blocks: [
        signal Input { default: 0.0 }
        signal Output { default: 0.0 }
        propertyBlock Gain { default: 1.0 }
    ]
    streams: [
        Input * Gain >> Output;
    ]
}

functionTest DynamicGainTest {
    target: Amplifier
    prepare: [
        [ 1.0, 2.0, 3.0,  4.0 ] >> Input;
        [ 2.0, 0.5, 10.0, 0.0 ] >> Gain; # Modulate gain field per tick
    ]
    validate: [
        [ Output, [ 2.0, 1.0, 30.0, 0.0 ] ] >> ExpectEqual();
    ]
}
```

### Example 3: Stateful Modules with Resets
```stride
module Accumulator {
    ports: [
        mainInputPort InPort { block: Input },
        mainOutputPort OutPort { block: Output },
        propertyInputPort ResetPort { name: 'reset' block: Reset }
    ]
    blocks: [
        signal Input { default: 0.0 }
        signal Output { default: 0.0 }
        signal Total { default: 0.0 reset: Reset persistent: on }
        switch Reset { default: off }
    ]
    streams: [
        Total + Input >> Total;
        Total >> Output;
    ]
}

functionTest AccumulatorResetTest {
    target: Accumulator
    prepare: [
        [ 10.0, 20.0, 5.0, 15.0 ] >> Input;
        [ off,  off,  on,  off  ] >> Reset; # Reset fires on tick 2
    ]
    validate: [
        # Output reflects accumulation and reset:
        # Tick 0: 0 + 10 = 10
        # Tick 1: 10 + 20 = 30
        # Tick 2: Reset fires -> resets to 0 + 5 = 5
        # Tick 3: 5 + 15 = 20
        [ Output, [ 10.0, 30.0, 5.0, 20.0 ] ] >> ExpectEqual();
    ]
}
```

### Example 4: Domain Pipeline Testing
```stride
_domainDefinition AudioDomain {
    framework: _JitFramework
    rate: 44100
    inputs:  [ signal In  { domain: AudioDomain type: Real } ]
    outputs: [ signal Out { domain: AudioDomain type: Real } ]
}

In >> Amplifier(gain: 3.0) >> Accumulator() >> Out;

functionTest DomainPipelineTest {
    target: AudioDomain
    prepare: [
        [ 1.0, 2.0, 3.0, 4.0 ] >> In;
    ]
    validate: [
        [ Out, [ 3.0, 9.0, 18.0, 30.0 ] ] >> ExpectEqual();
    ]
}
```

### Example 5: Proximity & Inequality Bounds
```stride
functionTest FilterResponseTest {
    target: LowPassFilterDomain
    prepare: [
        [ 1000.0, 1000.0, 1000.0 ] >> Cutoff;
        [ 1.0,    0.0,    0.0    ] >> In;
    ]
    validate: [
        [ Out, [ 0.125, 0.234, 0.198 ] ] >> ExpectNear(epsilon: 0.005);
        [ Out, [ 0.0,   0.0,   0.0   ] ] >> ExpectGe();
    ]
}
```

---

## 6. CMake & CTest Integration

Tests written in `.stride` files integrate directly with CMake and CTest without requiring external plugins:

```cmake
file(GLOB STRIDE_TEST_FILES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/data/*Test.stride")

foreach(TEST_FILE ${STRIDE_TEST_FILES})
    get_filename_component(TEST_NAME ${TEST_FILE} NAME_WE)
    add_test(
        NAME "stridetest.${TEST_NAME}"
        COMMAND stridetest "${TEST_FILE}"
    )
    set_tests_properties("stridetest.${TEST_NAME}" PROPERTIES
        LABELS "StrideLanguage"
        TIMEOUT 30
    )
endforeach()
```

### Running Tests
```powershell
# Run all tests with diagnostics
ctest --test-dir build --output-on-failure

# Filter only Stride language unit tests
ctest --test-dir build --output-on-failure -R "stridetest\."
```
