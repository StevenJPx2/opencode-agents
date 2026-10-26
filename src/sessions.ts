type ListInput = { readonly parentID?: string; readonly cursor?: string; readonly limit: number }
type Page<T> = { readonly data: ReadonlyArray<T>; readonly cursor: { readonly next?: string | null | undefined } }

/** Follow every page so all spawned agents remain addressable, not just the first 100. */
export async function listChildren<T>(list: (input: ListInput) => Promise<Page<T>>, parentID: string): Promise<T[]> {
  const children: T[] = []
  let page = await list({ parentID, limit: 100 })

  for (;;) {
    children.push(...page.data)

    if (!page.cursor.next) return children

    // The cursor remembers the parent filter.
    page = await list({ cursor: page.cursor.next, limit: 100 })
  }
}
