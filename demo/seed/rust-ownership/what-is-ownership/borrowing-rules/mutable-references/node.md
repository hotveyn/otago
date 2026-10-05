---
created: 2026-09-20T09:41:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
I attached my attempt. Why does Rust allow only one mutable reference at a time?

<!-- otago:assistant -->
Your `files/my-attempt.md` hits exactly this rule: `a` and `b` are both `&mut scores` and both stay alive until the `println!`.

The rule exists to rule out **data races at compile time**. A data race needs three things at once:

1. two pointers to the same data,
2. at least one of them writing,
3. no synchronization.

One `&mut` at a time removes the first condition whenever writing is involved[^1]. It also prevents subtler single-threaded bugs: a `Vec` that reallocates on `push` would leave another reference pointing at freed memory.

Fix your code by giving each borrow its own scope, or by finishing one before starting the next:

```rust
let mut scores = vec![10, 20];
{
    let a = &mut scores;
    a.push(30);
} // `a` ends here
let b = &mut scores;
b.push(40);
println!("{scores:?}"); // [10, 20, 30, 40]
```

**Exercise:** write a function `fn add_bonus(scores: &mut Vec<i32>, bonus: i32)` and call it twice in a row on the same vector. Why is that allowed?

[^1]: sources/rust-ownership-notes.md:27
