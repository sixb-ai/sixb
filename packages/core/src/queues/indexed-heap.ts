/** Internal mutable priority index. Updating or removing an entry never leaves stale copies. */
export class IndexedHeap<T> {
  private readonly items: T[] = []
  private readonly positions = new Map<T, number>()

  constructor(private readonly compare: (left: T, right: T) => number) {}

  peek(): T | undefined {
    return this.items[0]
  }

  pop(): T | undefined {
    const first = this.peek()
    if (first !== undefined) this.delete(first)
    return first
  }

  set(item: T): void {
    const index = this.positions.get(item)
    if (index === undefined) {
      this.positions.set(item, this.items.length)
      this.items.push(item)
      this.up(this.items.length - 1)
    } else {
      this.down(this.up(index))
    }
  }

  delete(item: T): void {
    const index = this.positions.get(item)
    if (index === undefined) return
    const last = this.items.pop()!
    this.positions.delete(item)
    if (index === this.items.length) return
    this.items[index] = last
    this.positions.set(last, index)
    this.down(this.up(index))
  }

  private up(start: number): number {
    let index = start
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.compare(this.items[parent]!, this.items[index]!) <= 0) break
      this.swap(parent, index)
      index = parent
    }
    return index
  }

  private down(start: number): void {
    let index = start
    while (index * 2 + 1 < this.items.length) {
      const left = index * 2 + 1
      const right = left + 1
      const child =
        right < this.items.length && this.compare(this.items[right]!, this.items[left]!) < 0
          ? right
          : left
      if (this.compare(this.items[index]!, this.items[child]!) <= 0) break
      this.swap(index, child)
      index = child
    }
  }

  private swap(left: number, right: number): void {
    const a = this.items[left]!
    const b = this.items[right]!
    this.items[left] = b
    this.items[right] = a
    this.positions.set(a, right)
    this.positions.set(b, left)
  }
}
