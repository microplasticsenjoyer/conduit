// GET /api/stations
// Returns the trading hubs the appraiser supports.

import { STATIONS, JITA_STATION } from "./_stations.js";

export function onRequestGet() {
  return new Response(
    JSON.stringify({ stations: STATIONS, default: JITA_STATION }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400",
      },
    }
  );
}
