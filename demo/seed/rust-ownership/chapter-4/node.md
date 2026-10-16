---
created: 2026-09-20T10:30:00.000Z
model: claude-opus-5-5
suggestions: [{"text":"Explain the first part of chapter 4: what ownership is","up":0},{"text":"Explain the second part of chapter 4: references and borrowing","up":0},{"text":"Explain the third part of chapter 4: mutable and dangling references","up":0},{"text":"Explain all of chapter 4 in one answer, without splitting it","up":1,"kind":"whole"}]
---
<!-- otago:user -->
Walk me through chapter 4 of the Rust book

<!-- otago:assistant -->
Chapter 4 is too big for one answer, so here is its map. It has three parts, in the order to learn them:

1. **What ownership is**: the three rules and how a `String` frees its memory[^1].
2. **References and borrowing**: using a value without taking ownership of it[^2].
3. **Mutable and dangling references**: the one-writer rule and references that outlive their value[^3].

Pick a part below to start, or ask for the whole chapter in one answer.

[^1]: sources/rust-book-ch04-ownership.pdf:2 (4.1 What Is Ownership?)
[^2]: sources/rust-book-ch04-ownership.pdf:3 (4.2 References and Borrowing)
[^3]: sources/rust-book-ch04-ownership.pdf:4 (mutable and dangling references)
