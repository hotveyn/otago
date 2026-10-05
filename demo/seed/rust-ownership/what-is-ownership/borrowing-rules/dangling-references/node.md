---
created: 2026-09-20T09:52:00.000Z
model: claude-haiku-4-5
---
<!-- otago:user -->
How does Rust prevent dangling references?

<!-- otago:assistant -->
A dangling reference points to memory that was already freed. Rust rejects any reference that could outlive its value[^1]. This does not compile:

```rust
fn dangle() -> &String {           // error[E0106]: missing lifetime specifier
    let s = String::from("temp");
    &s                             // `s` is dropped when the function returns
}
```

The fix is to return the owned value and let the caller own it:

```rust
fn no_dangle() -> String {
    String::from("temp") // ownership moves out to the caller
}
```

**Exercise:** write `fn longest(a: &str, b: &str) -> &str`. The compiler asks for a lifetime parameter. Add `'a` and explain what it promises.

[^1]: sources/rust-ownership-notes.md:33-34
