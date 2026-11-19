export class AsrGeneration {
  private value = 0

  begin(): number {
    return ++this.value
  }

  get currentId(): number {
    return this.value
  }

  current(generation: number): boolean {
    return generation === this.value
  }

  invalidate(): void {
    this.value++
  }
}
