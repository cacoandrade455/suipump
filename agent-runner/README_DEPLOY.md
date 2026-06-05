# agent-runner — deploy guide

A dedicated Render service that executes the real Nexus DAG for the SuiPump
agent UI. Isolated from the bridge and tool servers — if it breaks, nothing
else on the platform is affected.

## What it does
`POST /run-dag` -> shells `nexus dag execute -d <dag> -i <input> --json`
-> returns `{ ok, executionId, digest, checkpoint }`.

## Files
- `build.sh`  — installs the nexus CLI + downloads testnet Nexus objects (BUILD command)
- `start.sh`  — configures nexus from env vars, launches server.js (START command)
- `server.js` — the HTTP endpoint
- `package.json`

## Render setup (new Web Service)

1. New + > Web Service > connect the suipump repo.
2. **Root Directory:** `agent-runner`
3. **Runtime:** Rust (so cargo is available for the CLI build).
   - If only the Node runtime is available, set the Build Command to install Rust first:
     `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y && source "$HOME/.cargo/env" && bash build.sh`
   - Otherwise (Rust runtime): **Build Command:** `bash build.sh`
4. **Start Command:** `bash start.sh`
5. **Environment variables:**
   - `SUI_PRIVATE_KEY` = the Nexus invoker wallet's base64WithFlag private key
     (the SAME wallet that funded the Nexus gas vault and registered the tools —
     wallet `0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906`).
   - `NEXUS_DAG_ID` = `0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b`
   - `SUI_RPC_URL` (optional) = `https://fullnode.testnet.sui.io`
   - `RUN_TIMEOUT_MS` (optional) = `120000`
6. Deploy. First build is slow (compiles the CLI). Subsequent deploys are cached.

## Verify
- `curl https://suipump-agent-runner.onrender.com/health`
  -> `{"ok":true,"ts":...,"dagConfigured":true}`
- Full run:
  `curl -X POST https://suipump-agent-runner.onrender.com/run-dag -H "Content-Type: application/json" -d "{\"launch\":{\"name\":\"AgentDemo\",\"symbol\":\"ADEMO\",\"description\":\"test\"},\"buy\":{\"amount_sui\":0.5}}"`
  -> `{"ok":true,"executionId":"0x...","digest":"...","checkpoint":...}`

## Frontend env (Vercel)
- `VITE_AGENT_RUNNER_URL` = `https://suipump-agent-runner.onrender.com`
- `VITE_NEXUS_DAG_ID` = `0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b`
(Both have safe defaults in AgentPage.jsx, but set them explicitly.)

## Gas
The invoker wallet's Nexus gas vault must stay funded (you funded it earlier to
~11.95 SUI). Top up with `nexus gas add-budget` from your laptop if it runs low.
