// Blueprint recipe resolver — cache-first against Fuzzwork's blueprint API.
//
// LP-store ship/module Blueprints (BPCs) sell for almost nothing on the
// market, but the manufactured product (e.g. Osprey Navy Issue) sells well.
// To show real profitability we need the BoM and product type for each BPC.
//
// Source: https://www.fuzzwork.co.uk/blueprint/api/blueprint.php?typeid=<bpcTypeId>
// Returns blueprintDetails.{productTypeID, productQuantity} and
// activityMaterials["1"] (manufacturing materials). LP-store BPCs are ME0/TE0,
// so we use the raw quantities without reduction.

const FUZZWORK_BP_BASE = "https://www.fuzzwork.co.uk/blueprint/api/blueprint.php";
const RECIPE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const FETCH_CONCURRENCY = 5;

// Each uncached BPC costs 1 Fuzzwork subrequest. A FW militia LP store has
// ~40 BPCs; without a cap a cold load blows past Cloudflare's 50-subrequest
// limit (combined with names/prices/categories). Cap per request so cold
// loads stay well under the budget; the 30-day cache fills in over a few
// visits, after which subsequent loads fetch nothing.
const MAX_BLUEPRINT_FETCHES = 12;

// Returns { [blueprintTypeId]: { productTypeId, productQuantity, materials: [{type_id, quantity}, ...] } }.
// Skips entries the API doesn't have a manufacturing recipe for (e.g. T2 BPCs
// requiring invention, or items Fuzzwork doesn't cover).
export async function resolveBlueprintRecipes(db, blueprintTypeIds) {
  if (blueprintTypeIds.length === 0) return {};

  const { data: cached } = await db
    .from("blueprint_cache")
    .select("blueprint_type_id, product_type_id, product_quantity, materials, updated_at")
    .in("blueprint_type_id", blueprintTypeIds);

  const recipes = {};
  const stale = new Set();
  const now = Date.now();

  for (const row of cached ?? []) {
    if (now - new Date(row.updated_at).getTime() < RECIPE_TTL_MS) {
      recipes[row.blueprint_type_id] = {
        productTypeId: row.product_type_id,
        productQuantity: row.product_quantity,
        materials: row.materials ?? [],
      };
    } else {
      stale.add(row.blueprint_type_id);
    }
  }

  const missing = blueprintTypeIds.filter((id) => !(id in recipes));
  const toFetch = [...new Set([...missing, ...stale])].slice(0, MAX_BLUEPRINT_FETCHES);
  if (toFetch.length === 0) return recipes;

  const fresh = await fetchRecipesFromFuzzwork(toFetch);
  const upsertRows = [];
  for (const [bpIdStr, recipe] of Object.entries(fresh)) {
    const blueprintTypeId = parseInt(bpIdStr, 10);
    recipes[blueprintTypeId] = recipe;
    upsertRows.push({
      blueprint_type_id: blueprintTypeId,
      product_type_id: recipe.productTypeId,
      product_quantity: recipe.productQuantity,
      materials: recipe.materials,
      updated_at: new Date().toISOString(),
    });
  }
  if (upsertRows.length > 0) {
    await db.from("blueprint_cache").upsert(upsertRows, { onConflict: "blueprint_type_id" });
  }
  return recipes;
}

async function fetchRecipesFromFuzzwork(typeIds) {
  const out = {};
  let cursor = 0;
  async function worker() {
    while (cursor < typeIds.length) {
      const id = typeIds[cursor++];
      try {
        const res = await fetch(`${FUZZWORK_BP_BASE}?typeid=${id}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
          console.warn(`[blueprints:fuzzwork] HTTP ${res.status} typeID=${id}`);
          continue;
        }
        const data = await res.json();
        const productTypeId = data?.blueprintDetails?.productTypeID;
        const productQuantity = data?.blueprintDetails?.productQuantity;
        const mats = data?.activityMaterials?.["1"];
        if (!productTypeId || !productQuantity || !Array.isArray(mats) || mats.length === 0) continue;
        // Querying by BPC vs product typeid both yield the same product/materials —
        // skip cases where Fuzzwork echoes the input typeid as the product (no real
        // BPC exists for it).
        if (productTypeId === id) continue;
        out[id] = {
          productTypeId,
          productQuantity,
          materials: mats.map((m) => ({ type_id: m.typeid, quantity: m.quantity })),
        };
      } catch (err) {
        console.warn(`[blueprints:fuzzwork] ${err.name === "TimeoutError" ? "timeout" : err.message} typeID=${id}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, typeIds.length) }, worker));
  return out;
}
