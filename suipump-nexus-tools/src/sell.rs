use {
    anyhow::Result as AnyResult,
    nexus_sdk::{fqn, ToolFqn},
    nexus_toolkit::NexusTool,
    schemars::JsonSchema,
    serde::{Deserialize, Serialize},
    warp::http::StatusCode,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct SellInput {
    /// Shared curve object ID, e.g. 0x031a...
    pub curve_id: String,
    /// Tokens to sell, in WHOLE tokens (e.g. 1000.5). Pre-converted to base units here.
    pub token_amount: f64,
    /// Minimum SUI to receive, in MIST (slippage guard). 0 = no guard.
    pub min_sui_out: Option<u64>,
    /// Optional referral address.
    pub referral: Option<String>,
    /// Token decimals (default 6, matching V9 SuiPump curves).
    pub token_decimals: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum SellOutput {
    Ok { tx_digest: String, sui_received: f64 },
    Err { reason: String },
}

pub struct SellTool;

impl NexusTool for SellTool {
    type Input  = SellInput;
    type Output = SellOutput;
    async fn new() -> Self { Self }
    fn fqn() -> ToolFqn { fqn!("xyz.suipump.sell@1") }
    fn path() -> &'static str { "sell" }
    fn description() -> &'static str { "Sell tokens back to SUI on a SuiPump bonding curve." }
    async fn health(&self) -> AnyResult<StatusCode> { Ok(StatusCode::OK) }
    async fn invoke(&self, input: SellInput) -> SellOutput {
        match execute_sell(input).await {
            Ok(o) => o,
            Err(e) => SellOutput::Err { reason: e.to_string() },
        }
    }
}

async fn execute_sell(input: SellInput) -> AnyResult<SellOutput> {
    let bridge = std::env::var("SUIPUMP_BRIDGE_URL")
        .unwrap_or_else(|_| "http://localhost:3030".to_string());
    let private_key = std::env::var("SUI_PRIVATE_KEY")
        .map_err(|_| anyhow::anyhow!("SUI_PRIVATE_KEY not set"))?;
    let rpc = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io".to_string());

    // Mirror buy.rs: pre-multiply to base units and send as u64.
    // Buy sends amount_sui * 1e9 (MIST). Sell sends token_amount * 10^decimals
    // (default 6 = V9 SuiPump base units). u64 marshalling matches buy exactly,
    // avoiding any f64 vs integer type ambiguity in the bridge's JSON parsing
    // that caused sell-through-DAG to silently no-op while buy succeeded.
    let decimals = input.token_decimals.unwrap_or(6) as u32;
    let scale = 10u64.pow(decimals) as f64;
    let token_amount_base: u64 = (input.token_amount * scale) as u64;

    // Field names match bridge.js handleSell exactly:
    //   { curveId, tokenAmount, minSuiOut, referral, rpcUrl, privateKey }
    // The bridge resolves tokenType/pkgId/ISV from the curve itself.
    let resp = reqwest::Client::new()
        .post(format!("{}/sell", bridge))
        .json(&serde_json::json!({
            "curveId":     input.curve_id,
            "tokenAmount": token_amount_base,
            "minSuiOut":   input.min_sui_out.unwrap_or(0),
            "referral":    input.referral,
            "rpcUrl":      rpc,
            "privateKey":  private_key,
        }))
        .send().await?;

    if !resp.status().is_success() {
        return Ok(SellOutput::Err { reason: resp.text().await? });
    }

    let r: serde_json::Value = resp.json().await?;

    // bridge returns suiReceived as a STRING (e.g. "1.234500") or "unknown"
    let sui_received = r["suiReceived"]
        .as_f64()
        .or_else(|| r["suiReceived"].as_str().and_then(|s| s.parse::<f64>().ok()))
        .unwrap_or(0.0);

    Ok(SellOutput::Ok {
        tx_digest: r["txDigest"].as_str().unwrap_or("").to_string(),
        sui_received,
    })
}
