# Stride Base Standard Library Specification & Reference Guide

This document defines the architecture, conventions, and module catalog of the Stride Base Standard Library (`strideroot/library/1.0/`).

---

## 1. Architectural Principles & Conventions

### 1.1 Global Prelude Scope
All files residing directly at `strideroot/library/1.0/` form the **Stride Prelude**. They are implicitly loaded into the global scope by the compiler (`stridec`) and JIT engine (`stridejit`) without requiring explicit `import` statements.

### 1.2 Primary Signal Path vs. Named Properties
To maintain idiomatic, readable dataflow pipelines in DSP code:
- **Audio & Signal Path:** Kept on `mainInputPort` and `mainOutputPort`.
- **Modulation, Conditions & Parameters:** Routed via named `propertyInputPort`s.

```stride
# Idiomatic pipeline: audio stays in the stream flow
AudioIn
    >> Level(gain: 0.5)
    >> Clamp(min: -1.0 max: 1.0)
    >> Select(condition: Mute whenOn: 0.0 whenOff: AudioIn)
    >> AudioOut;
```

### 1.3 Terminology: Lists vs. Arrays
- **Array:** A sized entity declaration in code:
  ```stride
  signal Voices[4] { default: 0.0 }
  ```
- **List:** Grouped stream expressions enclosed in brackets `[ ... ]`:
  ```stride
  [ LeftChannel, RightChannel ] >> AudioOut;
  ```

### 1.4 Native Intrinsics & Platform Marshalling
- **Standard Library Modules:** Provide the clean, typed public API with Stride ports and defaults.
- **Platform Modules (`platformModule`):** Declared in `frameworks/<Framework>/1.0/platformlib/`, mapping directly to hardware intrinsics, `libm`, or LLVM instructions.
- If a specific architecture requires argument permutation or fixed-point translation, the framework overlays an intermediate marshalling module without changing the standard library contract.

---

## 2. Module Catalog

### 2.1 Elementary & Scalar Math (`Math.stride`)

#### Constants
* `_Pi`: Mathematical constant $\pi \approx 3.141592653589793$
* `_TwoPi`: Mathematical constant $2\pi \approx 6.283185307179586$
* `_E`: Euler's number $e \approx 2.718281828459045$

#### Unary Functions
* **`Abs()`**: Absolute value $|x|$.
  ```stride
  Input >> Abs() >> Output;
  ```
* **`Sign()`**: Signum function. Outputs `1.0` if $x > 0$, `-1.0` if $x < 0$, and `0.0` if $x = 0$.
  ```stride
  Input >> Sign() >> Output;
  ```
* **`Inverse()`**: Arithmetic negation $-x$.
  ```stride
  Input >> Inverse() >> Output;
  ```
* **`Floor()`**: Largest integer less than or equal to input $\lfloor x \rfloor$.
  ```stride
  Input >> Floor() >> Output;
  ```

#### Trigonometry & Exponentials
* **`Sin()` / `Cos()` / `Tan()`**: Trigonometric functions (input in radians).
  ```stride
  Phase >> Sin() >> AudioOut;
  ```
* **`Exp()`**: Natural exponential $e^x$.
* **`Pow()`**: Base raised to exponent $x^y$:
  ```stride
  [ Base, Exponent ] >> Pow() >> Output;
  ```

#### Binary Arithmetic
* **`Multiply()`**: Product of two values in a list: `[ A, B ] >> Multiply() >> Out;`
* **`Divide()`**: Quotient of two values in a list: `[ A, B ] >> Divide() >> Out;`

#### Saturation, Clamping & Wrapping
* **`Max()`**: Maximum of two values in a list: `[ A, B ] >> Max() >> Out;`
* **`Min()`**: Minimum of two values in a list: `[ A, B ] >> Min() >> Out;`
* **`Clamp(min: 0.0 max: 1.0)`**: Constrains input between lower and upper bounds:
  ```stride
  Input >> Clamp(min: -1.0 max: 1.0) >> Output;
  ```
* **`Wrap(min: 0.0 max: 1.0)`**: Periodically wraps input within $[min, max)$:
  ```stride
  Phase >> Wrap(min: 0.0 max: 1.0) >> WrappedPhase;
  ```

#### Interpolation & Mapping
* **`Lerp(target: Target factor: Mix)`**: Linearly interpolates from `Input` to `target` by `factor` ($0.0 \to \text{Input}$, $1.0 \to \text{target}$):
  $$\text{out} = \text{Input} + (\text{target} - \text{Input}) \times \text{factor}$$
  ```stride
  DrySignal >> Lerp(target: WetSignal factor: 0.3) >> Output;
  ```
* **`Map(inMin: ... inMax: ... outMin: ... outMax: ...)`**: Linearly rescales input from source range to destination range:
  ```stride
  ControlVoltage >> Map(inMin: 0.0 inMax: 1.0 outMin: 200.0 outMax: 2000.0) >> Frequency;
  ```

