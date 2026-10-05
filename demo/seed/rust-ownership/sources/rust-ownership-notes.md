# Rust ownership: study notes

## 1. The three rules

1. Every value has exactly one owner: the variable that holds it.
2. There is one owner at a time. Assigning or passing a value moves ownership.
3. When the owner goes out of scope, the value is dropped and its memory is freed.

No garbage collector runs. The compiler inserts the `drop` calls at the end of each scope.

## 2. Moves

- Assigning a heap-owning value (`String`, `Vec<T>`, `Box<T>`) to another variable moves it.
- After a move the old variable is unusable: the compiler reports error E0382, "borrow of moved value".
- Passing a value to a function moves it into the function's parameter.
- Returning a value moves it out to the caller.

## 3. Copy and Clone

- Types that are `Copy` are duplicated bit by bit instead of moved: integers, floats, `bool`, `char`, and tuples or arrays of `Copy` types.
- A type can be `Copy` only if it owns no heap memory and has no custom `Drop`.
- `clone()` makes an explicit deep copy. It may allocate, so it is visible in the code on purpose.

## 4. Borrowing

- `&T` is a shared reference: read-only, any number at once.
- `&mut T` is a mutable reference: exactly one at a time, and no shared references alongside it.
- A reference must never outlive the value it points to.
- Since Rust 2018, non-lexical lifetimes (NLL) end a borrow at its last use, not at the end of the scope.

## 5. Dangling references

- Returning a reference to a local variable is rejected (error E0106, "missing lifetime specifier").
- Fix: return the owned value itself and let the caller own it.

## 6. Stack and heap

- Fixed-size values live on the stack; growable data (`String`, `Vec`) lives on the heap behind a pointer stored on the stack.
- A `String` on the stack is three words: pointer, length, capacity.
- `Box<T>` puts a single value on the heap with one owner.
- `Rc<T>` counts references so several owners can share one value (single thread only; `Arc<T>` for threads).
