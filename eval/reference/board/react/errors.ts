export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * An error that belongs to one selection of a card (`visit` counts selections): selecting a card, even the same one
 * again, leaves it behind, and a write that answers after its selection was left reports nothing.
 */
export type VisitError = { visit: number; message: string };

export const errorIn = (e: VisitError | null, visit: number) => (e && e.visit === visit ? e.message : null);
