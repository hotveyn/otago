---
created: 2026-09-20T09:12:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
Why can't I use a String after assigning it to another variable?

<!-- otago:assistant -->
Because the assignment **moved** it. A `String` owns heap memory. If both variables owned that memory, both would free it at the end of the scope, which is a double free. So Rust transfers ownership and makes the old name unusable[^1].

```rust
let s1 = String::from("hello");
let s2 = s1;            // ownership moves to s2
println!("{s1}");       // error[E0382]: borrow of moved value: `s1`
```

The compiler explains it precisely:

```text
error[E0382]: borrow of moved value: `s1`
 --> src/main.rs:4:15
  |
2 | let s1 = String::from("hello");
  |     -- move occurs because `s1` has type `String`, which does not implement the `Copy` trait
3 | let s2 = s1;
  |          -- value moved here
4 | println!("{s1}");
  |           ^^^^ value borrowed here after move
```

Function calls move too:

```rust
fn shout(text: String) -> String {
    text.to_uppercase()
}

let word = String::from("hi");
let loud = shout(word); // `word` moved into `shout`
// `word` is unusable here, `loud` owns the result
```

You have three ways out: borrow (`&s1`), clone (`s1.clone()`), or restructure so only one variable needs the value.

**Exercise:** change `shout` to take `&str` so `word` stays usable after the call.

[^1]: sources/rust-ownership-notes.md:13-16
