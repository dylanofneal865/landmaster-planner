// Thin wrapper — every-30-minute incremental sweep of the PO-receipts
// GI. Incremental mode adds an OData $filter (`Date ge datetimeoffset
// '...'`) with a 4-day lookback, so the wire response is usually a
// single short page. Diff still runs against a SCOPED existing-row
// lookup (only feed ids are queried), so cost is O(feedSize) not
// O(archiveSize).
//
// Audit rows are only written when the run actually changed data —
// see runReceiptsSync for the noise-suppression guard.

const { runReceiptsSync } = require("./acumatica-po-receipts-sync");

exports.handler = async () => runReceiptsSync("incremental");

// Failure note (Sep 28 2026): a thrown exception or a 5xx return writes
// sync_heartbeats.note = "ERROR <ts>: <reason>" under this name (last_ok
// untouched) so the Settings card shows WHY, not just "stale".
exports.handler = require("./_heartbeat.js").guard("acumatica-po-receipts-incremental", exports.handler);
