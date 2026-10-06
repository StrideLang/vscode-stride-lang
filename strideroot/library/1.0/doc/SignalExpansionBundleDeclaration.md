# Specification: Schema-Driven Expansion for Bundle Declarations

## 1. Overview
In **Stride**, a bundle represents a statically allocated array of $N$ instances of the same type. 

When assigning property values to a signal bundle, Stride utilizes schema type constraints to determine whether an assigned list literal represents an expansion dimension or an atomic property value. This framework resolves expansion ambiguity deterministically without additional syntax. During any expansion operation, the compiler strictly validates the types of the individual elements being mapped to the target signals to ensure memory layout and execution safety.

## 2. Definitions and Terminology

* **Bundle Array ($B$):** A statically allocated array of $N$ identical signal instances, where $N = \text{length}(B)$. 
* **Target Field ($P$):** A property defined within the signal's schema that accepts a specific type signature: a Scalar, a $\text{List}[T]$ (where $T$ is the constituent type), or a Union of both ($\text{Scalar} \cup \text{List}[T]$).
* **Assigned Value ($V$):** The literal expression passed to the field, categorized by its list nesting Rank:
  * $R_0$: An atomic scalar value.
  * $R_1$: A flat 1D list (e.g., `[a, b, c]`).
  * $R_2$: A nested list of lists (e.g., `[[a, b], [c, d]]`).

## 3. Expansion and Validation Rules

The schema definition of the target field governs the interpretation of incoming values, prioritizing deterministic evaluation based on the structural constraints of the schema.

### Rule 1: Scalar Schema
When the target field strictly expects a Scalar value:
* **Assignment is a Scalar ($R_0$):** The value is evaluated as an atomic property and **cloned** identically across all $N$ signals. 
* **Assignment is a Flat List ($R_1$):** Triggers an **expansion** directive. 
  * *Constraint:* The list length $K$ must exactly equal the bundle size $N$. 
  * *Type Validation:* The compiler strictly validates that every element $V[i]$ in the list matches the target scalar type before assigning it to signal $i$.
* **Assignment is a Nested List ($R_2$):** Results in a static compile-time dimension and type error.

### Rule 2: List Schema ($\text{List}[T]$)
When the target field expects a collection of elements of type $T$:
* **Assignment is a Flat List ($R_1$):** Evaluated as an atomic single value and **cloned** identically across all $N$ signals, regardless of the list's length. 
* **Assignment is a List of Lists ($R_2$):** Triggers an **expansion** directive. 
  * *Constraint:* The outer list length $K$ must equal the bundle size $N$. 
  * *Type Validation:* The compiler validates that the elements within each inner list $V[i]$ strictly conform to type $T$ before the inner list is mapped to signal $i$.

### Rule 3: Union Schema ($\text{Scalar} \cup \text{List}[T]$)
When the target field polymorphically accepts either a single element or a list:
* **Assignment is a Flat List ($R_1$):** Resolves directly to the list variant of the schema. It is **cloned** as an atomic value to all $N$ signals, prioritizing value semantics over expansion to prevent ambiguity. 
* **Assignment is a List of Lists ($R_2$):** Triggers an **expansion** directive. 
  * *Constraint:* The outer length $K$ must equal the bundle size $N$. 
  * *Type Validation:* The compiler validates that the expanded inner lists satisfy the schema type constraints for $T$ before assigning to signal $i$.

## 4. Expansion Resolution Matrix

| Schema Expectation | Assigned Value Rank | Evaluated Behavior | Validation Constraints |
| :--- | :--- | :--- | :--- |
| **Scalar** | $R_0$ (Atom) | **Cloned** | Validates as matching scalar type. |
| **Scalar** | $R_1$ (Flat List) | **Expanded** | List length must equal $N$; elements validated as matching scalar type. |
| **List** | $R_1$ (Flat List) | **Cloned** | Elements validated as matching type $T$. |
| **List** | $R_2$ (List of Lists) | **Expanded** | Outer list length must equal $N$; inner elements validated as matching type $T$. |
| **Union** | $R_1$ (Flat List) | **Cloned** | Satisfies list branch natively; elements validated as matching type $T$. |
| **Union** | $R_2$ (List of Lists) | **Expanded** | Outer list length must equal $N$; inner elements validated as matching type $T$. |