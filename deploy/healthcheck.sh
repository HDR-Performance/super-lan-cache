#!/bin/bash
set -e
curl --fail --silent http://127.0.0.1/lancache-heartbeat > /dev/null
curl --fail --silent http://127.0.0.1:20722/healthz > /dev/null
