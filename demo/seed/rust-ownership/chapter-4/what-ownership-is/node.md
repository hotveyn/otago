---
created: 2026-09-20T10:36:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
Explain the first part of chapter 4: what ownership is

<!-- otago:assistant -->
Ownership is how Rust frees memory without a garbage collector, and three rules cover it[^1].

1. Every value has exactly one owner, the variable that holds it.
2. There is one owner at a time. Assigning or passing the value moves ownership.
3. When the owner goes out of scope, the value is dropped and its memory is freed.

A `String` shows all three. Its text lives on the heap, and the variable `s` owns it:

```rust
fn main() {
    {
        let s = String::from("hello"); // s owns the heap text
        println!("{s}");
    } // s goes out of scope: Rust calls drop and frees the text
    // println!("{s}"); // error: s is not in scope here
}
```

The compiler inserts the `drop` call at the closing brace, so the memory is freed exactly once and never used after that[^2].

**Exercise:** inside the inner block, add `let t = s;` and then try to print `s`. Which rule does the compiler error point at?

[^1]: sources/rust-ownership-notes.md:5-9
[^2]: sources/rust-book-ch04-ownership.pdf:2 (4.1 What Is Ownership?)
