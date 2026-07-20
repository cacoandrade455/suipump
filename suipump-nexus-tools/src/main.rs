//! SuiPump Nexus Tools — HTTP tool servers for the Talus Nexus protocol.
//!
//! One tool on one server (buy/sell/launch/claim were removed in the JSON-RPC
//! purge, 2026-07-20: execution is bridge-direct; the Nexus/Leader path is
//! scoped out of v1):
//!   GET/POST /alerts/     → xyz.suipump.alerts@1
//!
//! Run: cargo run --release

mod alerts;

use nexus_toolkit::bootstrap;

#[tokio::main]
async fn main() {
    env_logger::init();

    bootstrap!(([0, 0, 0, 0], 8080), [alerts::AlertsTool]);
}
