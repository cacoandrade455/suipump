#!/bin/sh
# Enclave entrypoint: start the signer on localhost TCP, then bridge VSOCK
# port 7746 (what the parent instance connects to) into it. Nitro enclaves
# have no network interface; VSOCK is the only channel in or out.
set -e

ENCLAVE_LISTEN=127.0.0.1:7746 /usr/local/bin/enclave &

# Parent -> enclave: VSOCK listener forwarding to the app.
exec socat VSOCK-LISTEN:7746,fork,reuseaddr TCP:127.0.0.1:7746
