use {
    anyhow::Result as AnyResult,
    nexus_sdk::{fqn, ToolFqn},
    nexus_toolkit::NexusTool,
    schemars::JsonSchema,
    serde::{Deserialize, Serialize},
    warp::http::StatusCode,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct BuyInput {
    /// The SuiPump curve object ID to buy from.
    pub curve_id: String,
    /// Amount of SUI to spend. E.g. 1.5 = 1.5 SUI.
    pub amount_sui: f64,
    /// Slippage tolerance in basis points. Default: 200 (2%).
    pub slippage_bps: Option<u64>,
    /// Optional referrer wallet address.
    pub referrer: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum BuyOutput {
    Ok { tx_digest: String, tokens_received: f64, sui_spent: f64 },
    Err { reason: String },
}

pub struct BuyTool;

impl NexusTool for BuyTool {
    type Input  = BuyInput;
    type Output = BuyOutput;
    async fn new() -> Self { Self }
    fn fqn() -> ToolFqn { fqn!("xyz.suipump.buy@1") }
    fn path() -> &'static str { "buy" }
    fn description() -> &'static str { "Buy tokens on a SuiPump bonding curve." }
    async fn health(&self) -> AnyResult<StatusCode> { Ok(StatusCode::OK) }
    async fn invoke(&self, input: BuyInput) -> BuyOutput {
        match execute_buy(input).await {
            Ok(o) => o,
            Err(e) => BuyOutput::Err { reason: e.to_string() },
        }
    }
}

async fn execute_buy(input: BuyInput) -> AnyResult<BuyOutput> {
    let bridge = std::env::var("SUIPUMP_BRIDGE_URL")
        .unwrap_or_else(|_| "http://localhost:3030".to_string());
    let private_key = std::env::var("SUI_PRIVATE_KEY")
        .map_err(|_| anyhow::anyhow!("SUI_PRIVATE_KEY not set"))?;
    let rpc = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io".to_string());

    let resp = reqwest::Client::new()
        .post(format!("{}/buy", bridge))
        .json(&serde_json::json!({
            "curveId": input.curve_id,
            "amountMist": (input.amount_sui * 1e9) as u64,
            "slippageBps": input.slippage_bps.unwrap_or(200),
            "referrer": input.referrer,
            "rpcUrl": rpc,
            "privateKey": private_key,
        }))
        .send().await?;

    if !resp.status().is_success() {
        return Ok(BuyOutput::Err { reason: resp.text().await? });
    }
    let r: serde_json::Value = resp.json().await?;
    Ok(BuyOutput::Ok {
        tx_digest: r["txDigest"].as_str().unwrap_or("").to_string(),
        tokens_received: r["tokensReceived"].as_f64().unwrap_or(0.0),
        sui_spent: r["suiSpent"].as_f64().unwrap_or(input.amount_sui),
    })
}
