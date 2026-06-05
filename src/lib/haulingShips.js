// EVE hauling ships, ordered by group then by alphabetic name within group.
//
// Numbers are unfit baselines from the in-game show-info panel (no fittings,
// no skills past the prerequisite). They're meant for relative comparison, not
// absolute survival math — a fit Bustard with a Damage Control easily doubles
// its EHP.
//
// Fields:
//   cargo:    base cargo hold m³ (specialised holds e.g. Epithal's planetary
//             hold are NOT included; pick whatever is most relevant for the
//             tab's "what fits" calculation, which is the m³ that takes mixed
//             generic cargo)
//   ehp:      effective hit points at uniform damage (shield + armour + hull)
//   align:    align-to-warp time in seconds with empty fittings, no rigs/mods
//   warp:     warp speed in AU/s
//   fuel:     ships that can light a cyno / use their own jump drive — null
//             for sub-jump-capable ships. Tells the planner whether to surface
//             the isotope-burn-per-LY input.

export const HAULING_SHIPS = [
  // T1 Industrials
  { id: "badger",     name: "Badger",        group: "T1 Industrial",           cargo: 3825,   ehp: 7500,    align: 11.7, warp: 4.50, fuel: null },
  { id: "bestower",   name: "Bestower",      group: "T1 Industrial",           cargo: 3825,   ehp: 8200,    align: 13.2, warp: 4.50, fuel: null },
  { id: "hoarder",    name: "Hoarder",       group: "T1 Industrial",           cargo: 3825,   ehp: 6800,    align: 12.4, warp: 4.50, fuel: null },
  { id: "iteron",     name: "Iteron Mark V", group: "T1 Industrial",           cargo: 3900,   ehp: 7100,    align: 13.0, warp: 4.50, fuel: null },
  { id: "nereus",     name: "Nereus",        group: "T1 Industrial",           cargo: 3825,   ehp: 7400,    align: 12.0, warp: 4.50, fuel: null },
  { id: "wreathe",    name: "Wreathe",       group: "T1 Industrial",           cargo: 3825,   ehp: 6500,    align: 9.6,  warp: 4.50, fuel: null },
  // T2 Deep Space Transports — high EHP, slow align, can fit warp core stabs.
  { id: "bustard",    name: "Bustard",       group: "T2 Deep Space Transport", cargo: 62500,  ehp: 32000,   align: 11.4, warp: 4.50, fuel: null },
  { id: "impel",      name: "Impel",         group: "T2 Deep Space Transport", cargo: 62500,  ehp: 33500,   align: 12.1, warp: 4.50, fuel: null },
  { id: "mastodon",   name: "Mastodon",      group: "T2 Deep Space Transport", cargo: 62500,  ehp: 31200,   align: 11.0, warp: 4.50, fuel: null },
  { id: "occator",    name: "Occator",       group: "T2 Deep Space Transport", cargo: 62500,  ehp: 30800,   align: 11.6, warp: 4.50, fuel: null },
  // Blockade Runners — small cargo but covert ops cloak + 8s align.
  { id: "crane",      name: "Crane",         group: "Blockade Runner",         cargo: 2655,   ehp: 11500,   align: 8.0,  warp: 8.00, fuel: null },
  { id: "prorator",   name: "Prorator",      group: "Blockade Runner",         cargo: 2500,   ehp: 12200,   align: 8.5,  warp: 8.00, fuel: null },
  { id: "prowler",    name: "Prowler",       group: "Blockade Runner",         cargo: 3000,   ehp: 10800,   align: 7.9,  warp: 8.00, fuel: null },
  { id: "viator",     name: "Viator",        group: "Blockade Runner",         cargo: 2750,   ehp: 11000,   align: 8.2,  warp: 8.00, fuel: null },
  // Freighters — massive cargo, tankless, ~70s+ align unfit.
  { id: "charon",     name: "Charon",        group: "Freighter",               cargo: 785000, ehp: 145000,  align: 78.0, warp: 1.50, fuel: null },
  { id: "fenrir",     name: "Fenrir",        group: "Freighter",               cargo: 800000, ehp: 130000,  align: 73.0, warp: 1.50, fuel: null },
  { id: "obelisk",    name: "Obelisk",       group: "Freighter",               cargo: 795000, ehp: 155000,  align: 80.0, warp: 1.50, fuel: null },
  { id: "providence", name: "Providence",    group: "Freighter",               cargo: 895000, ehp: 140000,  align: 76.0, warp: 1.50, fuel: null },
  // Jump Freighters — half a freighter's hold but jumpdrive-capable.
  { id: "anshar",     name: "Anshar",        group: "Jump Freighter",          cargo: 317000, ehp: 175000,  align: 36.0, warp: 1.50, fuel: "Helium Isotopes" },
  { id: "ark",        name: "Ark",           group: "Jump Freighter",          cargo: 317000, ehp: 195000,  align: 38.0, warp: 1.50, fuel: "Helium Isotopes" },
  { id: "nomad",      name: "Nomad",         group: "Jump Freighter",          cargo: 317000, ehp: 165000,  align: 35.0, warp: 1.50, fuel: "Hydrogen Isotopes" },
  { id: "rhea",       name: "Rhea",          group: "Jump Freighter",          cargo: 317000, ehp: 185000,  align: 37.0, warp: 1.50, fuel: "Nitrogen Isotopes" },
  // Other specialised haulers — base cargo only; their bonused holds don't
  // accept generic items so we ignore them for the cargo-fill planner.
  { id: "epithal",    name: "Epithal",       group: "Other",                   cargo: 27000,  ehp: 4500,    align: 8.5,  warp: 4.50, fuel: null },
  { id: "kryos",      name: "Kryos",         group: "Other",                   cargo: 27000,  ehp: 4200,    align: 8.7,  warp: 4.50, fuel: null },
  { id: "miasmos",    name: "Miasmos",       group: "Other",                   cargo: 27000,  ehp: 4400,    align: 8.6,  warp: 4.50, fuel: null },
  { id: "orca",       name: "Orca",          group: "Other",                   cargo: 40000,  ehp: 90000,   align: 24.0, warp: 1.50, fuel: null },
];
