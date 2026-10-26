# Data Types in Stride

Every value in Stride has a data type, for example `Int`, `Real`, `UInt8` or
`Switch`. Some data types have a fixed size on every platform. Others are
**aliases** whose size the platform's framework decides. This document
explains how a framework sizes `Int`, `UInt`, `Real` and `Size`, and how to
ask for an exact size when your code needs one.

```stride
signal Gain    { type: Real }               # the framework's preferred float
signal Count   { type: Int default: 0 }     # the framework's preferred integer
signal Level   { type: UInt8 default: 255 } # exactly 8 bits, unsigned
signal Samples { type: Float32 }            # exactly 32 bits, on every platform
```

## 1. The data types

| Kind | Fixed size | Size decided by the framework |
|---|---|---|
| Signed integer | `Int8` `Int16` `Int32` `Int64` | `Int` |
| Unsigned integer | `UInt8` `UInt16` `UInt32` `UInt64` | `UInt`, `Size` |
| Floating point | `Float32` `Float64` | `Real` |
| On/off | `Switch` | |
| Text | `String` | |

The name of a type is the only place its size and sign are set. `Int8` to
`Int64` are signed, `UInt8` to `UInt64` are unsigned, and the number is the
size in bits. Aliases take both from the type they stand for, so `UInt` and
`Size` are unsigned.

Data type names never start with `_`. Names that start with `_`
(`_NumericTypes`, `_IntLiteral`, `_Switch`, ...) are **schema types**, which
describe and validate declarations. They are covered in section 8.

## 2. How a platform decides the size of `Int`, `UInt`, `Real` and `Size`

`Int`, `UInt`, `Real` and `Size` are aliases. An alias names one of the
fixed-size types, and the framework that compiles your code chooses which
one. You write `Int` once, and each platform makes it the integer that suits
its hardware.

| Framework | `Int` | `UInt` | `Real` | `Size` |
|---|---|---|---|---|
| JIT | `Int32` | `UInt32` | `Float64` | `UInt64` |
| Cpp, DesktopTemplate, TestFramework | `Int32` | `UInt32` | `Float64` | `UInt64` |
| Pico, STM32F7 | `Int32` | `UInt32` | `Float32` | `UInt32` |
| Wiring (AVR) | `Int16` | `UInt16` | `Float32` | `UInt16` |

For example, `signal Gain { type: Real }` is a 64-bit `double` in the JIT and
a 32-bit `float` on a Pico. On microcontrollers without double-precision
hardware, `float` math is much faster.

### Where the choice is made

Each framework declares its data types in
`frameworks/<Framework>/<version>/platformlib/Types.stride`. The fixed-size
types say exactly what they are:

```stride
frameworkDataType Int32 {
    frameworkName: "int32_t"
    includes: ["<cstdint>"]
    kind: "integer"
    bits: 32
}

frameworkDataType UInt8 {
    frameworkName: "uint8_t"
    includes: ["<cstdint>"]
    kind: "integer"
    bits: 8
}
```

`UInt8` is unsigned because of its name. An integer type must be named
`Int<bits>` or `UInt<bits>`, and a float type `Float<bits>`. Any other name
has to be an alias (section 6).

The aliases are ordinary `alias` declarations, which name the entity they
stand for. From the Pico framework:

```stride
alias Int {
    entity: Int32
}

alias Real {
    entity: Float32
}
```

Each data type is declared once, as a `frameworkDataType`. An alias adds no
properties of its own: everything about it, including the name used in
generated C/C++ code, comes from the type it stands for. On a Pico, `Int`
is `int32_t` and `Real` is `float`.

`library/1.0/FrameworkDataTypes.stride` declares the library defaults (`Int`
is `Int32`, `UInt` is `UInt32`, `Real` is `Float64`, `Size` is `UInt64`). A
framework's own declarations always take precedence over the library's.

### What the compilers do with it

- **The JIT** reads the `frameworkDataType` declarations and builds its LLVM
  types from `kind` and `bits`. Integers become `iN`, `Float32` and
  `Float64` become `float` and `double`, `Switch` becomes `i1`, and `String`
  becomes the `{ptr, i32}` string view. An alias has exactly the LLVM type of
  the type it stands for. The JIT keeps each type's signedness, because
  LLVM integer types don't record it.
- **C/C++ code generation** writes each type's `frameworkName` (and adds its
  `includes`). For an alias it writes those of the type it stands for.

### Changing the sizes for a framework

To change what an alias means on a platform, edit that framework's
`Types.stride`. For example, to make `Real` double precision on an STM32F7
board with a double-precision FPU:

