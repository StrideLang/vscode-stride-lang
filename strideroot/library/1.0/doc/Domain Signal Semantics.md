# Technical Specification: Cross-Domain Interconnect & Signal Semantics in Stride

## 1. System Overview
In Stride, a system consists of **Domains** (computational execution contexts) and **Signals** (stateful storage allocations or stream endpoints). Domains manage resource boundaries (execution rate, target thread, hardware core, address space, platform). The Stride code generator transparently synthesizes the data movement, rate matching, memory layout, and synchronization shims required to connect signals across domain boundaries.

---

## 2. Signal Attributes & Execution Semantics

A signal declaration establishes memory residency and processing behavior.

### 2.1 Domain Binding & Memory Residency
* **Explicit Binding (`signal.domain: D`):** Memory is allocated inside Domain $D$'s scope. Primary state mutations occur exclusively within Domain $D$. External reads/writes generate boundary shims.
<!-- * **Implicit / Lexical Binding:** Variables declared inside a block or stream without explicit domain annotations inherit the enclosing domain's scope and instance struct. -->
* **Interface Signals (`Domain.input`, `Domain.output`):** Allocated in the parent/system environment and passed as reference parameters into the domain's initialization and processing functions.

### 2.2 Rate Semantics ($R_{\text{sig}}$ vs. $R_{\text{domain}}$)
* **Native Rate ($R_{\text{sig}} = R_{\text{domain}}$):** Evaluated once per tick of the host domain. Direct register or struct access.
* **Downsampled ($R_{\text{sig}} < R_{\text{domain}}$):** The host domain runs faster than the signal.
  * *Decimation / Latch:* Values are sampled every $M$ ticks via a compile-time modulo counter or tick divider.
  * *Aggregation:* Intermediate samples are accumulated/averaged across the window before committing to persistent storage.
* **Upsampled ($R_{\text{sig}} > R_{\text{domain}}$):** The signal runs faster than the host domain.
  * *Zero-Order Hold (ZOH):** The host value is latched and held across sub-cycles.
  * *Linear / Polynomial Interpolation:* The shim calculates intermediate steps across domain ticks.
* **Fractional / Non-Harmonic Rates:** Handled via asynchronous ring buffers with jitter compensation.

### 2.3 Temporal Driving Modes
* **Periodic (Clock-Driven / Pull):** Evaluated deterministically on the domain’s tick schedule. Unwritten streams maintain their previous persistent state ($z^{-1}$).
* **Reactive (Push / Stream-Driven):** Execution is triggered by stream writes rather than a fixed clock.
  * *Any-Stream Trigger:* Processes immediately upon arrival of an update from any inbound stream.
  * *Barrier Trigger:* Waits until all converging inputs have delivered a sample before evaluating.
  * *Reaction Callback:* Cross-boundary reactive writes invoke a target `Reaction` handler.
* **Latched State (Passive):** Holds state without continuous processing; atomically updated on write, read asynchronously on demand.

---

## 3. Cross-Domain Interconnect Hierarchy

The compiler selects the interconnect mechanism by evaluating the architectural boundary between the source and destination domains:

Cross-Domain Interconnect
├── Level 1: Intra-Thread (Shared Address Space, Single Thread)
├── Level 2: Inter-Thread (Shared Address Space, Concurrent Threads/Tasks)
├── Level 3: Inter-Process / Heterogeneous Cores (Single Silicon, Boundary Enforced)
└── Level 4: Distributed / Inter-Platform (Distinct Silicon / Network)


### Level 1: Intra-Thread / Non-Concurrent Execution
Both domains share the same thread, call stack, and memory space. Execution is non-preemptive.
* **Same Rate:** Direct pointer access, stack parameter passing (`alloca`), or register transfer.
* **Multi-Rate Sibling Domains:** Direct struct reads with compiler-generated decimation or interpolation logic.
* **Reactive Invocation:** Synchronous function call or inline reaction callback execution.

