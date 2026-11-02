#!/bin/bash
# One request to a crosstalk daemon: test/canary/rpc.sh <crosstalk-home> '<json>'
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT" && CROSSTALK_HOME="$1" bun -e '
  const { request } = await import("./src/client.ts")
  console.log(JSON.stringify(await request(JSON.parse(process.argv[1]), 20000)))
' "$2"
