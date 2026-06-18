use {
    anyhow::Result as AnyResult,
    nexus_sdk::{fqn, ToolFqn},
    nexus_toolkit::NexusTool,
    schemars::JsonSchema,
    serde::{Deserialize, Serialize},
    warp::http::StatusCode,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct LaunchInput {
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub icon_url: Option<String>,
    /// Dev-buy in SUI. E.g. 5.0
    pub dev_buy_sui: Option<f64>,
    /// "cetus" | "deepbook" | "turbos". Default: "cetus"
    pub graduation_target: Option<String>,
    /// 0 | 15 | 30 seconds. Default: 0
    pub anti_bot_delay: Option<u8>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum LaunchOutput {
    Ok { tx_digest: String, curve_id: String, token_type: String },
    Err { reason: String },
}

pub struct LaunchTool;

impl NexusTool for LaunchTool {
    type Input  = LaunchInput;
    type Output = LaunchOutput;
    async fn new() -> Self { Self }
    fn fqn() -> ToolFqn { fqn!("xyz.suipump.launch@1") }
    fn path() -> &'static str { "launch" }
    fn description() -> &'static str { "Launch a new token on SuiPump. Handles bytecode patching, publishing, and optional dev-buy." }
    async fn health(&self) -> AnyResult<StatusCode> { Ok(StatusCode::OK) }
    async fn invoke(&self, input: LaunchInput) -> LaunchOutput {
        match execute_launch(input).await {
            Ok(o) => o,
            Err(e) => LaunchOutput::Err { reason: e.to_string() },
        }
    }
}

async fn execute_launch(input: LaunchInput) -> AnyResult<LaunchOutput> {
    let bridge = std::env::var("SUIPUMP_BRIDGE_URL")
        .unwrap_or_else(|_| "http://localhost:3030".to_string());
    let private_key = std::env::var("SUI_PRIVATE_KEY")
        .map_err(|_| anyhow::anyhow!("SUI_PRIVATE_KEY not set"))?;
    let rpc = std::env::var("SUI_RPC_URL")
        .unwrap_or_else(|_| "https://fullnode.testnet.sui.io".to_string());
    let agent_key = std::env::var("AGENT_API_KEY").unwrap_or_default();

    let grad_target: u8 = match input.graduation_target.as_deref() {
        Some("deepbook") => 1,
        Some("turbos")   => 2,
        _                => 0,
    };

    let resp = reqwest::Client::new()
        .post(format!("{}/launch", bridge))
        .header("x-agent-key", agent_key)
        .json(&serde_json::json!({
            "name": input.name,
            "symbol": input.symbol,
            "description": input.description,
            "iconUrl": input.icon_url,
            "devBuyMist": input.dev_buy_sui.map(|s| (s * 1e9) as u64).unwrap_or(0),
            "graduationTarget": grad_target,
            "antiBotDelay": input.anti_bot_delay.unwrap_or(0),
            "rpcUrl": rpc,
            "privateKey": private_key,
        }))
        .send().await?;

    if !resp.status().is_success() {
        return Ok(LaunchOutput::Err { reason: resp.text().await? });
    }
    let r: serde_json::Value = resp.json().await?;
    Ok(LaunchOutput::Ok {
        tx_digest:  r["txDigest"].as_str().unwrap_or("").to_string(),
        curve_id:   r["curveId"].as_str().unwrap_or("").to_string(),
        token_type: r["tokenType"].as_str().unwrap_or("").to_string(),
    })
}
