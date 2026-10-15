---
created: 2026-09-20T09:47:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
Does the fix still work if I keep both pushes?

<!-- otago:assistant -->
Yes. The pushes were never the problem; the two borrows overlapping was. Your original code pushes through `a` and then through `b` while both are still alive[^1]. Keep the pushes and shorten the borrows instead:

```rust
let mut scores = vec![10, 20];
scores.push(30); // a temporary `&mut scores` that ends with the statement
scores.push(40); // another one, created after the first is gone
println!("{scores:?}"); // [10, 20, 30, 40]
```

Each method call borrows `scores` mutably only for the duration of the call, so the two borrows never overlap. If you really want named references, give each its own block as in the previous answer: the rule is about **lifetimes of borrows**, not about how many times you write[^2].

**Exercise:** keep `let a = &mut scores;` and `let b = &mut scores;` but move `a.push(30);` to the line right after `let a`. Does it compile now? Explain in terms of the last use of `a`.

[^1]: what-is-ownership/borrowing-rules/mutable-references/files/my-attempt.md:8-9 (both pushes)
[^2]: sources/rust-ownership-notes.md:27-29
