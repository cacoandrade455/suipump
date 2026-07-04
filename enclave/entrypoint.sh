#!/bin/sh
# Enclave entrypoint: start the signer on localhost TCP, then bridge VSOCK
# connections from the parent to it. Nitro enclaves have no network
# interface; VSOCK is the only channel in or out.
#
# CRITICAL: Nitro enclaves boot with the loopback interface DOWN and there is
# no init system to raise it. An app can BIND 127.0.0.1 on a down interface,
# but CONNECTIONS to it fail -- the symptom is vsock connects from the parent
# that close instantly with EOF while the app logs that it is listening.
ip link set lo up

# Signer in the background (listens on loopback only).
ENCLAVE_LISTEN=127.0.0.1:7746 /usr/local/bin/enclave &

# Parent -> enclave: VSOCK listener forwarding to the app.
exec socat VSOCK-LISTEN:7746,fork,reuseaddr TCP:127.0.0.1:7746
