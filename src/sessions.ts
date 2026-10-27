type ListInput = { readonly project?: string; readonly cursor?: string; readonly limit: number }
type Page<T> = { readonly data: ReadonlyArray<T>; readonly cursor: { readonly next?: string | null | undefined } }

/** Follows every page so all agents remain addressable, not just the first 100 sessions. */
export async function listSessions<T>(list: (input: ListInput) => Promise<Page<T>>, projectID: string | undefined): Promise<T[]> {
  const sessions: T[] = []
  let page = await list(projectID === undefined ? { limit: 100 } : { project: projectID, limit: 100 })

  for (;;) {
    sessions.push(...page.data)

    if (!page.cursor.next) return sessions

    // The cursor remembers the project filter.
    page = await list({ cursor: page.cursor.next, limit: 100 })
  }
}
