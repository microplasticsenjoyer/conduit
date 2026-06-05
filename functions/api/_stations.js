// Trading hubs supported by Fuzzwork's /aggregates/ endpoint. The ID is the
// station's solarSystem-station composite (60xxxxxx range). Used by the
// appraise endpoint to value items against a hub other than Jita 4-4.

export const JITA_STATION = 60003760;

export const STATIONS = [
  { id: 60003760, name: "Jita 4-4",     region: "The Forge",      short: "Jita" },
  { id: 60008494, name: "Amarr VIII",   region: "Domain",         short: "Amarr" },
  { id: 60011866, name: "Dodixie IX-19", region: "Sinq Laison",   short: "Dodixie" },
  { id: 60005686, name: "Hek VIII-12",  region: "Metropolis",     short: "Hek" },
  { id: 60004588, name: "Rens VI-8",    region: "Heimatar",       short: "Rens" },
];

const STATION_IDS = new Set(STATIONS.map((s) => s.id));

export function isSupportedStation(id) {
  return STATION_IDS.has(id);
}

export function defaultStation() {
  return JITA_STATION;
}
