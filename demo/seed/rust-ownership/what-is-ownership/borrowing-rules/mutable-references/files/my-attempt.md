# My attempt

```rust
fn main() {
    let mut scores = vec![10, 20];
    let a = &mut scores;
    let b = &mut scores;
    a.push(30);
    b.push(40);
    println!("{:?}", scores);
}
```

Error: `cannot borrow scores as mutable more than once at a time`. Why?
