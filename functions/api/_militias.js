// EVE faction-warfare militias plus the two pirate insurgency factions. Used
// by the sync engine, the admin role-map editor, and the Profile tab. The
// pirate factions aren't FW militias strictly speaking, but EVE exposes them
// the same way (a character's faction_id) and we map them through the same
// table.
export const MILITIAS = {
  500001: "Caldari State",
  500002: "Minmatar Republic",
  500003: "Amarr Empire",
  500004: "Gallente Federation",
  500010: "Guristas Pirates",
  500011: "Angel Cartel",
};

export const MILITIA_FACTION_IDS = Object.keys(MILITIAS).map((s) => Number(s));
