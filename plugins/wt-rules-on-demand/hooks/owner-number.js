// Collision-avoidance identifiers only, never credentials or authorization tokens.
// Callers supply the draw so registration and module reloads retain their existing generator and test seam.
export const ownerNumber = (bits, draw) => Math.floor(draw() * 2 ** bits);