---

### 2.2 Relational Comparisons (`Comparisons.stride`)

All comparison modules take a 2-element list of signals `[ Left, Right ]` on `mainInputPort` and output a switch (`on` / `off`) on `mainOutputPort`:

| Module | Condition Tested | Pipeline Syntax |
|---|---|---|
| `Greater()` | $\text{Left} > \text{Right}$ | `[ A, B ] >> Greater() >> SwitchOut;` |
| `GreaterOrEqual()` | $\text{Left} \ge \text{Right}$ | `[ A, B ] >> GreaterOrEqual() >> SwitchOut;` |
| `Less()` | $\text{Left} < \text{Right}$ | `[ A, B ] >> Less() >> SwitchOut;` |
| `LessOrEqual()` | $\text{Left} \le \text{Right}$ | `[ A, B ] >> LessOrEqual() >> SwitchOut;` |
| `Equal()` | $\text{Left} = \text{Right}$ | `[ A, B ] >> Equal() >> SwitchOut;` |
| `NotEqual()` | $\text{Left} \ne \text{Right}$ | `[ A, B ] >> NotEqual() >> SwitchOut;` |

---

### 2.3 Logic & Multiplexing (`Logic.stride`)

#### `Select()`
Conditional multiplexer. Keeps the primary signal path on `mainInputPort` while accepting the condition and alternate values via properties:
```stride
Input >> Select(condition: Gate whenOn: AlternateSignal whenOff: Input) >> Output;
```

#### Boolean Operations
Operate on switch signals:
* **`And()`**: `[ A, B ] >> And() >> Out;`
* **`Or()`**: `[ A, B ] >> Or() >> Out;`
* **`Not()`**: `InSwitch >> Not() >> OutSwitch;`
* **`Xor()`**: `[ A, B ] >> Xor() >> Out;`
* **`Nand()`**: `[ A, B ] >> Nand() >> Out;`
* **`Nor()`**: `[ A, B ] >> Nor() >> Out;`

---

### 2.4 Control & Signal Flow Bridges (`Control.stride`)

* **`OnChange()`**: Outputs `on` for a single tick whenever the input value changes from its previous sample $z^{-1}$:
  ```stride
  SliderSignal >> OnChange() >> TriggerPulse;
  ```
* **`RisingEdge()`**: Outputs `on` for one tick when a switch transitions from `off` to `on`:
  ```stride
  Gate >> RisingEdge() >> NoteTrigger;
  ```
* **`FallingEdge()`**: Outputs `on` for one tick when a switch transitions from `on` to `off`:
  ```stride
  Gate >> FallingEdge() >> NoteRelease;
  ```
* **`Latch(trigger: ...)`**: Sample-and-Hold. When `trigger` is `on`, latches the incoming `Input` signal; when `off`, holds the previous value steady:
  ```stride
  AnalogInput >> Latch(trigger: Clock) >> HeldOutput;
  ```
* **`Smooth(coefficient: ...)`**: First-order exponential parameter smoother (leaky integrator):
  $$y[n] = x[n] \times (1 - \alpha) + y[n-1] \times \alpha$$
  ```stride
  MidiParam >> Smooth(coefficient: 0.99) >> AudioRateParam;
  ```

---

### 2.5 Array Aggregations (`BasicOperations.stride`)

* **`Sum()`**: Computes the sum across all channels of an input array:
  ```stride
  Voices >> Sum() >> MasterOut;
  ```
* **`Average()`**: Computes the arithmetic mean across all channels of an input array:
  ```stride
  Sensors >> Average() >> MeanVal;
  ```
* **`Clip(minimum: ... maximum: ...)`**: Alias for `Clamp`.

---

### 2.6 Discrete Accumulation (`Counter.stride`)

* **`Counter(startValue: ... stopValue: ... increment: ... reset: ...)`**:
  Discrete accumulator stepping by `increment` each tick. Upon exceeding `stopValue`, wraps back to `startValue`.
  ```stride
  Counter(startValue: 0 stopValue: 15 increment: 1) >> StepIndex;
  ```

---

## 3. Unit Testing & Verification (`tests/`)

Every standard library module has an associated test suite executed via Stride's native `functionTest` harness:

```stride
functionTest ClampTest {
    target: Clamp
    prepare: [
        [ -0.5, 0.0, 0.4, 1.0, 1.5 ] >> Input;
        [ 0.0, 0.0, 0.0, 0.0, 0.0 ]  >> MinVal;
        [ 1.0, 1.0, 1.0, 1.0, 1.0 ]  >> MaxVal;
    ]
    validate: [
        [ Output, [ 0.0, 0.0, 0.4, 1.0, 1.0 ] ] >> ExpectNear(epsilon: 0.0001);
    ]
}
```

Tests can be executed across all test files using the Stride test runner:
```bash
stridetest strideroot/library/1.0/tests/ --root strideroot
```
