# suipump-session-enclave -- Nitro enclave image (Nautilus Phase 2).
#
# REPRODUCIBILITY IS THE SECURITY MODEL: the EIF built from this image yields
# PCR0/1/2, and those exact measurements get pinned on-chain in the
# EnclaveRegistry. Anyone must be able to rebuild this image and arrive at the
# same PCRs, which is why the base images are pinned by DIGEST and deps are
# locked. Changing ANYTHING here (even a comment) changes the PCRs.
#
# Build (on the EC2 parent instance):
#   docker build -t suipump-enclave .
#   nitro-cli build-enclave --docker-uri suipump-enclave:latest \
#     --output-file suipump-enclave.eif
#   -> prints PCR0, PCR1, PCR2  (save these: they go on-chain)

# ---- build stage ----
FROM rust:1.83-slim-bookworm@sha256:540c902e99c384163b688bbd8b5b8520e94e7731b27f7bd0eaa56ae1960627ab AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock* ./
COPY src ./src
# nsm feature = real attestation via /dev/nsm (only exists inside an enclave)
RUN cargo build --release --features nsm

# ---- runtime stage ----
FROM debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df
# iproute2: enclaves boot with loopback DOWN; entrypoint must `ip link set lo up`
RUN apt-get update && apt-get install -y --no-install-recommends socat iproute2 \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/suipump-session-enclave /usr/local/bin/enclave
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Enclaves have no NIC: entrypoint bridges VSOCK (from the parent) to the
# app's local TCP listener.
CMD ["/usr/local/bin/entrypoint.sh"]
