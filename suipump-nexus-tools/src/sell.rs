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
    pub curve_id: String,
    pub token_type: String,
    /// Amount of tokens to sell (human-readable). E.g. 1000.5
    pub amount_tokens: f64,
    pub slippage_bps: Option<u64>,
    pub referrer: Option<String>,
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
    fn description() -> &'static str { "Sell tokens on a SuiPump bonding curve." }
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

    let resp = reqwest::Client::new()
        .post(format!("{}/sell", bridge))
        .json(&serde_json::json!({
            "curveId": input.curve_id,
            "tokenType": input.token_type,
            "amountBase": (input.amount_tokens * 1e6) as u64,
            "slippageBps": input.slippage_bps.unwrap_or(200),
            "referrer": input.referrer,
            "rpcUrl": rpc,
            "privateKey": private_key,
        }))
        .send().await?;

    if !resp.status().is_success() {
        return Ok(SellOutput::Err { reason: resp.text().await? });
    }
    let r: serde_json::Value = resp.json().await?;
    Ok(SellOutput::Ok {
        tx_digest: r["txDigest"].as_str().unwrap_or("").to_string(),
        sui_received: r["suiReceived"].as_f64().unwrap_or(0.0),
    })
}
