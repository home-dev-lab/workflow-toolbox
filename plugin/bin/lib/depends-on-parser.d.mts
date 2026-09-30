export interface DependsOnParse {
  ids: string[]
  unparseable: string[]
}

export interface TriageCard {
  id: string
  description?: string | null | undefined
}

export interface DependencyTriage<T extends TriageCard> {
  recommendable: T[]
  notChecked: T[]
  blocked: T[]
}

export function hasDependsOnLine(description: string | null | undefined): boolean
export function parseDependsOn(description: string | null | undefined): DependsOnParse
export function triageCardDependencies<T extends TriageCard>(
  cards: readonly T[],
  doneIds: Iterable<string>,
  resolveDeps?: (description: string) => DependsOnParse,
): DependencyTriage<T>
