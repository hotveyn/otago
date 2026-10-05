---
created: 2026-09-20T09:30:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
How do references and borrowing work?

<!-- otago:assistant -->
A reference lets code **use** a value without taking ownership. The owner keeps the value; the borrower gets temporary access and must give it back before the owner is gone[^1].

```rust
fn length(text: &String) -> usize { // borrows, does not own
    text.len()
}

let name = String::from("Otago");
let n = length(&name); // lend `name` for the call
println!("{name} has {n} letters"); // still usable: it was only borrowed
```

There are two kinds of reference, and the rule between them is strict: **many readers or one writer, never both**.

![Borrowing rules](attachments/borrow-rules.csv)

The compiler checks this at every point of the program. Since Rust 2018 a borrow ends at its last use, not at the closing brace[^2]. So this compiles:

```rust
let mut v = vec![1, 2, 3];
let first = &v[0];
println!("{first}"); // last use of `first`: the shared borrow ends here
v.push(4);           // so a mutable borrow is fine now
```

**Exercise:** move the `println!` below `v.push(4)`. Read the error and explain which rule it breaks.

[^1]: sources/rust-ownership-notes.md:26-28
[^2]: sources/rust-ownership-notes.md:29