### Level 2: Inter-Thread / Concurrent Execution (Same Process Space)
Domains run on separate OS threads (POSIX/pthreads) or RTOS tasks (e.g., FreeRTOS via `pw_thread`) with cache-coherent shared memory.
* **Lossless Streaming:** Lockless Single-Producer Single-Consumer (SPSC) ring buffers.
* **Latest-Wins / State Latching:** Atomic double-buffering or pointer ping-ponging with memory barriers (`std::atomic`).
* **Event / Reactive Trigger:** Thread signaling via counting semaphores, condition variables, or mutexes (e.g., `pw_sync`).

### Level 3: Inter-Process & Heterogeneous Cores (Single Board / SoC)
Domains run across MMU process boundaries, hypervisors, or heterogeneous cores (e.g., Cortex-A host + Cortex-M RTOS + NPU/DSP).
* **OS Inter-Process (IPC):** POSIX shared memory (`shm_open`, `mmap`) synchronized via eventfds or IPC semaphores.
* **Heterogeneous Cores (AMP):** Statically allocated, physically contiguous SRAM/DMA buffers with explicit cache invalidate/flush instructions.
* **Signaling:** Hardware mailboxes or Inter-Processor Interrupts (IPI) for reactive events.
* **Structured RPC:** Pigweed RPC operating over a zero-copy shared memory transport.

### Level 4: Inter-Platform / Distributed (Hardware Boundary)
Domains reside on separate microcontrollers, peripheral chips, or network-attached systems.
* **Peripheral Bus (Cross-Chip):** UART, SPI, I2C, CAN, or PCIe. Data serialized via Protocol Buffers into compact payloads.
* **Network / Remote (Distributed):** Ethernet, Wi-Fi, BLE, TCP/UDP. Remote Procedure Calls (Pigweed RPC, gRPC) with automated throttling and block batching to prevent channel saturation.

---

## 4. Compiler Code Generation & Inference Matrix

| Boundary Level | Concurrency | Signal Type | Code Generation Strategy | Transport Mechanism |
| :--- | :--- | :--- | :--- | :--- |
| **Intra-Thread** | Sequential | Periodic (Same Rate) | Inline assignment / GEP access | Direct memory / Register |
| **Intra-Thread** | Multi-Rate | Periodic (Harmonic) | Modulo counter + decimation / ZOH hold | Local instance struct member |
| **Intra-Thread** | Sequential | Reactive | Direct function / Reaction invocation | Stack / Call parameters |
| **Inter-Thread** | Preemptive | Streaming Data | Non-blocking SPSC FIFO | Lockless circular buffer |
| **Inter-Thread** | Preemptive | Latched State | Atomic pointer swap / Double-buffer | Cache-coherent RAM |
| **Inter-Thread** | Preemptive | Reactive | Wake target task via semaphore / queue | RTOS task notification |
| **Heterogeneous** | Hardware AMP | Streaming Data | Contiguous physical buffer + cache sync | Shared SRAM / DMA |
| **Heterogeneous** | Hardware AMP | Reactive | Core interrupt + shared descriptor mailbox | Hardware Mailbox / IPI |
| **Inter-Platform**| Asynchronous| Continuous Stream| Serializer + windowed packet batching | Bus stream (SPI/UART/CAN) |
| **Inter-Platform**| Asynchronous| Reactive / RPC | Protobuf serialization + RPC service call | Network / Bus RPC channel |

---

## 5. Invariant Code-Gen Constraints
1. **Static Memory Allocation:** Persistent state structs are sized and allocated at compile time; runtime heap allocations (`malloc`) are forbidden inside real-time domain loops.
2. **Def-Use State Deduction:** Read-before-write access within a procedural stream guarantees emission into the domain’s persistent instance struct as a $z^{-1}$ delay.
3. **Target Transparency:** Algorithmic stream expressions remain identical regardless of whet