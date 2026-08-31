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
