// FW militia corporations with LP stores. Add more here to support them.
//
// Cross-faction filter:
//
//   ESI's loyalty-store endpoint returns items from other factions for some
//   militias (most egregiously the 24th Imperial Crusade, which returns ~90
//   Federation Navy items). To clean this up we tag each main FW corp with
//   its parent race and use that to filter offers in [corpId].js:
//
//     1. `ownNavyPrefixes` matches generic faction-named modules/charges
//        (e.g. "Federation Navy 100MN Afterburner") — these have an explicit
//        faction prefix in their item name.
//     2. `race` matches the named ship-hull faction variants (e.g. "Brutix
//        Navy Issue Blueprint") — the hull name itself encodes the faction
//        but ESI doesn't expose race_id on these types.
//
// Pirate FW militias have no race tag → unfiltered (their stores are clean).

export const LP_CORPS = {
  // Main Faction Warfare militias. ESI's loyalty store endpoint historically
  // mixed in cross-faction items; the filter below is kept as defense-in-depth
  // even though an audit (scripts/audit-lp-faction-filter.mjs, May 2026)
  // showed all four feeds are now clean upstream.
  1000179: {
    name: "24th Imperial Crusade",
    faction: "Amarr Empire",
    race: "Amarr",
    ownNavyPrefixes: ["Imperial Navy", "Khanid Navy", "Amarr Empire", "Amarr Navy", "Amarr"],
  },
  1000181: {
    name: "Federal Defence Union",
    faction: "Gallente Federation",
    race: "Gallente",
    ownNavyPrefixes: ["Federation Navy", "Federal Navy", "Gallente Federation", "Gallente"],
  },
  1000180: {
    name: "State Protectorate",
    faction: "Caldari State",
    race: "Caldari",
    ownNavyPrefixes: ["Caldari Navy", "Caldari State", "Caldari"],
  },
  1000182: {
    name: "Tribal Liberation Force",
    faction: "Minmatar Republic",
    race: "Minmatar",
    ownNavyPrefixes: ["Republic Fleet", "Minmatar Republic", "Minmatar"],
  },
  // Pirate Faction Warfare — leave unfiltered, no cross-faction navy issues.
  1000436: { name: "Malakim Zealots", faction: "Angel Cartel" },
  1000437: { name: "Commando Guri", faction: "Guristas Pirates" },
};

// Faction-named navy/empire prefixes used to detect cross-faction items.
// Longer/more-specific entries must come before the bare race name so the
// startsWith loop short-circuits on the most-specific match first.
const ALL_NAVY_PREFIXES = [
  "Imperial Navy",
  "Khanid Navy",
  "Amarr Empire",
  "Amarr Navy",
  "Amarr",           // catches "Amarr Listening Outpost", "Amarr Shuttle", etc.
  "Federation Navy",
  "Federal Navy",
  "Gallente Federation",
  "Gallente",        // catches "Gallente Battlecruiser" skills, etc.
  "Caldari Navy",
  "Caldari State",
  "Caldari",         // catches "Caldari Shuttle", etc.
  "Republic Fleet",
  "Minmatar Republic",
  "Minmatar",        // catches "Minmatar Shuttle", etc.
];

// Faction Navy / Fleet Issue ship hulls. The hull name itself encodes the
// race; the variant suffix is "<Hull> Navy Issue" for empire navies and
// "<Hull> Fleet Issue" for the Minmatar Republic Fleet.
const FACTION_HULLS = {
  Amarr: [
    "Apocalypse", "Armageddon", "Augoror", "Crucifier",
    "Maller", "Omen", "Punisher", "Tormentor",
  ],
  Gallente: [
    "Algos", "Atron", "Brutix", "Catalyst", "Comet",
    "Dominix", "Eos", "Exequror", "Hyperion", "Imicus",
    "Incursus", "Maulus", "Megathron", "Myrmidon",
    "Navitas", "Talos", "Thorax", "Tristan", "Vexor",
  ],
  Caldari: [
    "Caracal", "Cormorant", "Cruor", "Drake", "Heron",
    "Kestrel", "Merlin", "Moa", "Osprey", "Raven",
    "Scorpion",
  ],
  Minmatar: [
    "Bellicose", "Breacher", "Burst", "Hurricane",
    "Probe", "Rifter", "Rupture", "Scythe", "Slasher",
    "Stabber", "Talwar", "Tempest", "Typhoon", "Vigil",
  ],
};

const NAVY_VARIANT_SUFFIXES = [" Navy Issue", " Fleet Issue"];

export function isSupportedCorp(id) {
  return Object.prototype.hasOwnProperty.call(LP_CORPS, id);
}

export function isDisabledCorp(id) {
  return !!LP_CORPS[id]?.disabled;
}

// Returns true if `name` is from a faction that doesn't belong to this corp.
// Catches:
//   - faction-prefixed items: "Federation Navy 100MN Afterburner"
//   - faction-hull variants:  "Brutix Navy Issue [Blueprint]"
// Items with no faction marker (generic implants, skills, etc.) are kept.
export function isWrongFactionItem(corpId, name) {
  const corp = LP_CORPS[corpId];
  if (!corp || !name) return false;

  // 1. Faction navy prefix match.
  if (corp.ownNavyPrefixes) {
    for (const prefix of ALL_NAVY_PREFIXES) {
      if (!name.startsWith(prefix)) continue;
      return !corp.ownNavyPrefixes.some((own) => name.startsWith(own));
    }
  }

  // 2. Faction-hull variant match: "<Hull> Navy Issue" or "<Hull> Fleet Issue".
  if (corp.race) {
    for (const [race, hulls] of Object.entries(FACTION_HULLS)) {
      if (race === corp.race) continue; // own faction's hulls are fine
      for (const hull of hulls) {
        for (const suffix of NAVY_VARIANT_SUFFIXES) {
          const variant = hull + suffix;
          // Match "<Hull> Navy Issue" exactly or as a prefix (e.g. "… Blueprint").
          if (name === variant || name.startsWith(variant + " ")) return true;
        }
      }
    }
  }

  return false;
}