```stride
alias Real {
    entity: Float64
}
```

Code that uses `Real` picks up the new size. Code that uses `Float32` or
`Float64` keeps its exact size.

A new framework declares the full set: the ten fixed-size types, `Switch`,
`String`, the four aliases, and the type classes (section 8). The generated
`Types.stride` files of the existing frameworks are a good template.

## 3. Selecting a specific size

Use an alias when the size doesn't matter. This is most code: counters,
gains, indices. Use a fixed-size type when it does:

- **The value has a known range or layout.** Use `UInt8` for a MIDI byte or a
  pixel channel, `Int16` for 16-bit audio samples, and `UInt32` for a register
  value.
- **Results must be the same on every platform.** `Float64` is double
  precision on the desktop and on a Pico, while `Real` is not.
- **A `platformModule` hardcodes an LLVM width.** If its `processing:` string
  calls an external function that takes `i32`, declare its ports `Int32`. A
  declared type that doesn't match the LLVM type silently corrupts memory.
- **You need wraparound arithmetic.** `UInt8` 255 + 1 is 0.

### In entities

Give the entity a `type`:

```stride
signal Byte     { type: UInt8 default: 0 }
signal Position { type: Int64 default: 0 }
signal Phase    { type: Float32 default: 0.0 }
```

A `signal` without a `type` gets the default numeric type, which is the first
member of the framework's `_NumericTypes`: `Real`.

### In platform modules

Ports of a `platformModule` take data types:

```stride
platformModule ReadRegister {
    inputs: [UInt32]   # address
    outputs: [UInt32]  # value
    processing: "%%outtokens:0%% = call i32 @read_register(i32 %%intokens:0%%)"
    inherits: [_Signal]
}
```

Arguments are converted to the declared input types before the call. For
example, a `UInt8` signal streamed into a `UInt32` input is zero-extended.

### What a platform supports

A framework's type classes list the types it supports. A block whose `type`
is not in `_NumericTypes` is rejected. Wiring leaves `Float64` out, because
`double` on AVR is 32 bits, so `type: Float64` is an error there. Use `Real`
when you want "the best float this board has".

## 4. Literals, mixing types and conversion

Literals take the alias types: `3` is an `Int`, `0.5` is a `Real`, `on` is a
`Switch` and `"text"` is a `String`. A literal written into a block takes the
block's type, so `3000000000 >> Wide;` stores the full value in an `Int64`.

When an operation or a list mixes two numeric types, both are converted to
the **promoted** type:

1. A float wins over an integer: `Int + Real` is `Real`.
2. Two floats, or two integers of the same sign, take the wider type:
   `Float32 + Float64` is `Float64`, and `UInt8 + UInt16` is `UInt16`.
3. If either integer is signed, the result is signed:
   - A signed type that is wider than the unsigned one holds both:
     `UInt8 + Int16` is `Int16`.
   - Otherwise the result is a signed type twice as wide as the unsigned one,
     so every unsigned value still fits: `UInt8 + Int8` is `Int16`,
     `Int32 + UInt32` is `Int64`, and `UInt16 + Int8` is `Int32`.
   - 64 bits is the widest type. `UInt64 + Int8` is `Int64`, which can't hold
     the largest `UInt64` values. The conversion report flags this (section 5).

Unlike C, mixing signed and unsigned never gives an unsigned result. So
`Int8` -3 minus `UInt8` 10 is -13, not 243. Division and comparison follow
the sign of the promoted type. They are unsigned only when both operands
are.

Writing a value into a block converts it to the block's type:

- Integers are truncated or extended according to the sign of the source.
  `UInt8` 255 widens to 255, and `Int8` -3 widens to -3.
- Integers convert to floats according to their sign. `UInt8` 255 becomes
  255.0, not -1.0.
- Floats convert to integers by truncation toward zero.
- Any number written to a `Switch` is `on` when it is not zero.

When choosing between `platformModule` variants (for example the `Int` and
`Real` versions of `Greater`), Stride prefers an exact type match. It also
accepts a value that converts without losing range:

- an integer for a float input
- a narrower type for a wider type of the same sign
- an unsigned type for a wider signed type

A signed value is never passed to an unsigned input, and a float is never
passed to an integer input, without an explicit block of that type in
between.

## 5. Finding conversions that lose data

Some conversions can change a value:

