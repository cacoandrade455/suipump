use {
    anyhow::Result as AnyResult,
    nexus_sdk::{fqn, ToolFqn},
    nexus_toolkit::NexusTool,
    schemars::JsonSchema,
    serde::{Deserialize, Serialize},
    warp::http::StatusCode,
};

#[derive(Debug, Deserialize, JsonSchema)]
pub struct AlertsInput {
    /// List of curve IDs to monitor. Max 10.
    pub curve_ids: Vec<String>,
    /// SUI reserve threshold for graduation warning. Default: 8000.
    pub graduation_warning_sui: Option<f64>,
    /// Creator fees threshold in SUI to trigger claim alert. Default: 1.0.
    pub claim_threshold_sui: Option<f64>,
    /// Price change % to trigger price alert. Default: 20.0.
    pub price_change_pct: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub struct CurveAlert {
    pub curve_id: String,
    pub token_name: String,
    pub alert_type: String,
    pub message: String,
    pub sui_reserve: f64,
    pub graduation_threshold: f64,
    pub creator_fees_pending: f64,
    pub graduated: bool,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
pub enum AlertsOutput {
    Ok { alerts: Vec<CurveAlert>, curves_checked: u64, checked_at_ms: u64 },
    Empty,
    Err { reason: String },
}

pub struct AlertsTool;

impl NexusTool for AlertsTool {
    type Input  = AlertsInput;
    type Output = AlertsOutput;
    async fn new() -> Self { Self }
    fn fqn() -> ToolFqn { fqn!("xyz.suipump.alerts@1") }
    fn path() -> &'static str { "alerts" }
    fn description() -> &'static str { "Monitor SuiPump curves and return status alerts: graduation warnings, claim reminders, and price movement alerts." }
    async fn health(&self) -> AnyResult<StatusCode> { Ok(StatusCode::OK) }
    async fn invoke(&self, input: AlertsInput) -> AlertsOutput {
        match execute_alerts(input).await {
            Ok(o) => o,
            Err(e) => AlertsOutput::Err { reason: e.to_string() },
        }
    }
}

async fn execute_alerts(input: AlertsInput) -> AnyResult<AlertsOutput> {
    if input.curve_ids.is_empty() {
        return Ok(AlertsOutput::Empty);
    }

    let indexer = std::env::var("SUIPUMP_INDEXER_URL")
        .unwrap_or_else(|_| "https://suipump-62s2.onrender.com".to_string());

    let grad_warning = input.graduation_warning_sui.unwrap_or(8000.0);
    let claim_thresh = input.claim_threshold_sui.unwrap_or(1.0);
    let price_pct    = input.price_change_pct.unwrap_or(20.0);

    let client = reqwest::Client::new();
    let mut alerts: Vec<CurveAlert> = Vec::new();
    let curve_ids: Vec<String> = input.curve_ids.into_iter().take(10).collect();

    for curve_id in &curve_ids {
        let stats: serde_json::Value = match client
            .get(format!("{}/token/{}/stats", indexer, curve_id))
            .send().await
        {
            Ok(r) => r.json().await.unwrap_or_default(),
            Err(_) => {
                alerts.push(CurveAlert {
                    curve_id: curve_id.clone(),
                    token_name: "Unknown".to_string(),
                    alert_type: "error".to_string(),
                    message: format!("Failed to fetch stats for {}…", &curve_id[..12.min(curve_id.len())]),
                    sui_reserve: 0.0, graduation_threshold: 9000.0,
                    creator_fees_pending: 0.0, graduated: false,
                });
                continue;
            }
        };

        let meta: serde_json::Value = match client
            .get(format!("{}/token/{}", indexer, curve_id))
            .send().await
        {
            Ok(r) => r.json().await.unwrap_or_default(),
            Err(_) => serde_json::Value::default(),
        };

        let token_name = format!(
            "{} ({})",
            meta["name"].as_str().unwrap_or("Unknown"),
            meta["symbol"].as_str().unwrap_or("?")
        );

        let sui_reserve      = stats["suiReserve"].as_f64().or_else(|| stats["sui_reserve"].as_f64()).unwrap_or(0.0);
        let creator_fees     = stats["creatorFeesPending"].as_f64().or_else(|| stats["creator_fees_pending"].as_f64()).unwrap_or(0.0);
        let graduated        = stats["graduated"].as_bool().unwrap_or(false);
        let last_price       = stats["lastPrice"].as_f64().or_else(|| stats["last_price"].as_f64()).unwrap_or(0.0);
        let first_price      = stats["firstPrice"].as_f64().or_else(|| stats["first_price"].as_f64()).unwrap_or(0.0);

        let (alert_type, message) = if graduated {
            ("graduated".to_string(), format!("{} has graduated! Check your LP position on the DEX.", token_name))
        } else if sui_reserve >= 9000.0 {
            ("graduation_ready".to_string(), format!("{} hit 9,000 SUI — graduation processing.", token_name))
        } else if sui_reserve >= grad_warning {
            ("graduation_warning".to_string(), format!("{} is {:.0} SUI from graduation ({:.0}/9000).", token_name, 9000.0 - sui_reserve, sui_reserve))
        } else if creator_fees >= claim_thresh {
            ("claim_ready".to_string(), format!("{} has {:.4} SUI in creator fees ready to claim.", token_name, creator_fees))
        } else if first_price > 0.0 && last_price > 0.0 {
            let pct = ((last_price - first_price) / first_price) * 100.0;
            if pct.abs() >= price_pct {
                let dir = if pct > 0.0 { "up" } else { "down" };
                ("price_movement".to_string(), format!("{} is {} {:.1}% — {:.0} SUI reserve.", token_name, dir, pct.abs(), sui_reserve))
            } else {
                ("ok".to_string(), format!("{} stable — {:.0} SUI reserve.", token_name, sui_reserve))
            }
        } else {
            ("ok".to_string(), format!("{} active — {:.0} SUI reserve.", token_name, sui_reserve))
        };

        alerts.push(CurveAlert { curve_id: curve_id.clone(), token_name, alert_type, message, sui_reserve, graduation_threshold: 9000.0, creator_fees_pending: creator_fees, graduated });
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

    Ok(AlertsOutput::Ok { curves_checked: curve_ids.len() as u64, alerts, checked_at_ms: now })
}
