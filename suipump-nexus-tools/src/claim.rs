use {
    anyhow::Result as AnyResult,
    nexus_sdk::{fqn, ToolFqn},
    nexus_toolkit::NexusTool,
    schemars::JsonSchema,
    serde::{Deserialize, Serialize},
    warp::http::StatusCode,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct ClaimInput {
    pub curve_id: String,
    pub token_type: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum ClaimOutput {
    Ok { tx_digest: String, sui_claimed: f64 },
    Empty {},
    Err { reason: String },
}

pub struct ClaimTool;

impl NexusTool for ClaimTool {
    type Input  = ClaimInput;
    type Output = ClaimOutput;
    async fn new() -> Self { Self }
    fn fqn() -> ToolFqn { fqn!("xyz.suipump.claim@2") }
    fn path() -> &'static str { "claim" }
    fn description() -> &'static str { "Claim pending creator fees from a SuiPump curve. Returns Empty if no fees pending." }
    async fn health(&self) -> AnyResult<StatusCode> { Ok(StatusCode::OK) }
    async fn invoke(&self, input: ClaimInput) -> ClaimOutput {
        match execute_claim(input).await {
            Ok(o) => o,
            Err(e) => ClaimOutput::Err { reason: e.to_string() },
        }
    }
}

async fn execute_claim(input: ClaimInput) -> AnyResult<ClaimOutput> {
    let bridge = std::env::var("SUIPUMP_BRIDGE_URL")
        .unwrap_or_else(|_| "http://localhost:3030".to_string());
    let private_key = std::env::var("SUI_PRIVATE_KEY")
        .map_err(|_| anyhow::anyhow!("SUI_PRIVATE_KEY not set"))?;
    let rpc = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io".to_string());
    let agent_key = std::env::var("AGENT_API_KEY").unwrap_or_default();

    // NOTE: we intentionally do NOT gate the claim on the indexer's stats. The
    // indexer's creator_fees figure can lag the chain (observed: indexer reported
    // 0.204 SUI while the on-chain curve held 0.398 SUI pending), so trusting it
    // to decide "nothing to claim" risks returning Empty on a curve that actually
    // has fees. The bridge reads the real on-chain creator_fees and is the source
    // of truth. We always call it, and decide Ok vs Empty from what it actually
    // claimed.

    let resp = reqwest::Client::new()
        .post(format!("{}/claim", bridge))
        .header("x-agent-key", agent_key)
        .json(&serde_json::json!({
            "curveId": input.curve_id,
            "tokenType": input.token_type,
            "rpcUrl": rpc,
            "privateKey": private_key,
        }))
        .send().await?;

    if !resp.status().is_success() {
        return Ok(ClaimOutput::Err { reason: resp.text().await? });
    }
    let r: serde_json::Value = resp.json().await?;

    // The bridge returns suiClaimed as a STRING (e.g. "1.234500") from .toFixed().
    // serde's .as_f64() returns None for a JSON string, so a bare
    // .as_f64().unwrap_or(0.0) silently zeroed sui_claimed. Mirror sell.rs: try
    // number first, then string-parse, then default 0.0.
    let sui_claimed = r["suiClaimed"]
        .as_f64()
        .or_else(|| r["suiClaimed"].as_str().and_then(|s| s.parse::<f64>().ok()))
        .unwrap_or(0.0);

    // The bridge succeeded. If it actually moved fees, report Ok with the amount;
    // if there were genuinely no fees to claim (bridge claimed 0), report Empty.
    if sui_claimed > 0.0 {
        Ok(ClaimOutput::Ok {
            tx_digest: r["txDigest"].as_str().unwrap_or("").to_string(),
            sui_claimed,
        })
    } else {
        Ok(ClaimOutput::Empty {})
    }
}
