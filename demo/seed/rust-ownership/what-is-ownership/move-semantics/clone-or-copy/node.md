---
created: 2026-09-20T09:20:00.000Z
model: claude-sonnet-5
---
<!-- otago:user -->
When should I clone, and why do integers not move?

<!-- otago:assistant -->
Integers implement `Copy`: they are small, live entirely on the stack and own nothing, so duplicating their bits is cheap and safe. Assignment copies them instead of moving[^1].

| | `Copy` | `Clone` |
|---|---|---|
| How it happens | implicitly, on assignment | explicitly, `x.clone()` |
| Cost | a bitwise copy, always cheap | anything, may allocate |
| Examples | `i32`, `f64`, `bool`, `char`, `(i32, i32)` | `String`, `Vec<T>`, `HashMap<K, V>` |
| Can own heap memory | no | yes |

```rust
let a = 5;
let b = a;          // copied: both are usable
println!("{a} {b}");

let s = String::from("data");
let t = s.clone();  // deep copy: a second heap allocation
println!("{s} {t}");
```

**Clone when** you really need two independent values, for example to keep the original while a thread mutates its own copy. **Borrow instead** when you only need to read: `clone()` in a hot loop is a common performance smell.

**Exercise:** derive `Copy` for `struct Point { x: i32, y: i32 }`. Then add a `name: String` field. What does the compiler say?

[^1]: sources/rust-ownership-notes.md:20-22