| Conversion | What can happen |
|---|---|
| To a narrower integer (`Int32` to `Int16`) | values outside the range wrap |
| Signed to unsigned (`Int8` to `UInt32`) | negative values wrap |
| Unsigned to a signed type of the same or smaller width (`UInt32` to `Int32`) | large values become negative |
| Float to integer (`Real` to `Int`) | the fractional part is truncated, and large values overflow |
| To a narrower float (`Float64` to `Float32`) | precision and range are lost |
| Large integer to float (`Int32` to `Float32`, `Int64` to `Float64`) | integers above 2^24 (`Float32`) or 2^53 (`Float64`) are rounded |
| Mixed operands whose promoted type can't hold both (`UInt64 + Int8`) | the largest unsigned values become negative |

The compiler can list every place where one of these happens. A literal
that fits the destination is not reported, so `200 >> Byte;` is fine for a
`UInt8` and `300 >> Byte;` is reported.

**From the command line**, pass `-Wconversion` (or `--report-conversions`)
to `stridec`:

```
stridec -c dsp.stride -o dsp.o -Wconversion
dsp.stride:30:1: warning: conversion from 'Int' to 'UInt8' wraps negative values and values above the maximum of UInt8 [-Wconversion]
dsp.stride:41:1: warning: conversion from 'Int' to 'Int16' wraps values outside the range of Int16 [-Wconversion]
```

These are warnings, so the code still compiles. The lines use the
`file:line:column: warning:` format that editors and CI tools parse.

**In the editor**, the Stride language server shows the same conversions as
warnings on the stream lines where they happen.

**From C++**, these all return the warnings as `LangError`s of type
`LossyConversion`, with severity `Warning`:

- `CodeValidator::getWarnings()`
- `CodeValidator::findLossyConversions(tree)` on a resolved tree
- `StrideEnvironment::getConversionWarnings()`

To silence a warning, make the conversion explicit with a block of the
destination type, or change the types so that no data can be lost.

## 6. Writing your own aliases

A framework, a library or a program can declare more aliases:

```stride
# Audio sample of this platform's codec
alias Sample {
    entity: Int16
}

# Aliases of aliases are followed to any depth
alias Accumulator {
    entity: Sample
}
```

An alias of a data type can be used anywhere the data type can, including
in a `typeClass`. Aliases that lead back to themselves (`alias A { entity:
B }` and `alias B { entity: A }`) are an error.

## 7. Current limitations

- Inside a polymorphic module whose port types come from its connections
  (`type: Input.type`), integers are treated as signed. Declare the port's
  type if the module must do unsigned division or comparison.
- `Format` (JIT `Strings.stride`) formats `Int`, `Real`, `Switch` and
  `String` arguments.
- The conversion report covers writes into blocks and mixed operands. It
  doesn't cover the arguments that a `platformModule` variant converts. Those
  are always conversions that keep the value, except a large integer passed
  to a float input.

## 8. Schema types and validation

Schema types describe declarations and are never data types. In a schema's
`allowedTypes`:

- **Type classes** accept any of their data types. Each framework declares
  these four:
  - `_NumericTypes`: all integer and float types. Its first member, `Real`, is
    the default type of a `signal`.
  - `_IntegerTypes`
  - `_FloatTypes`
  - `_DataTypes`: every data type, including `Switch` and `String`.
- **Literal types** accept a literal value written in a declaration:
  `_IntLiteral`, `_RealLiteral`, `_SwitchLiteral`, `_StringLiteral` and
  `_NoneLiteral`.
- **Declaration types** accept blocks of that type. For example, `_Switch`
  accepts a `switch` block.

```stride
typeProperty Threshold {
    name: "threshold"
    allowedTypes: constrainedEntity { allowed: [_NumericTypes, _NoneLiteral] }
}
```

The compiler reports these mistakes as `Invalid Data Type` errors:

- a block whose `type` is a schema type: `type: _NumericTypes`,
  `type: _IntLiteral`
- a block that takes the name of a data type: `signal Real {}`
- a `frameworkDataType` whose name starts with `_`, or a `typeClass` or
  `type` whose name doesn't
- a `frameworkDataType` without `kind`
- a `frameworkDataType` whose `bits` don't fit its kind. Integers take 8, 16,
  32 or 64. Floats take 32 or 64.
- an integer or float type whose name doesn't match its kind and bits
  (`Int16` with `bits: 32`, or `Byte` with `kind: "integer"`). Use an alias
  for other names.
- an alias of a data type whose name starts with `_`
- an alias that leads back to itself
- a `typeClass` member that is not a data type
- an `allowedTypes` that lists a data type instead of a type class

These only take data types:

- a `platformModule`'s `inputs`, `outputs` and `ports`
- a `variadic`'s `types`
- a framework's `defaultDataType`
