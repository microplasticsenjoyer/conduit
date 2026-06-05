// Alt-account → main-account mapping for the Corp Projects LP leaderboard.
//
// EVE's API can't tell us who owns which alt, so this list is maintained by
// hand. Every entry maps one *alt* character to the *main* it should be
// credited under: the alt's LP (and the ISK it earned) folds into the main's
// totals, and the alt itself is hidden from the leaderboard.
//
// ── Format ──────────────────────────────────────────────────────────────────
// One entry per alt, keyed by the alt's character ID:
//
//   [<alt characterId>]: { mainId: <main characterId>, mainName: "<Main's name>" },
//
//   • key       — the ALT's character ID (the farming-alt name EVE shows).
//   • mainId    — the main account's character ID. Use the same mainId for all
//                 of one person's alts so they merge into a single row. If the
//                 main also contributes under its own name, that's the ID to use.
//   • mainName  — the name to show on the leaderboard. Recommended even if the
//                 main contributes directly (so the label is stable). Use the
//                 same mainName for all of that person's alts.
//
// Finding a character ID: open the pilot on https://evewho.com (or zKillboard),
// or read it off the portrait URL the leaderboard already uses —
// https://images.evetech.net/characters/<ID>/portrait
//
// ── Examples ────────────────────────────────────────────────────────────────
// (the leading `//` makes these comments — delete it to activate a real entry)
//
//   // "Mining Alt Bob" (94000111) and "Mining Alt Bob 2" (94000222) are both
//   // John Capsuleer (90000001), who also farms LP on his main:
//   94000111: { mainId: 90000001, mainName: "John Capsuleer" },
//   94000222: { mainId: 90000001, mainName: "John Capsuleer" },
//
//   // "FarmAlt Zeta" (94000333) belongs to Jane Pilot (90000002), who never
//   // contributes under her own name — mainName is what the board will show:
//   94000333: { mainId: 90000002, mainName: "Jane Pilot" },

export const ALT_TO_MAIN = {
  // Add entries here — see the examples above for the format.

  // Brinton Anzomi (2113662924) — his alts fold into his leaderboard row:
  2115062964: { mainId: 2113662924, mainName: "Brinton Anzomi" }, // Spitfire1938
  2116542200: { mainId: 2113662924, mainName: "Brinton Anzomi" }, // Harvey Ster

  // Mavin Tivianne (93727434) — his alts fold into his leaderboard row:
  94190785: { mainId: 93727434, mainName: "Mavin Tivianne" }, // Vanna Molou

  // Bukariin (90050598) — his alts fold into his leaderboard row:
  2054652051: { mainId: 90050598, mainName: "Bukariin" }, // Bukariin Semshan

  // Epictetus Sato (95186066) — his alts fold into his leaderboard row:
  2122087535: { mainId: 95186066, mainName: "Epictetus Sato" }, // Isra bint Asami
};

// Resolves a contributor to the identity that should appear on the leaderboard.
// Returns { id, name, isAlt }: unchanged (isAlt=false) for a main or any
// character not in the map, or the mapped main (isAlt=true) for a known alt.
export function resolveMain(characterId, characterName) {
  const link = ALT_TO_MAIN[characterId];
  if (!link) return { id: characterId, name: characterName, isAlt: false };
  return { id: link.mainId, name: link.mainName ?? characterName, isAlt: true };
}
