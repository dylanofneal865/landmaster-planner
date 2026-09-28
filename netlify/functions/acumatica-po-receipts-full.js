// Thin wrapper — daily 06:15 UTC full sweep of the PO-receipts GI.
// Full mode: no OData $filter, walks the entire 180-day GI window,
// diffs against the scoped existing-row lookup, upserts changes.
// Always emits an audit row (see runReceiptsSync).
//
// All the real work lives in ./acumatica-po-receipts-sync.js; this
// wrapper only exists so netlify.toml can schedule it separately
// from the incremental cadence.

const { runReceiptsSync } = require("./acumatica-po-receipts-sync");

exports.handler = async () => runReceiptsSync("full");

// Failure note (Sep 28 2026): a thrown exception or a 5xx return writes
// sync_heartbeats.note = "ERROR <ts>: <reason>" under this name (last_ok
// untouched) so the Settings card shows WHY, not just "stale".
exports.handler = require("./_heartbeat.js").guard("acumatica-po-receipts-full", exports.handler);
