//! SuiPump Nexus Tools — HTTP tool servers for the Talus Nexus protocol.
//!
//! Five tools on one server:
//!   GET/POST /buy/        → xyz.suipump.buy@1
//!   GET/POST /sell/       → xyz.suipump.sell@1
//!   GET/POST /launch/     → xyz.suipump.launch@1
//!   GET/POST /claim/      → xyz.suipump.claim@1
//!   GET/POST /alerts/     → xyz.suipump.alerts@1
//!
//! Run: SUI_PRIVATE_KEY=<base64> cargo run --release

mod buy;
mod sell;
mod launch;
mod claim;
mod alerts;

use nexus_toolkit::bootstrap;

#[tokio::main]
async fn main() {
    env_logger::init();

    bootstrap!(
        ([0, 0, 0, 0], 8080),
        [
            buy::BuyTool,
            sell::SellTool,
            launch::LaunchTool,
            claim::ClaimTool,
            alerts::AlertsTool
        ]
    );
}
