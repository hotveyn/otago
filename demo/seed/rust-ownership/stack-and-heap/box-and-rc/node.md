---
created: 2026-09-20T10:22:00.000Z
model: claude-opus-5-5
---
<!-- otago:user -->
When do I need Box or Rc?

<!-- otago:assistant -->
Both put a value on the heap. The difference is **how many owners** it can have[^1].

- `Box<T>`: one owner. Use it for recursive types, large values you want to move cheaply, or trait objects (`Box<dyn Shape>`).
- `Rc<T>`: several owners, counted at run time. The value is dropped when the last `Rc` goes away. Single thread only; use `Arc<T>` across threads.

```rust
use std::rc::Rc;

enum List {
    Cons(i32, Box<List>), // recursive type: Box gives it a known size
    Nil,
}

let shared = Rc::new(String::from("config"));
let a = Rc::clone(&shared); // count = 2, no deep copy
let b = Rc::clone(&shared); // count = 3
println!("{}", Rc::strong_count(&shared)); // 3
```

`Rc::clone` only increments a counter, so it is cheap, unlike `String::clone`.

**Exercise:** wrap the `String` in `Rc<RefCell<String>>` and append to it through `a`. What does `RefCell` add that `Rc` alone does not?

[^1]: sources/rust-ownership-notes.md:40-41
